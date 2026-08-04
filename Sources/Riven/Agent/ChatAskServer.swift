import Foundation

// riven's OWN tools, provided to headless Claude over MCP (things the headless CLI can't do
// itself, or that should run inside riven's UI). A tiny stdio MCP server (python) is wired via
// --mcp-config and exposes these tools; --append-system-prompt tells the agent they exist. On
// a tool call the server forwards {tool,args} over this unix socket, riven performs it in-app,
// and the result string is returned to the agent.
//
//   ask_user(question, options)            → arrow-select choice card (no AskUserQuestion headless)
//   riven_open_browser(url)                → open the URL in riven's preview panel
//   riven_screenshot(url?)                 → open (optional url) + capture → PNG path to Read
//   riven_api_request(method,url,headers?,body?) → run an HTTP request, return status/body
//
// Verified 2026-07-29: --mcp-config loads the stdio server headless and the agent calls tools.
final class ChatAskServer {
    // (id, tool, args) delivered on an internal queue; return via resolve(id:result:).
    var onTool: ((_ id: String, _ tool: String, _ args: [String: Any]) -> Void)?

    let path: String
    private let serverPath: String
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private let queue = DispatchQueue(label: "com.riven.chat.tools")
    private let clientQueue = DispatchQueue(label: "com.riven.chat.tools.client", attributes: .concurrent)
    private let lock = NSLock()
    private var pending: [String: (String) -> Void] = [:]   // id → resolver(result string)
    private static let timeout: TimeInterval = 600

    init?() {
        let dir = AgentHookServer.ensureSupportDir()
        let uid = UUID().uuidString.prefix(8)
        self.path = dir.appendingPathComponent("chat-tools-\(uid).sock").path
        self.serverPath = dir.appendingPathComponent("chat-tools-mcp.py").path
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
    /// Write the --mcp-config JSON to a file and return its path (the shell shim passes a path,
    /// not inline JSON, so a hand-typed `claude` gets riven's tools too).
    func mcpConfigPath() -> String? {
        guard let json = mcpConfigJSON() else { return nil }
        let url = AgentHookServer.ensureSupportDir().appendingPathComponent("riven-mcp.json")
        guard (try? json.write(to: url, atomically: true, encoding: .utf8)) != nil else { return nil }
        return url.path
    }
    var toolPrefix: String { "mcp__riven" }        // allowedTools entry: allow all riven tools
    func systemPrompt() -> String {
        """
        이 세션에는 riven이 제공하는 도구가 있습니다. 적절할 때 사용하세요:
        - 사용자에게 선택지를 물을 땐 번호 목록을 쓰지 말고 `ask_user`(mcp__riven__ask_user) 를 호출하세요(options 배열 → UI에서 방향키 선택, 고른 값 반환).
        - 코드/파일을 사용자와 함께 보며 이야기할 땐 `riven_open_file`(path, line?) 로 riven 에디터에 엽니다.
        - 웹페이지를 사용자에게 보여줄 땐 `riven_open_browser`(url) 로 riven 미리보기 패널에 엽니다.
        - 웹페이지 화면이 필요하면 `riven_screenshot`(url?) 로 캡처합니다. 반환된 PNG 경로를 Read 로 읽어 확인하세요.
        - HTTP/API 를 테스트할 땐 `riven_api_request`(method,url,headers?,body?) — riven API 패널에 열려 실행되고 상태/본문을 반환합니다.
        - riven의 패널/워크스페이스를 파악·조작할 수 있습니다: `riven_panels`(현재 패널 목록), `riven_open_panel`(kind), `riven_close_panel`(id), `riven_workspaces`, `riven_open_workspace`(path).
        - 다른 에이전트와 팀으로 일할 수 있습니다: `riven_agents` 로 동료(역할·상태)를 확인하고, `riven_ask_agent`(agent, message) 로 일을 넘긴 뒤 답을 받습니다. 여러 명에게 서로 무관한 일을 시킬 땐 `riven_ask_agents`(tasks=[{agent,message},…]) 를 한 번 호출하세요 — 전원이 동시에 시작합니다 (한 명씩 부르면 순차로 끝날 때까지 기다리게 됩니다). 새 동료가 필요하면 `riven_open_panel`("chat") 로 패널을 엽니다. 자기 자신에게는 넘길 수 없습니다.
        """
    }

    /// 답을 기다리던 요청이 실제로 있었는지 돌려준다 — 이미 만료·취소된 요청에 답하면 false
    /// (호출자는 그걸 사용자에게 알려줄 수 있다).
    @discardableResult
    func resolve(_ id: String, result: String) -> Bool {
        lock.lock(); let r = pending.removeValue(forKey: id); lock.unlock()
        r?(result)
        return r != nil
    }
    /// 벤치용: 파이썬 릴레이와 똑같은 방식으로 소켓에 요청 하나를 던지고 답을 기다린다.
    static func debugCall(sock: String, tool: String) -> String? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX); addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(sock.utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
        let ok = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else { close(fd); return nil }
        let body = Array("{\"tool\":\"\(tool)\",\"args\":{}}\n".utf8)
        _ = body.withUnsafeBytes { write(fd, $0.baseAddress, body.count) }
        shutdown(fd, SHUT_WR)
        var out = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n <= 0 { break }
            out.append(contentsOf: buf[0..<n])
        }
        close(fd)
        return String(data: out, encoding: .utf8)
    }

    func stop() {
        acceptSource?.cancel(); acceptSource = nil; listenFD = -1
        unlink(path)
        lock.lock(); let rest = pending; pending.removeAll(); lock.unlock()
        // 빈 문자열로 풀면 에이전트에겐 "(no result)" 로 보여 실패 이유를 알 수 없다.
        rest.values.forEach { $0("riven: request cancelled (the pane's session ended)") }
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
        while data.count < 2_000_000 {
            let n = chunk.withUnsafeMutableBytes { read(client, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            data.append(contentsOf: chunk[0..<n])
        }
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tool = o["tool"] as? String else { _ = writeStr(client, ""); return }
        let args = o["args"] as? [String: Any] ?? [:]
        let id = UUID().uuidString
        let sem = DispatchSemaphore(value: 0)
        var result = ""
        lock.lock(); pending[id] = { r in result = r; sem.signal() }; lock.unlock()
        onTool?(id, tool, args)
        if sem.wait(timeout: .now() + Self.timeout) == .timedOut {
            lock.lock(); pending.removeValue(forKey: id); lock.unlock()
            result = "riven: timed out waiting for the user (no answer in \(Int(Self.timeout))s)"
        }
        _ = writeStr(client, result)
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
        import sys, json, socket, threading
        SOCK = sys.argv[1]
        _out = threading.Lock()
        def send(m):
            with _out:
                sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
        def call(tool, args):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(SOCK)
            s.sendall((json.dumps({"tool": tool, "args": args}) + "\n").encode())
            s.shutdown(socket.SHUT_WR)
            buf = b""
            while True:
                b = s.recv(4096)
                if not b: break
                buf += b
            return buf.decode("utf-8", "replace").strip()
        TOOLS = [
            {"name": "ask_user",
             "description": "Ask the user to choose one option via a native UI. Use instead of writing a numbered list.",
             "inputSchema": {"type": "object", "properties": {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}}}, "required": ["question", "options"]}},
            {"name": "riven_open_file",
             "description": "Open a file in riven's code editor (optionally at a line) so the user can review it with you.",
             "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "line": {"type": "number"}}, "required": ["path"]}},
            {"name": "riven_open_browser",
             "description": "Open a URL in riven's preview browser panel so the user can see it.",
             "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
            {"name": "riven_screenshot",
             "description": "Open an optional URL in riven's preview and capture a screenshot. Returns a PNG file path; read it with the Read tool to see the page.",
             "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}}},
            {"name": "riven_api_request",
             "description": "Run an HTTP request in riven's API-client panel (opens it, shows the response) and also return status/headers/body.",
             "inputSchema": {"type": "object", "properties": {"method": {"type": "string"}, "url": {"type": "string"}, "headers": {"type": "object"}, "body": {"type": "string"}}, "required": ["method", "url"]}},
            {"name": "riven_panels",
             "description": "List riven's current panels (dock panes): id, kind and title, so you understand the workspace layout.",
             "inputSchema": {"type": "object", "properties": {}}},
            {"name": "riven_open_panel",
             "description": "Open a riven panel. kind: editor | terminal | chat | search | git | preview | api | changes.",
             "inputSchema": {"type": "object", "properties": {"kind": {"type": "string"}}, "required": ["kind"]}},
            {"name": "riven_close_panel",
             "description": "Close a panel by its id (from riven_panels).",
             "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
            {"name": "riven_agents",
             "description": "List the other agent panes open in riven (role, id, busy/idle). Use before delegating.",
             "inputSchema": {"type": "object", "properties": {}}},
            {"name": "riven_ask_agent",
             "description": "Delegate work to ANOTHER agent pane and wait for its answer. `agent` is a role name, pane id or panel title from riven_agents. The message appears in that agent's conversation, and its reply is returned to you. Use this to work as a team (e.g. hand implementation to a coder, then ask a reviewer).",
             "inputSchema": {"type": "object", "properties": {"agent": {"type": "string"}, "message": {"type": "string"}}, "required": ["agent", "message"]}},
            {"name": "riven_ask_agents",
             "description": "Delegate to SEVERAL agents AT ONCE and wait for all of them. Every task starts immediately and they run in parallel, so prefer this over calling riven_ask_agent repeatedly when the work is independent. Returns each agent's answer.",
             "inputSchema": {"type": "object", "properties": {"tasks": {"type": "array", "items": {"type": "object", "properties": {"agent": {"type": "string"}, "message": {"type": "string"}}, "required": ["agent", "message"]}}}, "required": ["tasks"]}},
            {"name": "riven_workspaces",
             "description": "List open workspaces (folders) and which one is active.",
             "inputSchema": {"type": "object", "properties": {}}},
            {"name": "riven_open_workspace",
             "description": "Open/switch to a workspace folder by path.",
             "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
        ]
        for line in sys.stdin:
            line = line.strip()
            if not line: continue
            try: r = json.loads(line)
            except Exception: continue
            mid = r.get("id"); m = r.get("method")
            if m == "initialize":
                send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "riven", "version": "1.0"}}})
            elif m == "tools/list":
                send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
            elif m == "tools/call":
                # 호출마다 스레드. 예전엔 stdin 루프가 한 번에 하나씩만 처리해서, 모델이 한
                # 메시지에 도구를 여러 개(riven_ask_agent ×3) 내보내도 우리가 줄을 세웠다 —
                # 동료들이 순차로 돌던 원인. JSON-RPC는 응답 순서가 뒤바뀌어도 된다.
                def work(mid, p):
                    name = p.get("name", ""); a = p.get("arguments", {})
                    try: out = call(name, a)
                    except Exception as e: out = "error: %s" % e
                    send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": out or "(no result)"}]}})
                threading.Thread(target=work, args=(mid, r.get("params", {})), daemon=True).start()
            elif mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown method"}})
        """#
        return (try? py.write(toFile: serverPath, atomically: true, encoding: .utf8)) != nil
    }
}
