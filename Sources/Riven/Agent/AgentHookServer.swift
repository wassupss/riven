import Foundation

// Receives agent lifecycle events from `riven-hook` over a unix domain socket.
//
// WHY a socket rather than polling the terminal: riven used to derive busy/idle by
// dumping every terminal's viewport 3.3×/s (ghostty_surface_read_text), which the
// libghostty docs explicitly warn against — "expensive … shouldn't be called too
// often" — and which leaked ~10 KB per call, ~9 MB/min in a normal session. Hooks
// give the same information as authoritative push events at zero idle cost, and they
// distinguish states screen-scraping never could (waiting on approval vs. working).
//
// WHY unix domain rather than a localhost port: no port allocation or collisions, no
// network exposure, and filesystem permissions ARE the authentication — the socket
// lives in a 0700 directory only this user can traverse.
final class AgentHookServer {
    static let shared = AgentHookServer()
    private init() {}

    /// Delivered on the main queue. Wired by AppDelegate to the pane state machine.
    var onEvent: ((AgentEvent) -> Void)?

    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    // Serial: keeps events in the order the agent emitted them (UserPromptSubmit must
    // not overtake the Stop of the previous turn). Reads are sub-millisecond, and a
    // stalled client is bounded by the receive timeout below.
    private let queue = DispatchQueue(label: "com.riven.hooks")

    private static let maxLine = 256 * 1024      // matches riven-hook's payload cap
    private static let recvTimeoutMs = 250

    /// Path the app listens on and `riven-hook` connects to. Also injected into every
    /// terminal surface as RIVEN_HOOK_SOCKET so the helper needn't recompute it.
    static var socketPath: String {
        supportDir.appendingPathComponent("hooks.sock").path
    }
    static var supportDir: URL { AppPaths.supportDir }
    /// Create the support dir if needed AND force it to 0700.
    ///
    /// The chmod is not redundant: createDirectory's `attributes` only apply when it
    /// actually creates the directory. This one is shared with [[RLog]], which gets there
    /// first on almost every launch, so passing 0700 to createDirectory alone left it at
    /// the umask default (observed 0755 in testing).
    @discardableResult
    static func ensureSupportDir() -> URL {
        let dir = supportDir
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        chmod(dir.path, 0o700)
        return dir
    }

    // ---- lifecycle ---------------------------------------------------------
    func start() {
        guard listenFD < 0 else { return }
        let path = Self.socketPath
        // Defence in depth: the socket itself is chmod'd 0600 below, and the directory is
        // forced to 0700 so another local user can't even reach it.
        Self.ensureSupportDir()
        guard reclaim(path) else {
            RLog.log("HOOKS another riven owns \(path) — not starting a second listener")
            return
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { RLog.log("HOOKS socket() failed errno=\(errno)"); return }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        guard Self.setPath(path, on: &addr) else {
            RLog.log("HOOKS socket path too long: \(path)"); close(fd); return
        }
        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(fd, 32) == 0 else {
            RLog.log("HOOKS bind/listen failed errno=\(errno)"); close(fd); return
        }
        // Belt and braces alongside the 0700 dir.
        chmod(path, 0o600)

        listenFD = fd
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in self?.acceptOne() }
        src.setCancelHandler { close(fd) }
        src.resume()
        acceptSource = src
        RLog.log("HOOKS listening on \(path)")
    }

    func stop() {
        acceptSource?.cancel()
        acceptSource = nil
        listenFD = -1
        unlink(Self.socketPath)
    }

    /// Remove a socket file left behind by a crashed instance, but never steal one a
    /// live riven is still serving. The only reliable test is to try connecting: a
    /// refused connection means nothing is accepting, so the inode is ours to replace.
    private func reclaim(_ path: String) -> Bool {
        guard FileManager.default.fileExists(atPath: path) else { return true }
        let probe = socket(AF_UNIX, SOCK_STREAM, 0)
        guard probe >= 0 else { return false }
        defer { close(probe) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        guard Self.setPath(path, on: &addr) else { return false }
        let live = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        } == 0
        if live { return false }
        unlink(path)
        return true
    }

    private static func setPath(_ path: String, on addr: inout sockaddr_un) -> Bool {
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return false }
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
        return true
    }

    // ---- connection handling -----------------------------------------------
    private func acceptOne() {
        let client = accept(listenFD, nil, nil)
        guard client >= 0 else { return }
        defer { close(client) }

        // A well-behaved helper writes one line and closes immediately. The timeout is
        // what stops a hung or hostile client from occupying the serial queue.
        var tv = timeval(tv_sec: 0, tv_usec: Int32(Self.recvTimeoutMs * 1000))
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while buffer.count <= Self.maxLine {
            let n = chunk.withUnsafeMutableBytes { read(client, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }                              // EOF, timeout, or error
            buffer.append(contentsOf: chunk[0..<n])
            if buffer.contains(0x0A) { break }               // got the whole line
        }
        // Over-long input is dropped rather than truncated-and-parsed: a partial JSON
        // object could decode into a misleading event.
        guard buffer.count <= Self.maxLine,
              let nl = buffer.firstIndex(of: 0x0A) else { return }
        let line = buffer[buffer.startIndex..<nl]
        guard let event = AgentEvent.decode(Data(line)) else { return }

        DispatchQueue.main.async { [weak self] in
            // Route only to panes riven actually owns. An unknown UUID means the event
            // came from an agent started outside this riven (or a stale pane), and is
            // silently ignored.
            guard PaneSessionRegistry.shared.pane(for: event.pane) != nil else { return }
            if PaneSessionRegistry.shared.markHookBacked(event.pane) {
                RLog.log("HOOKS pane \(event.pane.prefix(8)) now hook-backed (\(event.agent))")
            }
            self?.onEvent?(event)
        }
    }
}
