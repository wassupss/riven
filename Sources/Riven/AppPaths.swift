import Foundation

// The single source of truth for riven's per-user data directory (settings, session
// snapshot, logs, hook socket, the shell shim, cached secrets).
//
// Everything used to hardcode ~/Library/Application Support/riven-native, which meant a
// second riven launched for testing shared the primary install's session file — and its
// restore then relaunched `claude --session-id <id>` for sessions already live in the
// primary, colliding ("Session ID already in use"). Routing every path through here lets
// an isolated instance point at its own directory via RIVEN_DATA_DIR: separate session
// (so nothing is restored), separate socket, separate log — zero interference with a
// running primary. Unset (the normal case) keeps the exact original location.
enum AppPaths {
    static let supportDir: URL = {
        let env = ProcessInfo.processInfo.environment["RIVEN_DATA_DIR"]
        if let env, !env.isEmpty {
            return URL(fileURLWithPath: (env as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/riven-native")
    }()

    /// A file/subdir inside the support dir.
    static func support(_ component: String) -> URL { supportDir.appendingPathComponent(component) }
}
