import Foundation

// Gives the native chat an interactive "choose one option" prompt (the CLI's arrow-select
// menu), which headless Claude otherwise can't do — AskUserQuestion isn't in the headless
// tool set. We provide our OWN tool via MCP: a tiny stdio MCP server (python) exposes
// `ask_user(question, options)`; an --append-system-prompt tells the agent to call it instead
// of writing a numbered list. When called, the MCP server forwards the question over this unix
// socket, riven shows a choice card, and the user's pick is returned as the tool result.
//
// Verified 2026-07-29: --mcp-config loads the stdio server headless, the agent calls the tool,
// and uses the returned answer.
final class ChatAskServer {
    // (id, question, options) delivered on an internal queue; answer with resolve(id:answer:).
    var onRequest: ((_ id: String, _ question: String, _ options: [String]) -> Void)?

    private let path: String
    private let serverPath: String
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private let queue = DispatchQueue(label: "com.riven.chat.ask")
    private let clientQueue = DispatchQueue(label: "com.riven.chat.ask.client", attributes: .concurrent)
    private let lock = NSLock()
    private var pending: [String: (String) -> Void] = [:]   // id → resolver(answer)
    private static let timeout: TimeInterval = 600

    init?() {
        let dir = AgentHookServer.ensureSupportDir()
        let uid = UUID().uuidString.prefix(8)
        self.path = dir.appendingPathComponent("chat-ask-\(uid).sock").path
        self.serverPath = dir.appendingPathComponent("chat-ask-mcp.py").path
        guard writeServer(), start() else { return nil }
    }

    // Value for `--mcp-config`: a stdio MCP server that relays to our socket.
    func mcpConfigJSON() -> String? {
        let cfg: [String: Any] = ["mcpServers": ["riven": [
            "command": "/usr/bin/env",
            "args": ["python3", serverPath, path]
        ]]]
        guard let d = try? JSONSerialization.data(withJSONObject: cfg) else { return nil }
        return String(data: d, encoding: .utf8)
    }
    var toolName: String { "mcp__riven__ask_user" }
    func systemPrompt() -> String {
        "사용자가 여러 선택지 중 하나를 골라야 하는 상황(진행 방식 확인, 옵션 제시 등)에서는 번호 목록을 텍스트로 쓰지 말고 반드시 `ask_user` 도구(\(toolName))를 호출하세요. options 배열에 각 선택지를 문자열로 넣으면 사용자가 UI에서 방향키로 고릅니다. 반환값이 사용자가 고른 선택지입니다."
    }

    func resolve(_ id: String, answer: String) {
        lock.lock(); let r = pending.removeValue(forKey: id); lock.unlock()
        r?(answer)
    }
    func stop() {
        acceptSource?.cancel(); acceptSource = nil; listenFD = -1
        unlink(path)
        lock.lock(); let rest = pending; pending.removeAll(); lock.unlock()
        rest.values.forEach { $0("") }   // unblock any waiters so the agent isn't wedged
    }

    // ---- socket (same POSIX bind/listen as ChatPermissionServer) ----
    private func start() -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX); addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        guard setPath(path, on: &addr) else { close(fd); return false }
        unlink(path)
        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
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
        clientQueue.async { [weak self] in self?.serve(client) }
    }
    private func serve(_ client: Int32) {
        defer { close(client) }
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while data.count < 1_000_000 {
            let n = chunk.withUnsafeMutableBytes { read(client, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            data.append(contentsOf: chunk[0..<n])
        }
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let q = o["question"] as? String else { _ = writeStr(client, ""); return }
        let opts = (o["options"] as? [String]) ?? []
        let id = UUID().uuidString
        let sem = DispatchSemaphore(value: 0)
        var answer = ""
        lock.lock(); pending[id] = { a in answer = a; sem.signal() }; lock.unlock()
        onRequest?(id, q, opts)
        if sem.wait(timeout: .now() + Self.timeout) == .timedOut {
            lock.lock(); pending.removeValue(forKey: id); lock.unlock()
        }
        _ = writeStr(client, answer)
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

    private func writeServer() -> Bool {
        let py = #"""
        #!/usr/bin/env python3
        import sys, json, socket
        SOCK = sys.argv[1]
        def send(m): sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
        def ask(question, options):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(SOCK)
            s.sendall((json.dumps({"question": question, "options": options}) + "\n").encode())
            s.shutdown(socket.SHUT_WR)
            buf = b""
            while True:
                b = s.recv(4096)
                if not b: break
                buf += b
            return buf.decode("utf-8", "replace").strip()
        TOOL = {"name": "ask_user",
                "description": "Ask the user to choose one of several options via a native UI. Use this instead of writing a numbered list whenever you need the user to pick.",
                "inputSchema": {"type": "object",
                    "properties": {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}}},
                    "required": ["question", "options"]}}
        for line in sys.stdin:
            line = line.strip()
            if not line: continue
            try: r = json.loads(line)
            except Exception: continue
            mid = r.get("id"); m = r.get("method")
            if m == "initialize":
                send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "riven", "version": "1.0"}}})
            elif m == "tools/list":
                send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [TOOL]}})
            elif m == "tools/call":
                p = r.get("params", {}); a = p.get("arguments", {})
                if p.get("name") == "ask_user":
                    try: ans = ask(a.get("question", ""), a.get("options", []))
                    except Exception: ans = ""
                    send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": ans or "(사용자가 응답하지 않음)"}]}})
                else:
                    send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown tool"}})
            elif mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown method"}})
        """#
        return (try? py.write(toFile: serverPath, atomically: true, encoding: .utf8)) != nil
    }
}
