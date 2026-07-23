import Foundation

// A minimal LSP client: spawns a language server, speaks Content-Length framed
// JSON-RPC over stdio, and correlates requests/responses by id. Mirrors riven's
// lsp.ts (typescript-language-server etc.), but native.
final class LSPClient {
    private let proc = Process()
    private let inPipe = Pipe()
    private let outPipe = Pipe()
    private var buffer = Data()
    private var nextId = 1
    private var pending: [Int: (Result<Any, Error>) -> Void] = [:]
    private let queue = DispatchQueue(label: "lsp.client")
    private var initialized = false
    private var openDocs = Set<String>()

    var onDiagnostics: ((_ uri: String, _ diags: [[String: Any]]) -> Void)?
    let rootPath: String

    init?(command: String, args: [String], rootPath: String, env: [String: String] = [:]) {
        self.rootPath = rootPath
        proc.executableURL = URL(fileURLWithPath: command)
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: rootPath)
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice   // tsserver logs to stderr; an unread pipe fills → server hangs
        var e = ProcessInfo.processInfo.environment
        for (k, v) in env { e[k] = v }
        proc.environment = e
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { return }
            self?.queue.async { self?.feed(d) }
        }
        do { try proc.run() } catch { return nil }
        handshake()
    }

    func stop() {
        send(notif: "exit", params: [:])
        outPipe.fileHandleForReading.readabilityHandler = nil   // drop the lingering read source
        proc.terminate()
    }

    // ---- framing ----
    private func write(_ obj: [String: Any]) {
        guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var msg = Data("Content-Length: \(body.count)\r\n\r\n".utf8)
        msg.append(body)
        inPipe.fileHandleForWriting.write(msg)
    }

    private func feed(_ data: Data) {
        buffer.append(data)
        while true {
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return }
            let header = String(data: buffer.subdata(in: 0..<headerEnd.lowerBound), encoding: .utf8) ?? ""
            guard let lenLine = header.split(separator: "\r\n").first(where: { $0.hasPrefix("Content-Length:") }),
                  let len = Int(lenLine.dropFirst("Content-Length:".count).trimmingCharacters(in: .whitespaces))
            else { return }
            let bodyStart = headerEnd.upperBound
            guard buffer.count >= bodyStart + len else { return }
            let body = buffer.subdata(in: bodyStart..<(bodyStart + len))
            buffer.removeSubrange(0..<(bodyStart + len))
            if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                handle(json)
            }
        }
    }

    private func handle(_ msg: [String: Any]) {
        if let id = msg["id"] as? Int, let cb = pending[id] {
            pending[id] = nil
            if let err = msg["error"] { cb(.failure(NSError(domain: "lsp", code: 0, userInfo: ["e": err]))) }
            else { cb(.success(msg["result"] ?? NSNull())) }
        } else if let method = msg["method"] as? String {
            if method == "textDocument/publishDiagnostics",
               let params = msg["params"] as? [String: Any],
               let uri = params["uri"] as? String,
               let diags = params["diagnostics"] as? [[String: Any]] {
                DispatchQueue.main.async { self.onDiagnostics?(uri, diags) }
            }
        }
    }

    // ---- requests / notifications ----
    private func request(_ method: String, _ params: Any, _ cb: @escaping (Result<Any, Error>) -> Void) {
        queue.async {
            let id = self.nextId; self.nextId += 1
            self.pending[id] = cb
            self.write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        }
    }
    private func send(notif: String, params: Any) {
        queue.async { self.write(["jsonrpc": "2.0", "method": notif, "params": params]) }
    }

    private func handshake() {
        let params: [String: Any] = [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "rootUri": "file://\(rootPath)",
            "capabilities": [
                "textDocument": [
                    "synchronization": ["didSave": true, "dynamicRegistration": false],
                    "completion": ["completionItem": ["snippetSupport": true]],
                    "hover": ["contentFormat": ["markdown", "plaintext"]],
                    "definition": ["dynamicRegistration": false],
                    "publishDiagnostics": ["relatedInformation": true]
                ]
            ]
        ]
        request("initialize", params) { [weak self] _ in
            self?.send(notif: "initialized", params: [:])
            self?.initialized = true
        }
    }

    // ---- document sync ----
    func didOpen(uri: String, languageId: String, text: String) {
        guard !openDocs.contains(uri) else { return }
        openDocs.insert(uri)
        send(notif: "textDocument/didOpen", params: ["textDocument": [
            "uri": uri, "languageId": languageId, "version": 1, "text": text]])
    }
    func didChange(uri: String, version: Int, text: String) {
        send(notif: "textDocument/didChange", params: [
            "textDocument": ["uri": uri, "version": version],
            "contentChanges": [["text": text]]])
    }

    // ---- features ----
    func completion(uri: String, line: Int, char: Int, _ cb: @escaping (Any?) -> Void) {
        request("textDocument/completion", tdpp(uri, line, char)) { cb(try? $0.get()) }
    }
    func hover(uri: String, line: Int, char: Int, _ cb: @escaping (Any?) -> Void) {
        request("textDocument/hover", tdpp(uri, line, char)) { cb(try? $0.get()) }
    }
    func definition(uri: String, line: Int, char: Int, _ cb: @escaping (Any?) -> Void) {
        request("textDocument/definition", tdpp(uri, line, char)) { cb(try? $0.get()) }
    }
    // Find-all-references (includes the declaration + every usage, e.g. imports).
    func references(uri: String, line: Int, char: Int, _ cb: @escaping (Any?) -> Void) {
        var p = tdpp(uri, line, char)
        p["context"] = ["includeDeclaration": true]
        request("textDocument/references", p) { cb(try? $0.get()) }
    }
    private func tdpp(_ uri: String, _ line: Int, _ char: Int) -> [String: Any] {
        ["textDocument": ["uri": uri], "position": ["line": line, "character": char]]
    }
}
