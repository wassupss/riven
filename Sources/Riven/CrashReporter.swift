import Foundation

// Uploads the last crash to Supabase so crashes on USERS' machines are visible - a local
// log only ever shows crashes on the developer's own machine. The crash handler
// ([[installCrashHandler]]) writes a stack + reason to crash.txt at crash time; this reads
// that on the NEXT launch (safe - never touches the network during a crash) and POSTs it,
// then clears the file. Because it runs on the next launch, a user who already crashed
// reports that crash once when they next open the app.
//
// Opt-out (default on), disclosed on first launch; toggle in Settings ("crashReporting").
// Privacy: the home-directory path is scrubbed to "~" so usernames / project paths don't
// leak, no auth token or account id is sent, and the id is a random per-install UUID.
enum CrashReporter {
    static var enabled: Bool { Settings.shared.bool("crashReporting", true) }

    // A stable, anonymous per-install id - not tied to any account or the machine.
    static var installId: String {
        let existing = Settings.shared.string("installId", "")
        if !existing.isEmpty { return existing }
        let id = UUID().uuidString
        Settings.shared.set("installId", id)
        return id
    }

    // Read crash.txt (if any) and send it. Called once, early, on launch.
    static func reportPending() {
        guard let raw = try? String(contentsOfFile: rivenCrashPath, encoding: .utf8),
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        // If reporting is off (or no backend), leave crash.txt in place - the user can still
        // inspect/send it, and it'll upload if they turn reporting on before the next crash.
        guard enabled, SupabaseConfig.isConfigured,
              let url = URL(string: "\(SupabaseConfig.url)/rest/v1/crash_reports") else { return }

        let scrubbed = String(raw.replacingOccurrences(of: NSHomeDirectory(), with: "~").prefix(20_000))
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(SupabaseConfig.anonKey)", forHTTPHeaderField: "Authorization")  // anon insert
        req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "install_id": installId, "app_version": version, "platform": "macOS", "report": scrubbed,
        ])
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            // Clear ONLY on success, so an offline launch retries next time. A new crash
            // overwrites crash.txt anyway, so at most the latest is ever retried.
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                try? FileManager.default.removeItem(atPath: rivenCrashPath)
            }
        }.resume()
    }
}
