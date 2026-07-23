import Foundation

// Scans for installed AI coding agents — the native analogue of riven's `cli:list`
// (src/main/cli.ts). Selecting one opens a terminal running that command. Only agents
// actually installed are returned.
//
// A Finder/Dock-launched macOS app inherits a MINIMAL environment: its PATH is just the
// system defaults (`/usr/bin:/bin:/usr/sbin:/sbin`) and does NOT include Homebrew,
// npm/pnpm/yarn/volta/asdf global bins, ~/.local/bin, ~/.cargo/bin, etc. — exactly where
// tools like `codex` (`@openai/codex`), `claude`, `gemini` live. So a naive PATH lookup
// finds nothing even though the CLIs are installed. This mirrors the same class of bug
// that once hid `git` from the app.
//
// We resolve robustly by (1) asking the user's real login shell for each command, and
// (2) scanning a comprehensive set of well-known bin dirs. The resolved `cmd` is the
// ABSOLUTE path, so the agent also *launches* correctly under the app's minimal PATH
// (ghostty inherits our environment, so a bare `codex` would otherwise not be found).
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

    // Available agents, resolved to absolute paths. Cached after the first scan.
    private static var cached: [Agent]?
    static func available() -> [Agent] {
        if let cached { return cached }
        let dirs = searchDirs()
        let shellResolved = resolveViaLoginShell(candidates.map { $0.cmd })
        let found = candidates.compactMap { c -> Agent? in
            if let path = resolve(cmd: c.cmd, dirs: dirs, shellResolved: shellResolved) {
                return Agent(name: c.name, cmd: path, symbol: c.symbol)
            }
            return nil
        }
        cached = found
        return found
    }

    // Absolute path for `cmd`, preferring the login-shell answer (which honors the user's
    // real PATH plus asdf/pyenv/volta shims and shell functions) and falling back to a
    // direct scan of well-known bin dirs.
    private static func resolve(cmd: String, dirs: [String], shellResolved: [String: String]) -> String? {
        if let p = shellResolved[cmd], FileManager.default.isExecutableFile(atPath: p) { return p }
        for d in dirs {
            let p = d + "/" + cmd
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    // Ask the user's real login shell to resolve every candidate in one shot. A GUI app's
    // inherited PATH is minimal, so we run an interactive login shell (`-ilc`) — it sources
    // ~/.zprofile AND ~/.zshrc, picking up nvm/homebrew/pyenv/asdf/volta and the like. We
    // print a `cmd\tpath` line per resolvable command. Best-effort: any failure just leaves
    // the dir scan to cover it.
    private static func resolveViaLoginShell(_ cmds: [String]) -> [String: String] {
        // for c in claude codex ...; do p=$(command -v -- "$c" 2>/dev/null) && printf '%s\t%s\n' "$c" "$p"; done
        let list = cmds.joined(separator: " ")
        let script = "for c in \(list); do p=$(command -v -- \"$c\" 2>/dev/null) && printf '%s\\t%s\\n' \"$c\" \"$p\"; done"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-ilc", script]
        let pipe = Pipe(); p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice   // swallow interactive-shell chatter (unread Pipe would fill+hang)
        p.standardInput = FileHandle.nullDevice   // avoid SIGTTIN when the shell is interactive
        var out = ""
        do {
            try p.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            out = String(data: data, encoding: .utf8) ?? ""
        } catch { return [:] }
        var result: [String: String] = [:]
        for line in out.split(separator: "\n") {
            let parts = line.split(separator: "\t", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let cmd = String(parts[0]).trimmingCharacters(in: .whitespaces)
            let path = String(parts[1]).trimmingCharacters(in: .whitespaces)
            // command -v may return a shell builtin/function name (no slash) — keep only real paths.
            if path.hasPrefix("/") { result[cmd] = path }
        }
        return result
    }

    // Well-known bin dirs to scan directly, so discovery works even if the login shell
    // can't be consulted (unusual shell, sandboxed launch, etc.). Covers Homebrew (arm64 +
    // intel), the system, ~/.local/bin, and the common JS/Rust/Go toolchain global bins.
    private static func searchDirs() -> [String] {
        let home = NSHomeDirectory()
        var dirs: [String] = []

        // Whatever PATH we did inherit (harmless to include; may already hold the answer).
        if let inherited = ProcessInfo.processInfo.environment["PATH"] {
            dirs.append(contentsOf: inherited.split(separator: ":").map(String.init))
        }

        // Homebrew + system.
        dirs.append(contentsOf: [
            "/opt/homebrew/bin", "/opt/homebrew/sbin",   // Apple Silicon
            "/usr/local/bin", "/usr/local/sbin",         // Intel Homebrew / misc
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ])

        // Per-user tool dirs.
        let userRel = [
            ".local/bin",                                  // pipx, standalone installers, codex
            ".cargo/bin",                                  // rust
            ".bun/bin",                                    // bun
            ".deno/bin",                                   // deno
            ".volta/bin",                                  // volta
            ".asdf/shims",                                 // asdf
            ".yarn/bin",                                   // yarn global (classic)
            ".config/yarn/global/node_modules/.bin",       // yarn global (classic, alt)
            ".npm-global/bin", ".npm-packages/bin",        // npm custom prefix
            ".node/bin",
            "Library/pnpm",                                // pnpm (macOS default)
            ".local/share/pnpm",                           // pnpm (XDG)
            "go/bin", ".go/bin",                           // go
            ".pyenv/shims",                                // pyenv
        ]
        dirs.append(contentsOf: userRel.map { home + "/" + $0 })

        // Every nvm-installed node version's bin (nvm doesn't expose a single stable dir).
        let nvmVersions = home + "/.nvm/versions/node"
        if let vers = try? FileManager.default.contentsOfDirectory(atPath: nvmVersions) {
            dirs.append(contentsOf: vers.map { nvmVersions + "/" + $0 + "/bin" })
        }

        // De-dupe, preserve order.
        return Array(NSOrderedSet(array: dirs)) as? [String] ?? dirs
    }
}
