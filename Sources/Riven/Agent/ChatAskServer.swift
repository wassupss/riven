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
    var onTool: ((_ id: String, _ tool: String, _ args: [String: Any], _ cwd: String?) -> Void)?

    let path: String
    private let serverPath: String
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private let queue = DispatchQueue(label: "com.riven.chat.tools")
    private let clientQueue = DispatchQueue(label: "com.riven.chat.tools.client", attributes: .concurrent)
    private let lock = NSLock()
    private var pending: [String: (String) -> Void] = [:]   // id → resolver(result string)
    // 사람이 자리를 비우는 시간까지 기다린다. 10분이면 점심 한 번에 선택지가 죽어 버렸고,
    // 그동안 CLI 는 어차피 답을 기다리며 서 있을 뿐이라 길게 잡아도 손해가 없다.
    private static let timeout: TimeInterval = 1800
    /// 기다리던 요청이 사라졌을 때 (시간 초과·세션 종료). 화면의 선택 카드를 그때 바로
    /// 만료 표시로 바꾸기 위한 것 — 예전에는 사용자가 눌러 보고 나서야 알 수 있었다.
    var onExpire: ((_ id: String, _ reason: String) -> Void)?

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
        - 문서를 써 달라고 하면 `riven_doc_write`(path, body) 로 워크스페이스에 실제 .md 파일을 만듭니다. `riven_note_write` 는 저장소에 남기지 않는 작업 메모용입니다.
        - 사용자에게 선택지를 물을 땐 번호 목록을 쓰지 말고 `ask_user`(mcp__riven__ask_user) 를 호출하세요(options 배열 → UI에서 방향키 선택, 고른 값 반환).
        - 코드/파일을 사용자와 함께 보며 이야기할 땐 `riven_open_file`(path, line?) 로 riven 에디터에 엽니다.
        - riven 브라우저를 직접 운전할 수 있습니다: `riven_browser_open`(url, new_tab?) 로 열고, `riven_browser_state`() 로 지금 주소·제목을 확인하고, `riven_browser_read`(selector?, html?) 로 내용을 읽고, `riven_browser_click`(selector) / `riven_browser_fill`(selector, value, submit?) 로 조작하고, 늦게 그려지는 화면은 `riven_browser_wait`(selector) 로 기다립니다. 뒤로/앞으로/새로고침은 `riven_browser_go`(action). 화면이 필요하면 `riven_screenshot`(url?) 로 캡처해 PNG 경로를 Read 로 읽으세요.
        - 브라우저는 쿠키·세션을 유지합니다 (로그인한 페이지가 그대로 남아 있을 수 있습니다). 전용 도구로 안 되는 경우에만 `riven_browser_eval`(js) 를 쓰고, 이건 페이지마다 사용자 승인을 받습니다.
        - HTTP/API 를 테스트할 땐 `riven_api_request`(method,url,headers?,body?) — riven API 패널에 열려 실행되고 상태/본문을 반환합니다.
        - riven의 패널/워크스페이스를 파악·조작할 수 있습니다: `riven_panels`(현재 패널 목록), `riven_open_panel`(kind), `riven_close_panel`(id), `riven_workspaces`, `riven_open_workspace`(path).
        - 다른 에이전트와 팀으로 일할 수 있습니다: `riven_agents` 로 동료(역할·상태)를 확인하고, `riven_ask_agent`(agent, message) 로 일을 넘긴 뒤 답을 받습니다. 여러 명에게 서로 무관한 일을 시킬 땐 `riven_ask_agents`(tasks=[{agent,message},…]) 를 한 번 호출하세요. 전원이 동시에 시작합니다 (한 명씩 부르면 순차로 끝날 때까지 기다리게 됩니다). 오래 걸릴 일은 `wait=false` 로 넘기면 즉시 반환되고, 답은 도착하는 대로 당신의 대화에 전달됩니다. 그동안 다른 일을 하세요.
        - 긴 결과(요약·계획·조사 메모·인수인계 문서)는 대화에 쏟아 넣지 말고 메모로 남기세요: `riven_note_write`(title, body, note?) 로 riven 메모 패널에 마크다운 문서를 만듭니다(note 를 주면 그 메모를 갈아끼웁니다. 이전 내용은 백업되어 사용자가 되돌릴 수 있습니다). 이어 쓰기는 `riven_note_append`(note, body), 읽기는 `riven_note_read`(note), 목록은 `riven_note_list`(scope?) 입니다. 워크스페이스에 실제 .md 파일로 남길 땐 `riven_note_save_file`(note, path, overwrite?) 를 씁니다.
        - 그룹 인원은 `riven_group_add_agent`(group, name, persona?, model?, parent?) 로 늘리고, `riven_group_remove_agent`(group, name) 로 줄입니다. 그룹 자체는 `riven_group_delete`(group). 줄이거나 지우는 건 사용자 확인을 거쳐야 실행되며, 동의하지 않으면 그대로 유지됩니다. 새 동료가 필요하면 `riven_open_panel`("chat") 로 패널을 엽니다. 자기 자신에게는 넘길 수 없습니다.

        동료와 함께 일할 때는 아래 4가지 협업 패턴 중 상황에 맞는 것을 고르세요. 전부 위의 `riven_ask_agent`/`riven_ask_agents` 위에서 도는 것이라 새 도구는 없습니다 — 언제·어떻게 부르느냐의 문제입니다:
        - **handoff(넘기기)**: 일을 통째로 다른 동료에게 넘길 때. 받는 동료는 당신의 대화를 보지 못하므로 프롬프트가 자기완결적이어야 합니다 — [작업: 무엇을] · [맥락: 왜] · [관련 파일·경로] · [현재 상태] · [이미 시도한 것] 을 모두 담으세요. 맥락이 빠지면 그 동료는 처음부터 헤맵니다.
        - **committee(합의체)**: 막혔을 때. 성향(가능하면 모델 계열)이 다른 동료 2명에게 `riven_ask_agents` 로 같은 문제의 근본 원인 + 계획을 병렬로 물어, 두 답을 대조해 고릅니다. "혼자 더 파지 말고 물러서서 두 시각을 받는" 용도입니다.
        - **advisor(자문)**: 일은 넘기지 않고 2차 소견만 받을 때. 한 명에게 "이 접근이 맞는지 / 놓친 게 있는지" 만 묻고 결정과 실행은 당신이 합니다.
        - **loop(루프)**: worker↔verifier 사이클. 한 동료가 만들고 다른 동료가 검증해 되돌리기를 반복합니다. 반드시 **종료 조건(예: verifier가 통과)·최대 반복 횟수·최대 시간**으로 묶어 무한 반복을 막으세요. worker 와 verifier 는 서로 다른 동료(가능하면 다른 계열)로 두어야 서로의 맹점을 잡습니다.
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
        if !rest.isEmpty { RLog.log("ASK 세션이 끝나 기다리던 요청 \(rest.count)건을 접었습니다") }
        rest.values.forEach { $0("riven: request cancelled (the pane's session ended)") }
        let ids = Array(rest.keys)
        DispatchQueue.main.async { [weak self] in
            ids.forEach { self?.onExpire?($0, t("chat.expired.session")) }
        }
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
        onTool?(id, tool, args, o["cwd"] as? String)
        if sem.wait(timeout: .now() + Self.timeout) == .timedOut {
            lock.lock(); pending.removeValue(forKey: id); lock.unlock()
            result = "riven: timed out waiting for the user (no answer in \(Int(Self.timeout))s)"
            RLog.log("ASK 시간 초과로 요청을 접었습니다 (\(Int(Self.timeout))초) tool=\(tool)")
            DispatchQueue.main.async { [weak self] in
                self?.onExpire?(id, t("chat.expired.timeout", ["m": String(Int(Self.timeout) / 60)]))
            }
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

    /// 벤치용: 릴레이를 거치지 않고 같은 경로로 도구를 부른다.
    func debugTool(tool: String, args: [String: Any], cwd: String) {
        onTool?(UUID().uuidString, tool, args, cwd)
    }

    private func writeServer() -> Bool {
        let py = #"""
        #!/usr/bin/env python3
        import sys, json, socket, threading, os
        SOCK = sys.argv[1]
        _out = threading.Lock()
        def send(m):
            with _out:
                sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
        def call(tool, args):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(SOCK)
            # 어느 워크스페이스에서 부른 것인지. riven 은 이 값으로 그 프로젝트의 패널을
            # 찾는다 — 사용자가 지금 다른 워크스페이스를 보고 있어도 남의 화면을 건드리지 않게.
            s.sendall((json.dumps({"tool": tool, "args": args, "cwd": os.getcwd()}) + "\n").encode())
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
             "description": "Open a URL in riven's browser panel so the user can see it. Same as riven_browser_open.",
             "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
            {"name": "riven_screenshot",
             "description": "Capture the browser panel (optionally navigating first). Returns a PNG file path; read it with the Read tool to see the page.",
             "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}}},
            {"name": "riven_browser_open",
             "description": "Open a URL in riven's browser panel. Set new_tab=true to keep the current page. The panel keeps cookies/session, so a page you logged into stays logged in. Pass profile (e.g. \"A\") to use a SEPARATE login — that lets you be signed into the same site as two different accounts at once; a profile always opens a new tab.",
             "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}, "new_tab": {"type": "boolean"}, "profile": {"type": "string"}}, "required": ["url"]}},
            {"name": "riven_browser_tab",
             "description": "Switch to or close a browser tab by index (see the tabs list in riven_browser_state). action: select | close.",
             "inputSchema": {"type": "object", "properties": {"action": {"type": "string"}, "index": {"type": "number"}}, "required": ["action"]}},
            {"name": "riven_browser_state",
             "description": "Current browser state: URL, page title, loading, back/forward availability, zoom and the open tabs. Call this after navigating to confirm where you are.",
             "inputSchema": {"type": "object", "properties": {}}},
            {"name": "riven_browser_go",
             "description": "History/loading control for the browser panel. action: back | forward | reload | stop.",
             "inputSchema": {"type": "object", "properties": {"action": {"type": "string"}}, "required": ["action"]}},
            {"name": "riven_browser_read",
             "description": "Read the current page. Without a selector you get the whole page's visible text; with a CSS selector you get just that element. Set html=true for markup instead of text. Long output is truncated.",
             "inputSchema": {"type": "object", "properties": {"selector": {"type": "string"}, "html": {"type": "boolean"}}}},
            {"name": "riven_browser_click",
             "description": "Click the first element matching a CSS selector in the browser panel (scrolls it into view first).",
             "inputSchema": {"type": "object", "properties": {"selector": {"type": "string"}}, "required": ["selector"]}},
            {"name": "riven_browser_fill",
             "description": "Type a value into an input/textarea/select matching a CSS selector, firing input+change events so frameworks notice. Set submit=true to submit the surrounding form.",
             "inputSchema": {"type": "object", "properties": {"selector": {"type": "string"}, "value": {"type": "string"}, "submit": {"type": "boolean"}}, "required": ["selector", "value"]}},
            {"name": "riven_browser_wait",
             "description": "Wait until a CSS selector matches something (for pages that render after load). timeout_ms defaults to 5000, max 60000.",
             "inputSchema": {"type": "object", "properties": {"selector": {"type": "string"}, "timeout_ms": {"type": "number"}}, "required": ["selector"]}},
            {"name": "riven_browser_scroll",
             "description": "Scroll the page: pass a selector to scroll that element into view, y for an absolute position, or neither to jump to the bottom.",
             "inputSchema": {"type": "object", "properties": {"selector": {"type": "string"}, "y": {"type": "number"}}}},
            {"name": "riven_browser_eval",
             "description": "Run JavaScript in the current page and return its value. Prefer the specific tools above; use this only when they cannot express what you need. The user is asked to approve each page, because the browser holds real logged-in sessions.",
             "inputSchema": {"type": "object", "properties": {"js": {"type": "string"}}, "required": ["js"]}},
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
             "description": "Delegate work to ANOTHER agent pane. `agent` is a role name, pane id or panel title from riven_agents. The message appears in that agent's conversation. By default this WAITS for the reply and returns it. Pass wait=false for long jobs: the call returns immediately and the answer is delivered into your conversation when it arrives, so you can keep working meanwhile.",
             "inputSchema": {"type": "object", "properties": {"agent": {"type": "string"}, "message": {"type": "string"}, "wait": {"type": "boolean"}}, "required": ["agent", "message"]}},
            {"name": "riven_ask_agents",
             "description": "Delegate to SEVERAL agents AT ONCE. Every task starts immediately and they run in parallel, so prefer this over calling riven_ask_agent repeatedly when the work is independent. By default it waits and returns every answer; pass wait=false to return at once and have each answer delivered into your conversation as it lands.",
             "inputSchema": {"type": "object", "properties": {"tasks": {"type": "array", "items": {"type": "object", "properties": {"agent": {"type": "string"}, "message": {"type": "string"}}, "required": ["agent", "message"]}}, "wait": {"type": "boolean"}}, "required": ["tasks"]}},
            {"name": "riven_group_add_agent",
             "description": "Add one more agent to an existing agent group and open its pane. Give the group name, the new agent's nickname, and optionally a persona (.claude/agents name), a model alias (opus/sonnet/haiku/fable) and who it reports to.",
             "inputSchema": {"type": "object", "properties": {"group": {"type": "string"}, "name": {"type": "string"}, "persona": {"type": "string"}, "model": {"type": "string"}, "parent": {"type": "string"}}, "required": ["group", "name"]}},
            {"name": "riven_group_remove_agent",
             "description": "Remove an agent from a group: its pane is closed and it is dropped from the roster. DESTRUCTIVE - riven always asks the user to confirm first, and the tool returns whether they agreed.",
             "inputSchema": {"type": "object", "properties": {"group": {"type": "string"}, "name": {"type": "string"}}, "required": ["group", "name"]}},
            {"name": "riven_group_delete",
             "description": "Delete a whole agent group: every member's turn is stopped, all its panes are closed and its saved roster is erased. DESTRUCTIVE - riven always asks the user to confirm first, and the tool returns whether they agreed.",
             "inputSchema": {"type": "object", "properties": {"group": {"type": "string"}}, "required": ["group"]}},
            {"name": "riven_workspaces",
             "description": "List open workspaces (folders) and which one is active.",
             "inputSchema": {"type": "object", "properties": {}}},
            {"name": "riven_open_workspace",
             "description": "Open/switch to a workspace folder by path.",
             "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
            {"name": "riven_note_list",
             "description": "List the user's markdown notes in riven's Notes panel, and the .md docs in the workspace. Returns title, path and when each was last changed.",
             "inputSchema": {"type": "object", "properties": {"scope": {"type": "string", "enum": ["notes", "docs", "all"]}}}},
            {"name": "riven_note_read",
             "description": "Read one note or workspace .md doc as markdown. `note` is a title, file name or absolute path (from riven_note_list).",
             "inputSchema": {"type": "object", "properties": {"note": {"type": "string"}}, "required": ["note"]}},
            {"name": "riven_note_write",
             "description": "Write a SCRATCH note (riven's Notes panel, NOT a file in the repo) so the user can see it. Creates a new note, or replaces `note` if given (the previous version is kept and the user can undo it from the panel). Use this for working notes and summaries you do not want committed. If the user asks you to DOCUMENT something or to write a doc/README/spec, use riven_doc_write instead so the file lands in the repository.",
             "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}, "body": {"type": "string"}, "note": {"type": "string"}}, "required": ["title", "body"]}},
            {"name": "riven_note_append",
             "description": "Append markdown to the end of an existing note (nothing is overwritten). Good for running logs.",
             "inputSchema": {"type": "object", "properties": {"note": {"type": "string"}, "body": {"type": "string"}}, "required": ["note", "body"]}},
            {"name": "riven_doc_write",
             "description": "Write a markdown DOCUMENT as a real file in the workspace (repo), e.g. docs/plan.md or README.md, and open it in riven so the user sees it. This is what to use when asked to document something. Refuses to clobber an existing file unless overwrite is true, and never writes outside the workspace.",
             "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "body": {"type": "string"}, "overwrite": {"type": "boolean"}}, "required": ["path", "body"]}},
            {"name": "riven_note_save_file",
             "description": "Save a note as a real .md file in the workspace (e.g. docs/plan.md). Refuses to clobber an existing file unless overwrite is true.",
             "inputSchema": {"type": "object", "properties": {"note": {"type": "string"}, "path": {"type": "string"}, "overwrite": {"type": "boolean"}}, "required": ["note", "path"]}},
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
