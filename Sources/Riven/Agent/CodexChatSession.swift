import Foundation

// Codex 를 네이티브 챗 패널로 몬다 — TUI 없이, [[ClaudeChatSession]] 과 같은 자리에서.
//
// 붙는 곳은 `codex app-server`: Codex 자신의 TUI 가 쓰는 JSON-RPC 이다. 처음엔
// `codex exec --json` 이 간단해 보였지만 그건 비대화형이라 **승인을 물어볼 수 없다** —
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
final class CodexChatSession {
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
    /// 아직 답하지 않은 승인 요청: riven 이 만든 id → (JSON-RPC 요청 id, 어떤 종류인지).
    private var pendingApprovals: [String: (rpcId: Any, kind: String)] = [:]
    private var nextId = 0
    private let cwd: String
    private let resumeThread: String?
    private var started = false

    init?(command: String, cwd: String, resume: String? = nil, model: String? = nil) {
        self.cwd = cwd
        self.resumeThread = resume
        self.model = model
        proc.executableURL = URL(fileURLWithPath: command)
        proc.arguments = ["app-server"]
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice
        // 기본 환경 그대로 — Codex 도 구독 로그인(~/.codex/auth.json)을 쓴다.
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
                // 지난 대화로 돌아간다. 실패하면(지워진 스레드 등) 새로 연다 —
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
        var params: [String: Any] = ["cwd": cwd]
        if let m = model, !m.isEmpty, m != "default" { params["model"] = m }
        request("thread/start", params) { [weak self] result, _ in self?.adoptThread(result) }
    }

    private func adoptThread(_ result: [String: Any]?) {
        guard let thread = result?["thread"] as? [String: Any],
              let id = thread["id"] as? String else { return }
        threadId = id
        started = true
        let m = thread["model"] as? String ?? model
        DispatchQueue.main.async { [weak self] in self?.onInit?(id, m) }
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
        request("turn/start", ["threadId": tid,
                               // 배열이어야 한다 — 맵이면 턴이 시작조차 되지 않는다.
                               "input": [["type": "text", "text": text]]]) { _, _ in }
    }

    func interrupt() {
        guard let tid = threadId else { return }
        request("turn/interrupt", ["threadId": tid]) { _, _ in }
    }

    /// 승인 카드의 답. Codex 는 종류마다 응답 모양이 달라서 여기서 갈라 준다.
    func respond(_ id: String, allow: Bool) {
        guard let p = pendingApprovals.removeValue(forKey: id) else { return }
        let decision = allow ? "accept" : "decline"
        respondRPC(p.rpcId, ["decision": decision])
    }

    func stop() {
        guard proc.isRunning else { return }
        proc.terminate()
    }

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
        // 던지는 write 를 쓰고 오류는 삼킨다 — 프로세스가 죽은 뒤 쓰면 예전 API 는
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
        switch method {
        case "commandExecution/requestApproval":
            let cmd = commandText(params)
            pendingApprovals[key] = (rpcId, method)
            let reason = params["reason"] as? String ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.onPermissionRequest?(key, "Bash", reason.isEmpty ? cmd : reason, cmd, nil)
            }
        case "fileChange/requestApproval":
            pendingApprovals[key] = (rpcId, method)
            let root = params["grantRoot"] as? String
            let reason = params["reason"] as? String ?? t("chat.codex.fileChange")
            DispatchQueue.main.async { [weak self] in
                self?.onPermissionRequest?(key, "Edit", reason, nil, root)
            }
        case "permissions/requestApproval":
            // 권한 프로파일 승인은 모양이 다르다(허용할 권한 집합을 돌려줘야 한다). 아직
            // 카드로 표현하지 않으므로 거절해 둔다 — 답을 안 하면 턴이 영영 멈춘다.
            respondRPC(rpcId, ["permissions": [:], "scope": "turn"])
        default:
            // 모르는 요청도 반드시 답한다. 침묵은 곧 멈춘 턴이다.
            respondRPC(rpcId, [:])
        }
    }

    private func handleNotification(_ method: String, _ params: [String: Any]) {
        switch method {
        case "item/agentMessage/delta":
            if let delta = params["delta"] as? String, !delta.isEmpty {
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
    private var tokenUsage: ChatUsage?

    /// 도구 하나가 시작/끝났다 → 챗의 도구 줄로.
    private func handleItem(_ item: [String: Any], completed: Bool) {
        guard let type = item["type"] as? String else { return }
        switch type {
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
