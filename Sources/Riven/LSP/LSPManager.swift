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
            guard let node = findNode() else { return nil }   // absolute node path
            let rivenTls = "/Users/songhwaseob/hs-playground/riven/node_modules/typescript-language-server/lib/cli.mjs"
            if FileManager.default.fileExists(atPath: rivenTls) {
                return Spec(command: node, args: [rivenTls, "--stdio"], env: [:])
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

    private func which(_ cmd: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-ilc", "command -v \(cmd)"]   // interactive login: loads nvm
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        p.waitUntilExit()
        return (out?.isEmpty == false && out?.hasPrefix("/") == true) ? out : nil
    }
}
