import Foundation

// Codex 를 네이티브 챗 패널로 몬다 - TUI 없이, [[ClaudeChatSession]] 과 같은 자리에서.
//
// 붙는 곳은 `codex app-server`: Codex 자신의 TUI 가 쓰는 JSON-RPC 이다. 처음엔
// `codex exec --json` 이 간단해 보였지만 그건 비대화형이라 **승인을 물어볼 수 없다** -
// riven 챗의 승인 카드가 통째로 사라진다. app-server 는 승인을 서버→클라이언트 요청으로
// 보내 주므로, 카드가 그대로 산다.
//
// 2026-08-06 codex-cli 0.146.1 에서 직접 주고받아 확인한 것:
//   → initialize {clientInfo}                       ← result {userAgent, codexHome}
//   → initialized (알림)
//   → thread/start {cwd}                            ← result {thread:{id,…}} + thread/started
//   → turn/start {threadId, input:[{type:"text",…}]}  ← result {turn:{id}}
//   ← item/started · item/agentMessage/delta · item/completed
//   ← thread/tokenUsage/updated · account/rateLimits/updated
//   ← thread/status/changed {active|idle} · turn/completed
//   ← commandExecution/requestApproval · fileChange/requestApproval (서버→클라 요청)
//
// 함정 하나: turn/start 의 `input` 은 배열이다. 맵으로 주면
// "invalid type: map, expected a sequence" 로 조용히 턴이 시작되지 않는다.
final class CodexChatSession: AgentChatSession {
    private let proc = Process()
    private let inPipe = Pipe()
    private let outPipe = Pipe()
    private var buffer = Data()
    private let queue = DispatchQueue(label: "com.riven.chat.codex")

    // 콜백은 전부 메인 스레드로 전달한다 (ClaudeChatSession 과 같은 약속).
    var onInit: ((_ threadId: String, _ model: String?) -> Void)?
    var onTextDelta: ((String) -> Void)?
    var onMainTool: ((_ name: String, _ detail: String, _ code: String?, _ path: String?) -> Void)?
    var onFileEdited: ((_ path: String) -> Void)?
    var onTurnDone: ((_ costUSD: Double?, _ sessionId: String?, _ usage: ChatUsage?, _ error: String?) -> Void)?
    var onExit: ((_ code: Int32) -> Void)?
    /// 승인 대기. respond(id:allow:) 로 답한다.
    var onPermissionRequest: ((_ id: String, _ name: String, _ detail: String, _ code: String?, _ path: String?) -> Void)?

    private(set) var threadId: String?
    private(set) var model: String?
    /// [[AgentChatSession]] 이 부르는 이름. Codex 에서는 thread id 가 그 자리다.
    var sessionId: String? { threadId }
    /// Codex 는 도구 목록을 init 에서 주지 않는다 - 상태 줄은 비워 둔다.
    var toolList: [String] { [] }
    var mcpServers: [(name: String, status: String)] { mcpStatus }
    private var mcpStatus: [(name: String, status: String)] = []
    /// 아직 답하지 않은 승인 요청: riven 이 만든 id → (JSON-RPC 요청 id, 어떤 종류인지).
    private var pendingApprovals: [String: (rpcId: Any, kind: String, params: [String: Any])] = [:]
    private var nextId = 0
    private let cwd: String
    private let resumeThread: String?
    private var started = false

    // riven 의 승인 모드를 Codex 의 (승인 정책, 샌드박스) 짝으로 옮긴 것.
    //
    // 처음엔 "Codex 에는 모드가 없다" 고 보고 드롭다운을 감췄는데 틀렸다. Codex 도
    // approvalPolicy(untrusted/on-request/never)와 sandbox(read-only/workspace-write)를
    // 가지고, 둘 다 턴마다 덮어쓸 수 있다 - Claude 의 set_permission_mode 와 같은 자리다.
    //
    // danger-full-access 로는 절대 올라가지 않는다. "자동" 은 승인을 묻지 않겠다는 뜻이지
    // 워크스페이스 밖을 마음대로 쓰겠다는 뜻이 아니다.
    private var approvalPolicy = "on-request"
    private var sandboxMode = "workspace-write"
    private func applyMode(_ mode: String) {
        switch mode {
        case "plan":                                  // 계획: 읽기만, 실행은 전부 물어본다
            approvalPolicy = "untrusted"; sandboxMode = "read-only"
        case "auto":                                  // 자동: 묻지 않되 워크스페이스 안에서만
            approvalPolicy = "never"; sandboxMode = "workspace-write"
        default:                                      // 승인 요청
            approvalPolicy = "on-request"; sandboxMode = "workspace-write"
        }
    }
    /// turn/start 의 sandboxPolicy 는 문자열이 아니라 객체다 (thread/start 의 sandbox 와 다름).
    private var sandboxPolicyObject: [String: Any] {
        switch sandboxMode {
        case "read-only": return ["type": "readOnly"]
        case "danger-full-access": return ["type": "dangerFullAccess"]
        default: return ["type": "workspaceWrite"]
        }
    }

    init?(command: String, cwd: String, resume: String? = nil, model: String? = nil,
          permissionMode: String = "default") {
        self.cwd = cwd
        self.resumeThread = resume
        self.model = model
        applyMode(permissionMode)
        proc.executableURL = URL(fileURLWithPath: command)
        proc.arguments = ["app-server"]
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice
        // 기본 환경 그대로 - Codex 도 구독 로그인(~/.codex/auth.json)을 쓴다.
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            // EOF 에서 핸들러를 반드시 떼어낸다. 안 그러면 죽은 프로세스의 fd 가 계속 신호를
            // 보내 워커 스레드 하나가 100% 로 돈다 (ClaudeChatSession 이 겪은 그 버그).
            if d.isEmpty { h.readabilityHandler = nil; return }
            self?.queue.async { self?.feed(d) }
        }
        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async { self?.onExit?(p.terminationStatus) }
        }
        do { try proc.run() } catch { return nil }
        handshake()
    }

    var isAlive: Bool { proc.isRunning }

    // ---- 보내는 쪽 --------------------------------------------------------

    private func handshake() {
        request("initialize", ["clientInfo": ["name": "riven", "title": "riven",
                                              "version": appVersion]]) { [weak self] _, _ in
            guard let self else { return }
            self.notify("initialized", [:])
            if let resume = self.resumeThread {
                // 지난 대화로 돌아간다. 실패하면(지워진 스레드 등) 새로 연다 -
                // 이어붙일 게 없다고 페인이 죽어 있는 것보다 낫다.
                self.request("thread/resume", ["threadId": resume]) { [weak self] result, err in
                    if err != nil { self?.startThread() } else { self?.adoptThread(result) }
                }
            } else {
                self.startThread()
            }
        }
    }

    private func startThread() {
        var params: [String: Any] = ["cwd": cwd,
                                     "approvalPolicy": approvalPolicy,
                                     "sandbox": sandboxMode]
        if let m = model, !m.isEmpty, m != "default" { params["model"] = m }
        request("thread/start", params) { [weak self] result, _ in self?.adoptThread(result) }
    }

    private func adoptThread(_ result: [String: Any]?) {
        guard let thread = result?["thread"] as? [String: Any],
              let id = thread["id"] as? String else { return }
        threadId = id
        started = true
        // 모델 이름은 thread 객체가 아니라 응답 어딘가에 실려 온다 (thread 키에는 없고
        // modelProvider 만 있다). 전체를 훑어서 집는다 - 못 집으면 /status 가 "?" 로 남는다.
        if let result { noteModel(result) }
        DispatchQueue.main.async { [weak self] in self?.onInit?(id, self?.model) }
        flushQueued()
    }

    /// 스레드가 열리기 전에 사용자가 친 것들. 버리면 첫 메시지가 사라진다.
    private var queued: [String] = []
    private func flushQueued() {
        let pending = queued; queued = []
        pending.forEach { send($0) }
    }

    func send(_ text: String) {
        guard let tid = threadId, started else { queued.append(text); return }
        // 승인 정책·샌드박스를 턴마다 실어 보낸다. 그래야 도는 도중에 모드를 바꿔도
        // 다음 턴부터 바로 먹는다 (Claude 의 라이브 모드 전환과 같은 체감).
        request("turn/start", ["threadId": tid,
                               // 배열이어야 한다 - 맵이면 턴이 시작조차 되지 않는다.
                               "input": [["type": "text", "text": text]],
                               "approvalPolicy": approvalPolicy,
                               "sandboxPolicy": sandboxPolicyObject]) { _, _ in }
    }

    func interrupt() {
        guard let tid = threadId else { return }
        request("turn/interrupt", ["threadId": tid]) { _, _ in }
    }

    /// 승인 카드의 답. Codex 는 종류마다 응답 모양이 달라서 여기서 갈라 준다.
    func respond(_ id: String, allow: Bool) {
        guard let p = pendingApprovals.removeValue(forKey: id) else { return }
        if p.kind == "permissions/requestApproval" {
            // 허용은 "요청한 프로파일을 그대로 돌려주기", 거절은 빈 프로파일이다.
            // 범위는 turn - 한 번 허용했다고 세션 내내 열어 두지 않는다.
            let granted = allow ? (p.params["permissions"] as? [String: Any] ?? [:]) : [:]
            respondRPC(p.rpcId, ["permissions": granted, "scope": "turn"])
            return
        }
        respondRPC(p.rpcId, ["decision": allow ? "accept" : "decline"])
    }

    /// 요청된 권한을 한 줄로. 카드에 "무엇을 열어 달라는지" 가 보여야 판단할 수 있다.
    private func permissionSummary(_ want: [String: Any]) -> String {
        var parts: [String] = []
        if let fs = want["fileSystem"] as? [String: Any],
           let entries = fs["entries"] as? [[String: Any]] {
            for e in entries.prefix(3) {
                let access = e["access"] as? String ?? "?"
                let path = (e["path"] as? [String: Any])?["path"] as? String ?? "?"
                parts.append("\(path) (\(access))")
            }
            if entries.count > 3 { parts.append("+\(entries.count - 3)") }
        }
        if let net = want["network"] as? [String: Any], net["enabled"] as? Bool == true {
            parts.append(t("chat.codex.network"))
        }
        return parts.isEmpty ? t("chat.codex.permissions") : parts.joined(separator: ", ")
    }
    private func firstPath(_ want: [String: Any]) -> String? {
        guard let fs = want["fileSystem"] as? [String: Any],
              let entries = fs["entries"] as? [[String: Any]] else { return nil }
        return (entries.first?["path"] as? [String: Any])?["path"] as? String
    }

    func stop() {
        guard proc.isRunning else { return }
        proc.terminate()
    }

    /// 모델 바꾸기는 다음 스레드부터 적용된다 - app-server 에는 진행 중 스레드의 모델을
    /// 갈아 끼우는 요청이 없다 (Claude 의 set_model 컨트롤 메시지와 다르다).
    func setModel(_ model: String) { self.model = model }
    /// 다음 턴부터 적용된다 (turn/start 가 정책을 함께 싣는다).
    func setPermissionMode(_ mode: String) { applyMode(mode) }
    /// riven MCP 도구는 아직 Codex 쪽에 연결하지 않았다.
    @discardableResult func respondTool(_ id: String, _ result: String) -> Bool { false }

    // Claude 에만 있는 신호들 - 프로토콜을 만족시키되 아무도 부르지 않는다.
    var onSubagentStart: ((String, String, String) -> Void)?
    var onSubagentText: ((String, String) -> Void)?
    var onSubagentTool: ((String, String, String, String?, String?) -> Void)?
    var onSubagentToolResult: ((String, String, Bool) -> Void)?
    var onSubagentDone: ((String, String) -> Void)?
    var onToolRequest: ((String, String, [String: Any]) -> Void)?
    var onAskExpired: ((String, String) -> Void)?

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.1"
    }

    // ---- JSON-RPC 배관 -----------------------------------------------------

    private var pending: [Int: ([String: Any]?, [String: Any]?) -> Void] = [:]

    private func request(_ method: String, _ params: [String: Any],
                         _ done: @escaping ([String: Any]?, [String: Any]?) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            self.nextId += 1
            let id = self.nextId
            self.pending[id] = done
            self.writeLine(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        }
    }
    private func notify(_ method: String, _ params: [String: Any]) {
        queue.async { [weak self] in
            self?.writeLine(["jsonrpc": "2.0", "method": method, "params": params])
        }
    }
    private func respondRPC(_ id: Any, _ result: [String: Any]) {
        queue.async { [weak self] in
            self?.writeLine(["jsonrpc": "2.0", "id": id, "result": result])
        }
    }

    private func writeLine(_ obj: [String: Any]) {
        guard proc.isRunning, let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var line = body; line.append(0x0a)
        // 던지는 write 를 쓰고 오류는 삼킨다 - 프로세스가 죽은 뒤 쓰면 예전 API 는
        // NSException("Broken pipe") 으로 앱을 통째로 내렸다.
        do { try inPipe.fileHandleForWriting.write(contentsOf: line) } catch {}
    }

    private func feed(_ d: Data) {
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 0x0a) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            guard !line.isEmpty,
                  let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
            handle(obj)
        }
    }

    private func handle(_ obj: [String: Any]) {
        // 우리가 보낸 요청의 응답
        if let id = obj["id"] as? Int, obj["method"] == nil {
            let done = pending.removeValue(forKey: id)
            done?(obj["result"] as? [String: Any], obj["error"] as? [String: Any])
            return
        }
        guard let method = obj["method"] as? String else { return }
        let params = obj["params"] as? [String: Any] ?? [:]
        // 서버가 우리에게 보내는 요청 (승인). id 가 있으면 반드시 답해야 턴이 계속된다.
        if let rpcId = obj["id"] {
            handleServerRequest(method, params, rpcId: rpcId)
            return
        }
        handleNotification(method, params)
    }

    private func handleServerRequest(_ method: String, _ params: [String: Any], rpcId: Any) {
        let key = UUID().uuidString
        // 실제 메서드에는 `item/` 접두사가 붙어 온다 (item/commandExecution/requestApproval).
        // 접두사 없는 이름으로 매칭했다가 전부 default 로 빠졌고, default 는 빈 응답 -
        // 즉 거절이었다. 사용자에겐 묻지도 않고 거부된 것처럼 보였다. 접미사로 맞춘다.
        switch method.hasPrefix("item/") ? String(method.dropFirst(5)) : method {
        case "commandExecution/requestApproval":
            let cmd = commandText(params)
            pendingApprovals[key] = (rpcId, method, params)
            let reason = params["reason"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.onPermissionRequest?(key, "Bash", reason.isEmpty ? cmd : reason, cmd, nil)
            }
        case "fileChange/requestApproval":
            pendingApprovals[key] = (rpcId, method, params)
            let root = params["grantRoot"] as? String
            let reason = params["reason"] as? String ?? t("chat.codex.fileChange")
            DispatchQueue.main.async { [weak self] in
                self?.onPermissionRequest?(key, "Edit", reason, nil, root)
            }
        case "permissions/requestApproval":
            // 샌드박스 밖으로 나가려 할 때 온다 - 워크스페이스 밖 파일을 쓰거나 네트워크를
            // 열 때. 처음엔 "카드로 못 그리니 거절" 로 두었는데, 그게 가장 흔한 승인이었다:
            // 사용자에겐 묻지도 않고 거부된 것처럼 보였다.
            pendingApprovals[key] = (rpcId, method, params)
            let want = params["permissions"] as? [String: Any] ?? [:]
            let reason = params["reason"] as? String
            let detail = reason ?? permissionSummary(want)
            let path = firstPath(want)
            DispatchQueue.main.async { [weak self] in
                self?.onPermissionRequest?(key, "Permissions", detail, nil, path)
            }
        default:
            // 모르는 요청도 반드시 답한다. 침묵은 곧 멈춘 턴이다.
            respondRPC(rpcId, [:])
        }
    }

    private func handleNotification(_ method: String, _ params: [String: Any]) {
        // 모델 이름은 thread 객체에 없다 (modelProvider 만 있다) - 턴·설정 알림에 실려
        // 지나간다. 처음 보이는 것을 집어 두지 않으면 /status 가 "모델: ?" 로 남는다.
        noteModel(params)
        switch method {
        case "item/agentMessage/delta":
            if let itemId = params["itemId"] as? String, let delta = params["delta"] as? String, !delta.isEmpty {
                emitted[itemId, default: ""] += delta
                DispatchQueue.main.async { [weak self] in self?.onTextDelta?(delta) }
            }
        case "item/started", "item/completed":
            if let item = params["item"] as? [String: Any] { handleItem(item, completed: method.hasSuffix("completed")) }
        case "turn/completed":
            let usage = tokenUsage
            tokenUsage = nil
            DispatchQueue.main.async { [weak self] in
                self?.onTurnDone?(nil, self?.threadId, usage, nil)
            }
        case "turn/failed", "thread/error":
            let msg = (params["error"] as? [String: Any])?["message"] as? String
            DispatchQueue.main.async { [weak self] in
                self?.onTurnDone?(nil, self?.threadId, nil, msg ?? t("chat.codex.turnFailed"))
            }
        case "mcpServer/startupStatus/updated":
            if let name = params["name"] as? String, let st = params["status"] as? String {
                mcpStatus.removeAll { $0.name == name }
                mcpStatus.append((name: name, status: st))
            }
        case "thread/tokenUsage/updated":
            if let tu = (params["tokenUsage"] as? [String: Any])?["total"] as? [String: Any] {
                tokenUsage = ChatUsage(input: tu["inputTokens"] as? Int ?? 0,
                                       output: tu["outputTokens"] as? Int ?? 0,
                                       cacheWrite: tu["cacheWriteInputTokens"] as? Int ?? 0,
                                       cacheRead: tu["cachedInputTokens"] as? Int ?? 0)
            }
        default: break
        }
    }
    /// 알림 어디에 실려 있든 모델 이름을 한 번 집는다 (중첩된 turn / threadSettings 포함).
    private func noteModel(_ params: [String: Any]) {
        guard model == nil || model?.isEmpty == true else { return }
        // 깊이 3까지 본다 - thread/start 응답은 result.thread 아래 한 겹 더 들어간다.
        func find(_ d: [String: Any], depth: Int) -> String? {
            if let m = d["model"] as? String, !m.isEmpty, m != "default" { return m }
            guard depth > 0 else { return nil }
            for v in d.values {
                if let sub = v as? [String: Any], let m = find(sub, depth: depth - 1) { return m }
            }
            return nil
        }
        guard let m = find(params, depth: 3) else { return }
        model = m
        DispatchQueue.main.async { [weak self] in
            guard let self, let id = self.threadId else { return }
            self.onInit?(id, m)          // 챗이 모델 칸을 채울 수 있게 다시 알린다
        }
    }

    private var tokenUsage: ChatUsage?
    /// 메시지 항목별로 델타를 통해 이미 흘려보낸 글자 (완성본이 왔을 때 중복을 막는다).
    private var emitted: [String: String] = [:]

    /// 도구 하나가 시작/끝났다 → 챗의 도구 줄로.
    private func handleItem(_ item: [String: Any], completed: Bool) {
        guard let type = item["type"] as? String else { return }
        switch type {
        case "agentMessage":
            // 델타 없이 완성본만 오는 턴이 있다 (도구를 쓴 뒤의 짧은 마무리 말이 그랬다).
            // 델타만 보고 있으면 그런 답은 통째로 사라진다 - 실제로 파일은 만들어졌는데
            // 챗에는 아무 말도 남지 않았다. 이미 흘려보낸 만큼을 빼고 나머지를 채운다.
            guard completed, let id = item["id"] as? String, let text = item["text"] as? String else { return }
            let already = emitted[id] ?? ""
            emitted[id] = nil
            guard text.count > already.count else { return }
            let rest = String(text.dropFirst(already.count))
            DispatchQueue.main.async { [weak self] in self?.onTextDelta?(rest) }
        case "commandExecution":
            guard !completed else { return }        // 시작할 때 한 번만 줄을 만든다
            let cmd = (item["command"] as? String) ?? (item["parsedCmd"] as? String) ?? ""
            DispatchQueue.main.async { [weak self] in self?.onMainTool?("Bash", cmd, cmd, nil) }
        case "fileChange":
            let changes = item["changes"] as? [[String: Any]] ?? []
            let paths = changes.compactMap { $0["path"] as? String }
            if !completed {
                let detail = paths.first.map { ($0 as NSString).lastPathComponent } ?? ""
                DispatchQueue.main.async { [weak self] in self?.onMainTool?("Edit", detail, nil, paths.first) }
            } else {
                // 바뀐 파일은 변경사항 패널로 (Claude 쪽 PostToolUse 와 같은 신호).
                DispatchQueue.main.async { [weak self] in paths.forEach { self?.onFileEdited?($0) } }
            }
        case "mcpToolCall":
            guard !completed else { return }
            let name = (item["server"] as? String).map { "\($0)/\(item["name"] as? String ?? "")" }
                ?? (item["name"] as? String ?? "MCP")
            DispatchQueue.main.async { [weak self] in self?.onMainTool?(name, "", nil, nil) }
        case "webSearch":
            guard !completed else { return }
            let q = item["query"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in self?.onMainTool?("WebSearch", q, nil, nil) }
        default: break
        }
    }

    private func commandText(_ params: [String: Any]) -> String {
        if let c = params["command"] as? String { return c }
        if let arr = params["command"] as? [String] { return arr.joined(separator: " ") }
        return ""
    }
}
