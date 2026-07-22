import Foundation

// AI code-completion backend, mirroring riven's ai.ts. Reads provider config
// (provider / model / endpoint / api key) and calls the matching HTTP API with
// the code before/after the cursor (FIM-style). Supports ollama, openai, and
// anthropic. The API key is read but never logged.
final class AIProvider {
    static let shared = AIProvider()

    struct Config { let provider: String; let model: String; let endpoint: String; let key: String; let enabled: Bool }

    // Read from the native Settings (falls back to riven's settings.json for the
    // API key, which the native settings UI doesn't edit).
    private func config() -> Config {
        let s = Settings.shared
        var key = ""
        let rivenPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/riven/settings.json")
        if let data = try? Data(contentsOf: rivenPath),
           let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            key = j["aiApiKey"] as? String ?? ""
        }
        let endpoint = s.string("aiCompleteEndpoint", "http://localhost:11434")
        return Config(provider: s.string("aiProvider", "ollama"),
                      model: s.string("aiCompleteModel", "qwen2.5-coder:1.5b"),
                      endpoint: endpoint.replacingOccurrences(of: "/+$", with: "", options: .regularExpression),
                      key: key, enabled: s.bool("aiComplete", false))
    }

    private let sys = "You are a code autocomplete engine. Given the code before and after the cursor, output ONLY the code that should be inserted at the cursor position — no explanation, no markdown fences."

    // Complete at the cursor. prefix = code before, suffix = code after.
    func complete(prefix: String, suffix: String, _ cb: @escaping (String?) -> Void) {
        let c = config()
        guard let req = buildRequest(c, prefix: prefix, suffix: suffix) else { cb(nil); return }
        var request = req.0; let extract = req.1
        request.timeoutInterval = 8
        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data, let json = try? JSONSerialization.jsonObject(with: data) else { cb(nil); return }
            cb(extract(json))
        }.resume()
    }

    private func buildRequest(_ c: Config, prefix: String, suffix: String) -> (URLRequest, (Any) -> String?)? {
        let ep = c.endpoint.isEmpty ? "http://localhost:11434" : c.endpoint
        func post(_ url: String, _ headers: [String: String], _ body: [String: Any]) -> URLRequest? {
            guard let u = URL(string: url) else { return nil }
            var r = URLRequest(url: u); r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
            return r
        }
        let chatUser = "Complete the code at the cursor.\n<before>\n\(prefix)\n</before>\n<after>\n\(suffix)\n</after>"

        switch c.provider {
        case "ollama":
            guard let r = post("\(ep)/api/generate", [:], [
                "model": c.model, "prompt": prefix, "suffix": suffix, "stream": false,
                "options": ["temperature": 0.1, "num_predict": 128, "stop": ["\n\n", "```"]]
            ]) else { return nil }
            return (r, { ($0 as? [String: Any])?["response"] as? String })
        case "anthropic":
            guard let r = post("\(ep)/v1/messages",
                ["x-api-key": c.key, "anthropic-version": "2023-06-01"], [
                "model": c.model, "max_tokens": 128, "system": sys,
                "messages": [["role": "user", "content": chatUser]]
            ]) else { return nil }
            return (r, {
                (($0 as? [String: Any])?["content"] as? [[String: Any]])?.first?["text"] as? String
            })
        default: // openai-chat compatible
            guard let r = post("\(ep)/chat/completions", ["Authorization": "Bearer \(c.key)"], [
                "model": c.model, "max_tokens": 128, "temperature": 0.1,
                "messages": [["role": "system", "content": sys], ["role": "user", "content": chatUser]]
            ]) else { return nil }
            return (r, {
                let choices = ($0 as? [String: Any])?["choices"] as? [[String: Any]]
                let msg = choices?.first?["message"] as? [String: Any]
                return msg?["content"] as? String
            })
        }
    }
}
