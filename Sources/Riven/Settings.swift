import Foundation

// Persistent app settings (own file), with sensible defaults. AIProvider and the
// editor/terminal read these. Mirrors the subset of riven's settings that matter
// for the native app so far.
final class Settings {
    static let shared = Settings()
    private let url: URL
    private var dict: [String: Any]
    // `dict` is read on the main thread and read/written on the Supabase sync path;
    // Swift Dictionary isn't thread-safe, so all access goes through this lock.
    private let lock = NSLock()

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

    private func read<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    func string(_ key: String, _ def: String) -> String { read { dict[key] as? String ?? def } }
    func bool(_ key: String, _ def: Bool) -> Bool { read { dict[key] as? Bool ?? def } }
    func int(_ key: String, _ def: Int) -> Int { read { dict[key] as? Int ?? def } }
    func object(_ key: String) -> [String: Any]? { read { dict[key] as? [String: Any] } }

    func set(_ key: String, _ value: Any) {
        lock.lock()
        dict[key] = value
        let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted])
        lock.unlock()
        if let data { try? data.write(to: url) }
        NotificationCenter.default.post(name: .rivenSettingChanged, object: key)
    }

    // A JSON-safe copy of all settings minus the given keys (used for cloud sync —
    // sensitive/local keys like the AI API key + session are excluded by the caller).
    func syncableSnapshot(excluding: Set<String>) -> [String: Any] {
        read {
            var out: [String: Any] = [:]
            for (k, v) in dict where !excluding.contains(k) { out[k] = v }
            return out
        }
    }
}
