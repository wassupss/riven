import Foundation

// Persistent app settings (own file), with sensible defaults. AIProvider and the
// editor/terminal read these. Mirrors the subset of riven's settings that matter
// for the native app so far.
final class Settings {
    static let shared = Settings()
    private let url: URL
    private var dict: [String: Any]

    private init() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/riven-native")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("settings.json")
        if let d = try? Data(contentsOf: url),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            dict = j
        } else {
            dict = [:]
        }
    }

    func string(_ key: String, _ def: String) -> String { dict[key] as? String ?? def }
    func bool(_ key: String, _ def: Bool) -> Bool { dict[key] as? Bool ?? def }
    func int(_ key: String, _ def: Int) -> Int { dict[key] as? Int ?? def }
    func object(_ key: String) -> [String: Any]? { dict[key] as? [String: Any] }

    func set(_ key: String, _ value: Any) {
        dict[key] = value
        if let d = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted]) {
            try? d.write(to: url)
        }
        NotificationCenter.default.post(name: .rivenSettingChanged, object: key)
    }

    // A JSON-safe copy of all settings minus the given keys (used for cloud sync —
    // sensitive/local keys like the AI API key + session are excluded by the caller).
    func syncableSnapshot(excluding: Set<String>) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in dict where !excluding.contains(k) { out[k] = v }
        return out
    }
}
