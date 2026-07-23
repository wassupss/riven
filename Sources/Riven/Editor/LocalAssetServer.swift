import Foundation
import Darwin

// A tiny loopback-only HTTP/1.1 server that serves the bundled editor assets
// (editor.html, monaco/, shiki.js, wasm) to the Monaco WKWebView.
//
// Why not loadFileURL or a custom URL scheme? A file:// page has a null/opaque origin,
// so Monaco can't create its Web Workers ("Could not create web worker(s)… might cause
// UI freezes") and runs tokenization/diff/language services on the MAIN THREAD — the
// editor jank. A custom WKURLSchemeHandler gives a real origin and workers DO spawn, but
// WKWebView doesn't route a worker's fetch() through the scheme handler, so Monaco's
// worker can't load its sub-modules. A real http origin on 127.0.0.1 supports the full
// web platform (workers + fetch), fixing the freeze at the root.
//
// Uses a POSIX socket bound to 127.0.0.1:0 (loopback only, OS-assigned port) — never
// reachable off the machine. GET only; serves strictly inside the resource directory.
final class LocalAssetServer {
    static private(set) var shared: LocalAssetServer?
    // Start once (idempotent); returns the base URL like http://127.0.0.1:52345 .
    static func start(base: URL) -> URL? {
        if let s = shared { return s.baseURL }
        guard let s = LocalAssetServer(root: base) else { return nil }
        shared = s
        return s.baseURL
    }

    private let root: URL
    private let fd: Int32
    let baseURL: URL
    private let acceptQueue = DispatchQueue(label: "riven.assetserver.accept")
    private let workQueue = DispatchQueue(label: "riven.assetserver.work", attributes: .concurrent)

    private init?(root: URL) {
        self.root = root.standardizedFileURL
        let s = socket(AF_INET, SOCK_STREAM, 0)
        guard s >= 0 else { RLog.log("assetserver: socket() failed \(errno)"); return nil }
        var yes: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")   // loopback only
        addr.sin_port = 0                                 // OS-assigned free port
        let bindOK = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        } == 0
        guard bindOK, listen(s, 16) == 0 else { RLog.log("assetserver: bind/listen failed \(errno)"); close(s); return nil }
        var bound = sockaddr_in(); var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameOK = withUnsafeMutablePointer(to: &bound) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) }
        } == 0
        let port = UInt16(bigEndian: bound.sin_port)
        guard nameOK, port != 0, let url = URL(string: "http://127.0.0.1:\(port)") else {
            RLog.log("assetserver: getsockname failed"); close(s); return nil
        }
        fd = s
        baseURL = url
        RLog.log("assetserver: serving \(root.path) at \(url.absoluteString)")
        acceptQueue.async { [weak self] in self?.acceptLoop() }
    }

    private func acceptLoop() {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { if errno == EINTR { continue } else { break } }
            var one: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))  // writing to a closed peer must not SIGPIPE-kill the app
            workQueue.async { [weak self] in self?.handle(client) }
        }
    }

    private func handle(_ client: Int32) {
        defer { close(client) }
        // Read the request head (tiny; may arrive in several chunks).
        var req = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while req.range(of: Data("\r\n\r\n".utf8)) == nil {
            let n = read(client, &buf, buf.count)
            if n <= 0 { return }
            req.append(contentsOf: buf[0..<n])
            if req.count > 65536 { return }
        }
        let head = String(data: req, encoding: .utf8) ?? ""
        let firstLine = head.split(whereSeparator: { $0 == "\r" || $0 == "\n" }).first.map(String.init) ?? ""
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET" else { writeResponse(client, "405 Method Not Allowed", Data(), "text/plain"); return }
        var path = String(parts[1])
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        if let h = path.firstIndex(of: "#") { path = String(path[..<h]) }
        path = path.removingPercentEncoding ?? path
        if path.hasPrefix("/") { path.removeFirst() }
        if path.isEmpty { path = "editor.html" }
        let fileURL = root.appendingPathComponent(path).standardizedFileURL
        // Path-traversal guard: never serve outside the resource root.
        guard fileURL.path == root.path || fileURL.path.hasPrefix(root.path + "/"),
              let data = try? Data(contentsOf: fileURL) else {
            writeResponse(client, "404 Not Found", Data(), "text/plain"); return
        }
        writeResponse(client, "200 OK", data, Self.mime(fileURL.pathExtension))
    }

    private func writeResponse(_ client: Int32, _ status: String, _ body: Data, _ contentType: String) {
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        var out = Data(header.utf8); out.append(body)
        out.withUnsafeBytes { raw in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            var off = 0
            while off < out.count {
                let n = write(client, base + off, out.count - off)
                if n <= 0 { break }
                off += n
            }
        }
    }

    private static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs", "cjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "ttf": return "font/ttf"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "png": return "image/png"
        default: return "application/octet-stream"
        }
    }
}
