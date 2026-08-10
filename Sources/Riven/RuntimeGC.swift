import Foundation

// Lifecycle GC for external OS resources that ARC does NOT manage — the per-chat unix sockets
// (chat-tools-<uid>.sock / chat-perm-<uid>.sock) that back each native chat's MCP relay and
// approval hook.
//
// Each ClaudeChatSession's servers unlink their own socket on stop() (the graceful path). But a
// GUI app is force-killed sooner or later — a crash, Force Quit, SIGKILL — and no cleanup code
// runs then. So graceful teardown alone leaks: every crash/kill leaves that run's chat sockets
// behind, and nothing ever reclaims them (hundreds accumulated over days here).
//
// The fix is two-sided: teardown on quit (see AppDelegate.teardownAllChats), and this sweep on
// startup to reclaim whatever a previous crash left. A socket is DEAD when nothing is listening
// (connect fails) — those are safe to remove. A live one (an orphan still holding it) refuses
// deletion by simply being kept. On ANY uncertainty we keep the file, never delete on doubt.
enum RuntimeGC {

    /// Remove stale per-chat sockets left by crashed / force-killed runs. Cheap (a non-blocking
    /// connect probe per file) — run it off the main thread at startup. New chats use fresh
    /// random names, so this never races a socket the current run is about to create.
    static func sweepDeadChatSockets() {
        let dir = AgentHookServer.ensureSupportDir()
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil) else { return }
        var removed = 0
        for url in files where url.pathExtension == "sock" {
            let name = url.lastPathComponent
            // Only the ephemeral per-chat sockets. Never touch hooks.sock (the shared, live agent
            // hooks listener) or anything else.
            guard name.hasPrefix("chat-tools-") || name.hasPrefix("chat-perm-") else { continue }
            guard socketIsDead(url.path) else { continue }   // keep anything that answers / we can't probe
            do { try FileManager.default.removeItem(at: url); removed += 1 } catch { /* leave it */ }
        }
        if removed > 0 { RLog.log("gc: reclaimed \(removed) dead chat socket(s)") }
    }

    /// True ONLY when we can prove no one is listening (connect refused / file gone). Any other
    /// outcome — a listener accepts, or we can't probe — returns false so the caller keeps the file.
    private static func socketIsDead(_ path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }              // can't probe → treat as alive (keep)
        defer { close(fd) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < capacity else { return false }   // too long to probe → keep
        withUnsafeMutablePointer(to: &addr.sun_path.0) { dst in
            path.withCString { strncpy(dst, $0, capacity - 1) }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
        }
        return rc != 0   // connect failed ⇒ no listener ⇒ dead
    }
}
