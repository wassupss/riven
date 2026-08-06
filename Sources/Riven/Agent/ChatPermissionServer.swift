import Foundation

// Per-session interactive-approval channel for the native chat (ClaudeChatSession).
//
// A PreToolUse hook injected via `--settings` runs a tiny python relay for each gated tool
// call. The relay forwards the hook JSON to this unix socket, then BLOCKS reading the reply
// — so the `claude` tool call is paused until riven answers. We surface the request to the
// chat UI (Allow / Deny card); the user's choice is written back as the hook's decision JSON.
//
// WHY unix domain + per-session path: no ports, filesystem perms are the auth, and each chat
// session owns its own socket so concurrent sessions/sub-agents never cross wires.
final class ChatPermissionServer {
    // (id = tool_use_id, name, tool_input) delivered on an internal queue; the owner maps it
    // to the UI. Answer with resolve(id:allow:).
    var onRequest: ((_ id: String, _ name: String, _ input: [String: Any]) -> Void)?

    private let path: String
    private let helperPath: String
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private let queue = DispatchQueue(label: "com.riven.chat.perm")
    private let clientQueue = DispatchQueue(label: "com.riven.chat.perm.client", attributes: .concurrent)
    private let lock = NSLock()
    private var pending: [String: (Bool) -> Void] = [:]   // tool_use_id → resolver

    // Tools that must be approved. Safe read-only tools are omitted (auto-run).
    // Risky built-ins + ALL MCP tools (so user-configured MCP servers go through riven's
    // approval policy too). riven's own ask_user is auto-allowed in requestPermission.
    private static let gated = "Edit|Write|MultiEdit|NotebookEdit|Bash|WebFetch|WebSearch|ExitPlanMode|mcp__.*"
    // 사람이 자리를 비우는 시간까지 기다린다. 5분이면 잠깐 회의만 다녀와도 조용히 거부되고,
    // 그동안 CLI 는 답을 기다리며 서 있을 뿐이라 길게 잡아도 손해가 없다.
    private static let decisionTimeout: TimeInterval = 1800
    /// 기다리던 승인 요청이 사라졌다 (시간 초과·세션 종료). 카드를 그때 바로 만료로 바꾸기 위한 것.
    var onExpire: ((_ id: String, _ reason: String) -> Void)?

    init?() {
        let dir = AgentHookServer.ensureSupportDir()
        let uid = UUID().uuidString.prefix(8)
        self.path = dir.appendingPathComponent("chat-perm-\(uid).sock").path
        self.helperPath = dir.appendingPathComponent("chat-approve.py").path
        guard writeHelper(), start() else { return nil }
    }

    // The value for `--settings`: a JSON string wiring our relay as the PreToolUse hook.
    func settingsJSON() -> String? {
        let cmd = "/usr/bin/env python3 \(shellQuote(helperPath)) \(shellQuote(path))"
        let settings: [String: Any] = ["hooks": ["PreToolUse": [[
            "matcher": Self.gated,
            "hooks": [["type": "command", "command": cmd]]
        ]]]]
        guard let d = try? JSONSerialization.data(withJSONObject: settings) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    // ---- decision ----
    func resolve(_ id: String, allow: Bool) {
        lock.lock(); let r = pending.removeValue(forKey: id); lock.unlock()
        r?(allow)
    }

    func stop() {
        acceptSource?.cancel(); acceptSource = nil; listenFD = -1
        unlink(path)
        // Fail-safe: unblock any relays still waiting (deny) so `claude` isn't wedged.
        lock.lock(); let rest = pending; pending.removeAll(); lock.unlock()
        if !rest.isEmpty { RLog.log("PERM 세션이 끝나 대기 중이던 승인 \(rest.count)건을 거부했습니다") }
        rest.values.forEach { $0(false) }
        let ids = Array(rest.keys)
        DispatchQueue.main.async { [weak self] in
            ids.forEach { self?.onExpire?($0, t("chat.expired.session")) }
        }
    }

    // ---- socket setup (mirrors AgentHookServer's POSIX bind/listen) ----
    private func start() -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        guard setPath(path, on: &addr) else { close(fd); return false }
        unlink(path)
        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(fd, 16) == 0 else { close(fd); return false }
        chmod(path, 0o600)
        listenFD = fd
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in self?.acceptOne() }
        src.setCancelHandler { close(fd) }
        src.resume()
        acceptSource = src
        return true
    }

    private func acceptOne() {
        let client = accept(listenFD, nil, nil)
        guard client >= 0 else { return }
        // Each request blocks until the user decides, so handle it off the accept queue.
        clientQueue.async { [weak self] in self?.serve(client) }
    }

    private func serve(_ client: Int32) {
        defer { close(client) }
        // Read the whole hook JSON (relay half-closes after sending).
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while data.count < 1_000_000 {
            let n = chunk.withUnsafeMutableBytes { read(client, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            data.append(contentsOf: chunk[0..<n])
        }
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = o["tool_name"] as? String else {
            _ = writeStr(client, Self.decisionJSON(allow: false)); return
        }
        let id = o["tool_use_id"] as? String ?? UUID().uuidString
        let input = o["tool_input"] as? [String: Any] ?? [:]

        let sem = DispatchSemaphore(value: 0)
        var allowed = false
        lock.lock()
        pending[id] = { a in allowed = a; sem.signal() }
        lock.unlock()
        onRequest?(id, name, input)

        if sem.wait(timeout: .now() + Self.decisionTimeout) == .timedOut {
            lock.lock(); pending.removeValue(forKey: id); lock.unlock()
            allowed = false
            RLog.log("PERM 시간 초과로 거부했습니다 (\(Int(Self.decisionTimeout))초) tool=\(name)")
            DispatchQueue.main.async { [weak self] in
                self?.onExpire?(id, t("chat.expired.permTimeout", ["m": String(Int(Self.decisionTimeout) / 60)]))
            }
        }
        _ = writeStr(client, Self.decisionJSON(allow: allowed))
    }

    private static func decisionJSON(allow: Bool) -> String {
        let out: [String: Any] = ["hookSpecificOutput": [
            "hookEventName": "PreToolUse",
            "permissionDecision": allow ? "allow" : "deny",
            "permissionDecisionReason": allow ? "riven 승인" : "riven에서 거부됨"
        ]]
        let d = (try? JSONSerialization.data(withJSONObject: out)) ?? Data()
        return String(data: d, encoding: .utf8) ?? "{}"
    }

    private func writeStr(_ fd: Int32, _ s: String) -> Bool {
        let bytes = Array(s.utf8); var off = 0
        while off < bytes.count {
            let n = bytes[off...].withUnsafeBytes { write(fd, $0.baseAddress, bytes.count - off) }
            if n <= 0 { return false }
            off += n
        }
        return true
    }

    private func setPath(_ path: String, on addr: inout sockaddr_un) -> Bool {
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return false }
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
        return true
    }
    private func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    // The relay: forward hook stdin to the socket, print whatever comes back (the decision).
    private func writeHelper() -> Bool {
        let py = """
        #!/usr/bin/env python3
        import socket, sys
        sock = sys.argv[1]
        data = sys.stdin.buffer.read()
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.connect(sock)
            s.sendall(data)
            s.shutdown(socket.SHUT_WR)
            out = b""
            while True:
                b = s.recv(4096)
                if not b: break
                out += b
            sys.stdout.write(out.decode("utf-8", "replace"))
        except Exception:
            pass  # on any failure, print nothing → CLI falls back to its own permission rules
        """
        return (try? py.write(toFile: helperPath, atomically: true, encoding: .utf8)) != nil
    }
}
