import Foundation

// Scans the login-shell PATH for installed AI coding agents — the native analogue
// of riven's `cli:list` (src/main/cli.ts). Selecting one opens a terminal running
// that command. Only agents actually on PATH are returned.
enum AgentDiscovery {
    struct Agent { let name: String; let cmd: String; let symbol: String }

    // riven's CANDIDATES (group: 'AI').
    private static let candidates: [(name: String, cmd: String, symbol: String)] = [
        ("Claude Code", "claude", "sparkles"),
        ("Codex", "codex", "chevron.left.forwardslash.chevron.right"),
        ("Aider", "aider", "pencil.and.outline"),
        ("Gemini", "gemini", "diamond"),
        ("opencode", "opencode", "curlybraces"),
        ("Cursor Agent", "cursor-agent", "cursorarrow.rays"),
        ("Ollama", "ollama", "cube")
    ]

    // Available agents, resolved against the login-shell PATH (so nvm/homebrew dirs
    // are included). Cached after the first scan.
    private static var cached: [Agent]?
    static func available() -> [Agent] {
        if let cached { return cached }
        let dirs = shellPathDirs()
        let found = candidates.compactMap { c -> Agent? in
            for d in dirs where FileManager.default.isExecutableFile(atPath: d + "/" + c.cmd) {
                return Agent(name: c.name, cmd: c.cmd, symbol: c.symbol)
            }
            return nil
        }
        cached = found
        return found
    }

    private static func shellPathDirs() -> [String] {
        var path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        // Warm the login-shell PATH (nvm, homebrew) like riven's shellPath.ts.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-ilc", "echo -n $PATH"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
        if (try? p.run()) != nil {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            if let s = String(data: data, encoding: .utf8), !s.isEmpty { path = s }
        }
        var dirs = path.split(separator: ":").map(String.init)
        dirs.append(contentsOf: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"])
        return Array(NSOrderedSet(array: dirs)) as? [String] ?? dirs
    }
}
