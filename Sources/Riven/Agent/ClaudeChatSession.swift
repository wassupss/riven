import Foundation

// Drives the `claude` CLI headless in stream-json mode to back a NATIVE chat panel - no
// terminal TUI, no Agent SDK (the SDK is API-key only; the CLI in this mode uses the user's
// SUBSCRIPTION login from the keychain, so there is no API billing). Bidirectional: user
// turns are written as JSON lines to stdin, structured events are read from stdout.
//
// Wire format confirmed empirically (2026-07-29):
//   stdin : {"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}\n
//   stdout: newline-delimited JSON. Every event carries `parent_tool_use_id`: null for the
//   MAIN thread, or the id of the `Agent`/`Task` tool_use that spawned it for a SUB-AGENT.
//     • system/init                                          → session id + model
//     • stream_event content_block_delta/text_delta (main)   → streamed tokens
//     • assistant (complete message, main OR sub)            → text + tool_use blocks
//     • user (tool_result, main OR sub)                      → a tool's output
//     • result                                               → turn done (session id, cost, usage)
//
// Interactive permission (confirmed 2026-07-29): a PreToolUse hook injected via `--settings`
// receives the full tool_input and BLOCKS the tool until it prints a decision, so riven can
// pop an approval card and answer allow/deny. The hook talks to us over a per-session unix
// socket (ChatPermissionServer); a tiny python relay is the hook `command`.
// Per-turn usage. NOTE: the result event sums usage across ALL model calls in the turn, so
// cacheRead (context re-read each tool iteration) balloons and is NOT "new" work. The tokens
// actually consumed this turn ≈ input + cacheWrite + output.
struct ChatUsage {
    let input: Int; let output: Int; let cacheWrite: Int; let cacheRead: Int
    var newTokens: Int { input + cacheWrite + output }
}

final class ClaudeChatSession {
    private let proc = Process()
    private let inPipe = Pipe()
    private let outPipe = Pipe()
    private var buffer = Data()
    private let queue = DispatchQueue(label: "com.riven.chat.claude")
    private var agentToolIds = Set<String>()   // ids of `Agent`/`Task` tool_uses = sub-agent launches
    private var editPaths: [String: String] = [:]   // main-thread edit tool_use id → file path
    private let perm: ChatPermissionServer?
    private let ask: ChatAskServer?

    // All callbacks are delivered on the MAIN thread.
    var onInit: ((_ sessionId: String, _ model: String?) -> Void)?
    var onTextDelta: ((String) -> Void)?                       // main assistant streamed token
    var onMainTool: ((_ name: String, _ detail: String, _ code: String?, _ path: String?) -> Void)?
    var onSubagentStart: ((_ id: String, _ type: String, _ desc: String) -> Void)?
    var onSubagentText: ((_ parentId: String, _ text: String) -> Void)?
    var onSubagentTool: ((_ parentId: String, _ name: String, _ detail: String, _ code: String?, _ path: String?) -> Void)?
    var onSubagentDone: ((_ id: String, _ result: String) -> Void)?
    /// 서브에이전트가 돌린 도구의 결과. 예전에는 이 이벤트를 아무 데도 보내지 않아서,
    /// 서브 팬에는 "Bash <명령>" 만 뜨고 출력이 영영 안 나왔다 - 오래 걸리는 명령일수록
    /// 죽은 것처럼 보였다 (사용자가 다시 물어보게 되는 지점).
    var onSubagentToolResult: ((_ parentId: String, _ text: String, _ isError: Bool) -> Void)?
    var onFileEdited: ((_ path: String) -> Void)?   // a main-thread edit landed → feed the Changes panel
    var onTurnDone: ((_ costUSD: Double?, _ sessionId: String?, _ usage: ChatUsage?, _ error: String?) -> Void)?
    var onExit: ((_ code: Int32) -> Void)?
    // Interactive approval: fired when a gated tool wants to run; answer via respond(id:allow:).
    var onPermissionRequest: ((_ id: String, _ name: String, _ detail: String, _ code: String?, _ path: String?) -> Void)?
    // A riven MCP tool was called (ask_user / riven_open_browser / riven_screenshot /
    // riven_api_request). Handle it and reply via respondTool(id:result:).
    var onToolRequest: ((_ id: String, _ tool: String, _ args: [String: Any]) -> Void)?

    private(set) var sessionId: String?
    /// The CLI version this process was launched with. Compared against the current on-disk
    /// version to offer "restart on the current CLI" after the CLI auto-updates mid-session.
    let spawnVersion: String?
    private(set) var toolList: [String] = []                       // tools from the init event
    private(set) var mcpServers: [(name: String, status: String)] = []   // connected MCP servers (like the CLI's /mcp)
    static let contextLimit = 200_000

    // `interactive` installs the approval hook (mode "default"); other modes govern edits
    // themselves so no hook is injected.
    init?(command: String, cwd: String, resume: String? = nil,
          permissionMode: String = "acceptEdits",
          allowedTools: String = "Task,Read,Grep,Glob,LS",
          interactive: Bool = false, agentName: String? = nil, model: String? = nil) {
        self.perm = interactive ? ChatPermissionServer() : nil
        self.ask = ChatAskServer()
        // Record the version of the binary we're about to exec (on-disk now), so a later
        // fresh check can tell this session apart from one spawned after a CLI auto-update.
        self.spawnVersion = AgentDiscovery.claudeVersion(fresh: true)
        proc.executableURL = URL(fileURLWithPath: command)
        // Allow all riven MCP tools so they run without a permission prompt.
        let tools = ask.map { "\(allowedTools),\($0.toolPrefix)" } ?? allowedTools
        var args = ["-p",
                    "--input-format", "stream-json",
                    "--output-format", "stream-json",
                    "--verbose", "--include-partial-messages",
                    "--permission-mode", permissionMode,
                    "--allowedTools", tools]
        if let settings = perm?.settingsJSON() { args += ["--settings", settings] }
        if let cfg = ask?.mcpConfigJSON() { args += ["--mcp-config", cfg] }
        if let sp = ask?.systemPrompt() { args += ["--append-system-prompt", sp] }
        if let agentName, !agentName.isEmpty { args += ["--agent", agentName] }   // run as this custom agent
        // 팬별 모델 고정: 그룹의 에이전트마다 다른 모델을 쓸 수 있다. 기동 인자로 주는 편이
        // set_model 컨트롤 메시지보다 확실하다 (init 전에 도착할 일이 없음).
        if let model, !model.isEmpty, model != "default" { args += ["--model", model] }
        if let resume { args += ["--resume", resume] }
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice
        // Default environment on purpose: subscription auth from the keychain / ~/.claude.
        // Do NOT set ANTHROPIC_API_KEY or pass --bare (that path is API-key only).
        perm?.onRequest = { [weak self] id, name, input in
            guard let self else { return }
            let d = self.toolDetail(name, input)
            let code = self.toolCode(name, input)
            let path = self.toolPath(name, input)
            DispatchQueue.main.async { self.onPermissionRequest?(id, name, d, code, path) }
        }
        ask?.onExpire = { [weak self] id, reason in self?.onAskExpired?(id, reason) }
        perm?.onExpire = { [weak self] id, reason in self?.onAskExpired?(id, reason) }
        ask?.onTool = { [weak self] id, tool, args, _ in
            DispatchQueue.main.async { self?.onToolRequest?(id, tool, args) }
        }
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            // EOF (process exited / closed stdout): availableData is empty AND the fd stays
            // signalled forever, so the handler is re-invoked in a tight loop pegging a worker
            // thread at 100%. MUST detach the handler here - this was the runaway CPU when an agent
            // died (bad --resume, crash, 529-exit): every dead session left a spinning pipe reader.
            if d.isEmpty { h.readabilityHandler = nil; return }
            self?.queue.async { self?.feed(d) }
        }
        proc.terminationHandler = { [weak self] p in
            self?.perm?.stop(); self?.ask?.stop()
            DispatchQueue.main.async { self?.onExit?(p.terminationStatus) }
        }
        do { try proc.run() } catch { perm?.stop(); ask?.stop(); return nil }
    }

    var isAlive: Bool { proc.isRunning }

    func send(_ text: String) {
        writeLine(["type": "user",
                   "message": ["role": "user", "content": text],
                   "parent_tool_use_id": NSNull()])
    }

    // Change the CLI permission mode WITHOUT restarting - verified to work live over the
    // stream-json control channel, so an in-flight turn keeps running.
    private var ctrlSeq = 0
    func setPermissionMode(_ mode: String) {
        // riven 의 "auto" 는 CLI 의 모드가 아니라 riven 쪽 정책이다 (requestPermission 이
        // 자동 허용한다). CLI 에는 그대로 보내면 거절당하므로 default 로 옮긴다.
        let mode = mode == "auto" ? "default" : mode
        ctrlSeq += 1
        writeLine(["type": "control_request", "request_id": "m\(ctrlSeq)",
                   "request": ["subtype": "set_permission_mode", "mode": mode]])
    }

    // Stop the current turn (verified: emits a result with subtype error_during_execution).
    func interrupt() {
        ctrlSeq += 1
        writeLine(["type": "control_request", "request_id": "i\(ctrlSeq)",
                   "request": ["subtype": "interrupt"]])
    }
    // Change the model live (verified over the control channel), like set_permission_mode.
    func setModel(_ model: String) {
        ctrlSeq += 1
        writeLine(["type": "control_request", "request_id": "m\(ctrlSeq)",
                   "request": ["subtype": "set_model", "model": model]])
    }

    private func writeLine(_ obj: [String: Any]) {
        guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
        queue.async { [weak self] in
            guard let self, self.proc.isRunning else { return }   // never write to a dead process
            var line = body; line.append(0x0a)
            // Use the THROWING write and swallow the error: if the process died mid-write the pipe
            // is broken, and the old `write(_:)` raised an NSException ("Broken pipe") that crashed
            // the whole app the moment you typed after a session had exited (bad --resume, 529-exit).
            do { try self.inPipe.fileHandleForWriting.write(contentsOf: line) } catch {}
        }
    }

    // Answer an outstanding permission request (called on the main thread from the UI).
    func respond(_ id: String, allow: Bool) { perm?.resolve(id, allow: allow) }
    // Return a riven tool's result to the agent.
    @discardableResult
    func respondTool(_ id: String, _ result: String) -> Bool { ask?.resolve(id, result: result) ?? false }
    /// 기다리던 도구 요청이 사라졌다 (시간 초과·세션 종료).
    var onAskExpired: ((_ id: String, _ reason: String) -> Void)?

    func stop() {
        outPipe.fileHandleForReading.readabilityHandler = nil
        perm?.stop(); ask?.stop()
        try? inPipe.fileHandleForWriting.close()
        if proc.isRunning { proc.terminate() }
    }

    // ---- line-delimited JSON framing ----
    private func feed(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0a) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if line.isEmpty { continue }
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { handle(obj) }
        }
    }

    private func handle(_ o: [String: Any]) {
        let parent = o["parent_tool_use_id"] as? String   // nil = main thread
        switch o["type"] as? String {
        case "system":
            if o["subtype"] as? String == "init" {
                let sid = o["session_id"] as? String ?? ""
                sessionId = sid
                let model = o["model"] as? String
                toolList = o["tools"] as? [String] ?? []
                if let servers = o["mcp_servers"] as? [[String: Any]] {
                    mcpServers = servers.map { (name: $0["name"] as? String ?? "?", status: $0["status"] as? String ?? "?") }
                }
                main { self.onInit?(sid, model) }
            }
        case "stream_event":
            guard parent == nil, let ev = o["event"] as? [String: Any],
                  ev["type"] as? String == "content_block_delta",
                  let delta = ev["delta"] as? [String: Any],
                  delta["type"] as? String == "text_delta",
                  let t = delta["text"] as? String else { return }
            main { self.onTextDelta?(t) }
        case "assistant":
            for block in blocks(o) {
                let bt = block["type"] as? String
                if bt == "tool_use", let name = block["name"] as? String {
                    let id = block["id"] as? String ?? ""
                    let input = block["input"] as? [String: Any] ?? [:]
                    if name == "Agent" || name == "Task" {            // sub-agent launch
                        agentToolIds.insert(id)
                        let type = input["subagent_type"] as? String ?? "subagent"
                        let desc = input["description"] as? String
                            ?? (input["prompt"] as? String).map { String($0.prefix(80)) } ?? ""
                        main { self.onSubagentStart?(id, type, desc) }
                    } else if let parent {                            // sub-agent's own tool call
                        let d = self.toolDetail(name, input); let c = self.toolCode(name, input); let p = self.toolPath(name, input)
                        main { self.onSubagentTool?(parent, name, d, c, p) }
                    } else {                                          // main thread tool call
                        let d = self.toolDetail(name, input); let c = self.toolCode(name, input); let p = self.toolPath(name, input)
                        // Remember file-editing calls so we can report them to the Changes panel once
                        // the tool_result confirms the edit landed (the native chat has no PostToolUse
                        // hook, so this stream is how it feeds recordAgentFileEdit).
                        if let p, ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(name) { editPaths[id] = p }
                        main { self.onMainTool?(name, d, c, p) }
                    }
                } else if bt == "text", let text = block["text"] as? String, let parent {
                    main { self.onSubagentText?(parent, text) }        // sub-agent message text
                }
            }
        case "user":
            for block in blocks(o) where block["type"] as? String == "tool_result" {
                guard let tid = block["tool_use_id"] as? String else { continue }
                // A main-thread edit finished (file is now written) → tell the Changes panel.
                if let path = editPaths.removeValue(forKey: tid) {
                    let isErr = (block["is_error"] as? Bool) ?? false
                    if !isErr { main { self.onFileEdited?(path) } }
                }
                if !agentToolIds.contains(tid) {
                    // 서브에이전트가 돌린 도구의 결과 (parent = 그 서브에이전트의 Task id).
                    if let parent {
                        let text = resultText(block["content"])
                        let isErr = (block["is_error"] as? Bool) ?? false
                        main { self.onSubagentToolResult?(parent, text, isErr) }
                    }
                    continue
                }
                let text = resultText(block["content"])
                main { self.onSubagentDone?(tid, text) }
            }
        case "result":
            let cost = o["total_cost_usd"] as? Double
            let sid = o["session_id"] as? String
            let u = usage(o["usage"] as? [String: Any])
            // Surface failures: on is_error the turn produced no (or partial) answer - e.g. a 529
            // Overloaded, max-turns, or interrupt. Previously this was dropped, so the turn just
            // ended with a "완료" notification and nothing shown (the "결과가 날아간" report).
            var err: String? = nil
            if (o["is_error"] as? Bool ?? false) || (o["subtype"] as? String ?? "success") != "success" {
                let sub = o["subtype"] as? String ?? "error"
                let msg = (o["result"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? sub
                err = msg
            }
            main { self.onTurnDone?(cost, sid, u, err) }
        default: break
        }
    }

    private func usage(_ u: [String: Any]?) -> ChatUsage? {
        guard let u else { return nil }
        return ChatUsage(input: u["input_tokens"] as? Int ?? 0,
                         output: u["output_tokens"] as? Int ?? 0,
                         cacheWrite: u["cache_creation_input_tokens"] as? Int ?? 0,
                         cacheRead: u["cache_read_input_tokens"] as? Int ?? 0)
    }

    private func blocks(_ o: [String: Any]) -> [[String: Any]] {
        ((o["message"] as? [String: Any])?["content"] as? [[String: Any]]) ?? []
    }
    private func resultText(_ c: Any?) -> String {
        if let s = c as? String { return s }
        if let arr = c as? [[String: Any]] {
            return arr.compactMap { $0["text"] as? String }.joined(separator: "\n")
        }
        return ""
    }
    private func main(_ f: @escaping () -> Void) { DispatchQueue.main.async(execute: f) }

    // Human-readable target of a tool call ("Read → math.js", "Bash → npm test").
    private func toolDetail(_ name: String, _ input: [String: Any]) -> String {
        func s(_ k: String) -> String? { (input[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
        let raw: String?
        switch name {
        case "Read", "Edit", "Write", "MultiEdit", "NotebookEdit": raw = s("file_path").map(shortenPath)
        case "Bash":                                   raw = (input["description"] as? String) ?? ""   // full cmd is in the block
        case "BashOutput":                             raw = s("command")
        case "Grep":                                   raw = [s("pattern"), s("path").map { "in \(shortenPath($0))" }].compactMap { $0 }.joined(separator: " ")
        case "Glob":                                   raw = s("pattern")
        case "LS":                                     raw = s("path").map(shortenPath)
        case "WebFetch":                               raw = s("url")
        case "WebSearch":                              raw = s("query")
        default:                                       raw = s("file_path").map(shortenPath) ?? s("path").map(shortenPath) ?? s("command") ?? s("pattern") ?? s("query")
        }
        let d = raw ?? ""
        return d.count > 120 ? String(d.prefix(120)) + "…" : d
    }

    // A code/diff body to show under the tool line (edits & writes), else nil.
    private func toolCode(_ name: String, _ input: [String: Any]) -> String? {
        func s(_ k: String) -> String? { input[k] as? String }
        switch name {
        case "Edit": return Self.diff(s("old_string"), s("new_string"))
        case "Write": return s("content").map { Self.clamp($0) }
        case "NotebookEdit": return s("new_source").map { Self.clamp($0) }
        case "MultiEdit":
            guard let edits = input["edits"] as? [[String: Any]] else { return nil }
            return edits.compactMap { Self.diff($0["old_string"] as? String, $0["new_string"] as? String) }
                        .joined(separator: "\n\n")
        case "ExitPlanMode": return (input["plan"] as? String).map { Self.clamp($0) }
        case "Bash": return (input["command"] as? String).map { Self.clamp($0) }   // full command as a block
        default: return nil
        }
    }
    // A compact unified-ish diff: removed lines prefixed "-", added "+".
    private static func diff(_ old: String?, _ new: String?) -> String? {
        guard old != nil || new != nil else { return nil }
        var lines: [String] = []
        for l in (old ?? "").components(separatedBy: "\n") where !(old ?? "").isEmpty { lines.append("- " + l) }
        for l in (new ?? "").components(separatedBy: "\n") where !(new ?? "").isEmpty { lines.append("+ " + l) }
        return clamp(lines.joined(separator: "\n"))
    }
    private static func clamp(_ s: String) -> String {
        let lines = s.components(separatedBy: "\n")
        if lines.count <= 28 { return s }
        return lines.prefix(28).joined(separator: "\n") + "\n… (\(lines.count - 28)줄 더)"
    }
    // Raw (absolute) file path a tool acts on, for opening it in riven's editor - nil for
    // tools without a file target.
    private func toolPath(_ name: String, _ input: [String: Any]) -> String? {
        switch name {
        case "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "LS": return input["file_path"] as? String ?? input["path"] as? String
        default: return nil
        }
    }
    private func shortenPath(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let short = p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
        return String(short)
    }
}
