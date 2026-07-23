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

    // Stop + drop every language server rooted at a workspace (called on workspace close
    // so language servers don't pile up as orphaned node processes).
    func stopClients(rootPath: String) {
        let suffix = "|\(rootPath)"
        for (id, c) in clients where id.hasSuffix(suffix) { c.stop(); clients[id] = nil }
    }

    private struct Spec { let command: String; let args: [String]; let env: [String: String] }

    // Resolution runs `zsh -ilc` (login shell) probes — expensive. Cache the result per
    // server key (INCLUDING nil) so a failed lookup doesn't re-spawn shells on every LSP
    // request (which made go-to-references lag, then appear broken).
    private var specCache: [String: Spec?] = [:]
    private func resolve(_ key: String, rootPath: String) -> Spec? {
        if let cached = specCache[key] { return cached }
        let spec = resolveUncached(key)
        specCache[key] = spec
        return spec
    }
    private func resolveUncached(_ key: String) -> Spec? {
        switch key {
        case "typescript":
            guard let node = findNode() else {
                // No node — a standalone PATH-installed server is the only option.
                if let bin = which("typescript-language-server") {
                    return Spec(command: bin, args: ["--stdio"], env: [:])
                }
                return nil
            }
            // Prefer the server BUNDLED with the app (machine-independent: works with no
            // global/local install, no login-shell probe). `typescript` is bundled beside
            // it so node's module resolution finds the tsserver.
            if let cli = bundledCLI("typescript-language-server/lib/cli.mjs") {
                return Spec(command: node, args: [cli, "--stdio"], env: [:])
            }
            // Then a PATH-installed standalone server, then a global npm install.
            if let bin = which("typescript-language-server") {
                return Spec(command: bin, args: ["--stdio"], env: [:])
            }
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
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
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

    // The entry file for a module bundled inside the app at Resources/lsp/node_modules/…
    // (populated by build-app.sh). `rel` is like "typescript-language-server/lib/cli.mjs".
    private func bundledCLI(_ rel: String) -> String? {
        let file = (rel as NSString).lastPathComponent                          // cli.mjs
        let name = (file as NSString).deletingPathExtension                     // cli
        let ext = (file as NSString).pathExtension                              // mjs
        let dir = "Resources/lsp/node_modules/" + (rel as NSString).deletingLastPathComponent
        return Bundle.riven.url(forResource: name, withExtension: ext, subdirectory: dir)?.path
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
