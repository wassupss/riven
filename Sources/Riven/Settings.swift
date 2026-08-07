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
        let dir = AppPaths.supportDir
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
    func double(_ key: String, _ def: Double) -> Double {
        read { (dict[key] as? Double) ?? (dict[key] as? Int).map(Double.init) ?? def }
    }
    func object(_ key: String) -> [String: Any]? { read { dict[key] as? [String: Any] } }

    // In-memory update is immediate; the DISK write is coalesced. set() used to serialize the whole
    // settings dictionary and write it synchronously on every call — and divider drags call it on
    // every frame (sidebar width / rail height), so resizing a panel stuttered against the disk.
    // Readers see the new value at once; the file catches up within a runloop turn.
    private var flushScheduled = false
    /// 접두사로 시작하는 키들 (에이전트 그룹 명단처럼 키에 이름이 들어가는 경우).
    func keys(prefix: String) -> [String] {
        read { dict.keys.filter { $0.hasPrefix(prefix) }.sorted() }
    }

    /// 키를 지운다 (그룹 삭제처럼 저장한 것도 같이 없애야 할 때).
    func remove(_ key: String) {
        lock.lock()
        dict.removeValue(forKey: key)
        lock.unlock()
        scheduleFlush()
        NotificationCenter.default.post(name: .rivenSettingChanged, object: key)
    }

    /// 설정만 기본값으로. 세션(열린 탭·대화)·설치 식별자처럼 "설정" 이 아닌 것은 남긴다 —
    /// "설정 초기화" 로 작업까지 날리면 그건 초기화가 아니라 사고다.
    func resetPreferences() {
        let keep: Set<String> = ["session", "installId", "crashNoticeShown",
                                 "browserTabs", "browserZooms", "browserActiveTab",
                                 "api.environments", "api.activeEnv",
                                 "sidebarWidth", "railHeight", "railCollapsed"]
        lock.lock()
        let doomed = dict.keys.filter { !keep.contains($0) }
        for k in doomed { dict.removeValue(forKey: k) }
        lock.unlock()
        scheduleFlush()
        for k in doomed { NotificationCenter.default.post(name: .rivenSettingChanged, object: k) }
    }

    func set(_ key: String, _ value: Any) {
        lock.lock()
        dict[key] = value
        lock.unlock()
        scheduleFlush()
        NotificationCenter.default.post(name: .rivenSettingChanged, object: key)
    }
    private func scheduleFlush() {
        lock.lock(); let already = flushScheduled; flushScheduled = true; lock.unlock()
        guard !already else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.flush() }
    }
    /// Write the settings file.
    ///
    /// `sync: true` (quit) writes on the CALLING thread: an async write scheduled at termination
    /// never ran — the process exited first — and left a 0-byte settings file, i.e. the whole
    /// session (workspaces, layouts, tabs) gone. The write is also ATOMIC, so an interrupted write
    /// can never truncate the existing file.
    func flush(sync: Bool = false) {
        lock.lock()
        flushScheduled = false
        let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted])
        let dest = url
        lock.unlock()
        guard let data, !data.isEmpty else { return }
        if sync { try? data.write(to: dest, options: .atomic); return }
        DispatchQueue.global(qos: .utility).async { try? data.write(to: dest, options: .atomic) }
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
