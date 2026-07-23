import Foundation

// Resolves + owns one LSP client per server key for a workspace (mirrors riven's
// lsp.ts SPECS). Currently wires TypeScript (ts/tsx/js/jsx); more servers plug in
// the same way. Resolves the server binary from PATH or riven's node_modules.
final class LSPManager {
    static let shared = LSPManager()
    private var clients: [String: LSPClient] = [:]      // serverKey -> client
    var onDiagnostics: ((_ uri: String, _ diags: [[String: Any]]) -> Void)?

    // language id (Monaco) -> server key
    private static let langToServer: [String: String] = [
        "typescript": "typescript", "tsx": "typescript",
        "javascript": "typescript", "jsx": "typescript"
    ]

    func serverKey(for languageId: String) -> String? { Self.langToServer[languageId] }

    // Get-or-start the client for a language in a workspace root.
    func client(languageId: String, rootPath: String) -> LSPClient? {
        guard let key = serverKey(for: languageId) else { return nil }
        let id = "\(key)|\(rootPath)"
        if let c = clients[id] { return c }
        guard let spec = resolve(key, rootPath: rootPath) else { return nil }
        let c = LSPClient(command: spec.command, args: spec.args, rootPath: rootPath, env: spec.env)
        c?.onDiagnostics = { [weak self] uri, diags in self?.onDiagnostics?(uri, diags) }
        clients[id] = c
        return c
    }

    func stopAll() { clients.values.forEach { $0.stop() }; clients.removeAll() }

    private struct Spec { let command: String; let args: [String]; let env: [String: String] }

    private func resolve(_ key: String, rootPath: String) -> Spec? {
        switch key {
        case "typescript":
            // Prefer a PATH server; fall back to riven's bundled one via node.
            if let bin = which("typescript-language-server") {
                return Spec(command: bin, args: ["--stdio"], env: [:])
            }
            // Fallback: locate a GLOBALLY-installed typescript-language-server (any
            // machine) and run its cli.mjs via node — NOT a hardcoded dev path.
            guard let node = findNode() else { return nil }
            if let cli = findGlobalModuleCLI("typescript-language-server/lib/cli.mjs") {
                return Spec(command: node, args: [cli, "--stdio"], env: [:])
            }
            return nil
        default: return nil
        }
    }

    // Find an absolute node path (a GUI app's PATH lacks nvm/homebrew dirs).
    private func findNode() -> String? {
        if let n = which("node") { return n }
        let fm = FileManager.default
        // nvm: newest version under ~/.nvm/versions/node/*/bin/node
        let nvm = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
        if let vers = try? fm.contentsOfDirectory(atPath: nvm.path).sorted(by: >) {
            for v in vers {
                let p = nvm.appendingPathComponent("\(v)/bin/node").path
                if fm.isExecutableFile(atPath: p) { return p }
            }
        }
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if fm.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    // Run a command in an interactive login shell (loads the user's real PATH: nvm,
    // homebrew, volta…) and return trimmed stdout. stdin → /dev/null so the interactive
    // shell isn't stopped by SIGTTIN.
    private func login(_ cmd: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-ilc", cmd]
        p.standardInput = FileHandle.nullDevice
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        p.waitUntilExit()
        return (out?.isEmpty == false) ? out : nil
    }
    private func which(_ cmd: String) -> String? {
        let out = login("command -v \(cmd)")
        return out?.hasPrefix("/") == true ? out : nil
    }

    // Find a module's entry file across the common GLOBAL node_modules roots (npm -g,
    // homebrew, nvm, custom prefix) — machine-independent, no hardcoded user path.
    private func findGlobalModuleCLI(_ rel: String) -> String? {
        let fm = FileManager.default
        var roots: [String] = []
        if let r = login("npm root -g"), r.hasPrefix("/") { roots.append(r) }
        roots += ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules",
                  fm.homeDirectoryForCurrentUser.appendingPathComponent(".npm-global/lib/node_modules").path]
        let nvm = fm.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
        if let vers = try? fm.contentsOfDirectory(atPath: nvm.path).sorted(by: >) {
            for v in vers { roots.append(nvm.appendingPathComponent("\(v)/lib/node_modules").path) }
        }
        for root in roots {
            let p = (root as NSString).appendingPathComponent(rel)
            if fm.fileExists(atPath: p) { return p }
        }
        return nil
    }
}
