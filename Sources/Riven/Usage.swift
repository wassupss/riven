import Foundation
import Security

// Local Claude Code usage — a native port of riven's usage:today. Walks
// ~/.claude/projects/**/*.jsonl session logs, sums today's tokens + estimated
// cost per model (deduped by message id), matching riven's status-bar widget.
enum Usage {
    struct Model { let name: String; var input = 0; var output = 0; var cacheWrite = 0; var cacheRead = 0; var cost = 0.0 }
    struct Today { let totalCost: Double; let totalTokens: Int; let perModel: [Model] }

    // Per-1M-token USD rates (riven's fallback pricing) by model family.
    private static func rates(_ model: String) -> (i: Double, o: Double, cw: Double, cr: Double) {
        let m = model.lowercased()
        if m.contains("opus") { return (15, 75, 18.75, 1.5) }
        if m.contains("haiku") { return (0.8, 4, 1.0, 0.08) }
        return (3, 15, 3.75, 0.3)   // sonnet / default
    }

    // ---- cost controls (see today()) -----------------------------------------
    // These session logs are BIG (a single active transcript can exceed 100 MB) and this
    // ran every 60s, re-reading + JSON-parsing all of them: ~170 MB of text and ~45k
    // JSON objects per poll, which is what pushed the Swift heap up hundreds of MB at
    // idle (millions of live CFString/NSDictionary). Two bounds fix it:
    //  1. Skip the work entirely when no log file changed (size+mtime signature).
    //  2. Parse each file INCREMENTALLY: these logs are append-only, so after the first
    //     pass only the newly appended bytes are read+parsed (a poll during an active
    //     session costs a few KB instead of 169 MB). Per-file running totals are kept and
    //     summed; they reset when the day rolls over or a file is truncated/replaced.
    //     The FIRST pass over a file is capped to a tail window so a 100 MB+ transcript
    //     can't spike the heap at launch.
    private static let firstPassTailBytes = 16 * 1024 * 1024
    private static var cachedSignature = ""
    private static var cachedToday = Today(totalCost: 0, totalTokens: 0, perModel: [])

    // Per-file running totals for today, plus how far we've parsed.
    private struct FileState {
        var parsedTo: Int           // byte offset already accounted for
        var day: Date               // startOfDay these totals belong to
        var models: [String: Model] = [:]
        var seen: Set<String> = []
    }
    private static var fileStates: [String: FileState] = [:]

    // Read bytes [from, ∞) of a file. `from == nil` means "the last firstPassTailBytes".
    // Returns the text plus the offset it actually starts at.
    private static func read(_ url: URL, from: Int?) -> (text: String, start: Int)? {
        guard let fh = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? fh.close() }
        guard let end = try? fh.seekToEnd() else { return nil }
        var start = UInt64(from ?? 0)
        var trimPartial = false
        if from == nil, end > UInt64(firstPassTailBytes) {
            start = end - UInt64(firstPassTailBytes); trimPartial = true
        }
        guard start <= end else { return nil }
        try? fh.seek(toOffset: start)
        guard let data = try? fh.readToEnd(), var s = String(data: data, encoding: .utf8) else { return nil }
        // A tail window can begin mid-line; drop that partial first line.
        if trimPartial, let nl = s.firstIndex(of: "\n") { s = String(s[s.index(after: nl)...]) }
        return (s, Int(start))
    }

    static func today() -> Today {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let root = (ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) }
                    ?? home.appendingPathComponent(".claude")).appendingPathComponent("projects")
        guard let en = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]) else {
            return Today(totalCost: 0, totalTokens: 0, perModel: [])
        }
        let cal = Calendar.current
        let cutoff = Date().addingTimeInterval(-36 * 3600)   // only recent files

        // Collect the candidate logs first (newest last-modified first, so the budget is
        // spent on the sessions that actually carry today's activity).
        var candidates: [(url: URL, mod: Date, size: Int)] = []
        for case let url as URL in en {
            guard url.pathExtension == "jsonl", candidates.count < 4000 else { continue }
            let vals = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            guard let mod = vals?.contentModificationDate, mod >= cutoff else { continue }
            candidates.append((url, mod, vals?.fileSize ?? 0))
        }
        candidates.sort { $0.mod > $1.mod }

        // Nothing changed since the last poll → reuse the previous result and parse nothing.
        let signature = candidates.map { "\($0.url.path):\($0.size):\($0.mod.timeIntervalSince1970)" }.joined(separator: "|")
        if signature == cachedSignature { return cachedToday }

        let today0 = cal.startOfDay(for: Date())
        var live = Set<String>()

        for c in candidates {
            let key = c.url.path
            live.insert(key)
            var st = fileStates[key]
            // Restart this file's totals on a new day, or if it shrank (truncated/replaced).
            if st == nil || st!.day != today0 || c.size < st!.parsedTo {
                st = FileState(parsedTo: 0, day: today0)
                st!.parsedTo = -1                 // sentinel: first pass reads a tail window
            } else if c.size == st!.parsedTo {
                fileStates[key] = st              // unchanged → keep its running totals
                continue
            }
            let from: Int? = st!.parsedTo < 0 ? nil : st!.parsedTo
            guard let chunk = read(c.url, from: from) else { fileStates[key] = st; continue }
            st!.parsedTo = c.size

            for line in chunk.text.split(separator: "\n") {
                guard let ld = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: ld) as? [String: Any] else { continue }
                // Today only (local), by top-level timestamp. NOTE: the formatters are
                // cached statics — creating an ISO8601DateFormatter per line (thousands
                // of lines × thousands of files) pegged a whole core for seconds.
                guard let ts = obj["timestamp"] as? String,
                      let date = Usage.isoFrac.date(from: ts) ?? Usage.isoPlain.date(from: ts),
                      cal.isDateInToday(date) else { continue }
                guard let msg = obj["message"] as? [String: Any],
                      let usage = msg["usage"] as? [String: Any] else { continue }
                // Dedupe by message id / requestId (per file — ids are session-scoped).
                let id = (msg["id"] as? String) ?? (obj["requestId"] as? String) ?? UUID().uuidString
                if st!.seen.contains(id) { continue }
                st!.seen.insert(id)
                let model = (msg["model"] as? String) ?? "claude"
                var m = st!.models[model] ?? Model(name: model)
                let inTok = usage["input_tokens"] as? Int ?? 0
                let outTok = usage["output_tokens"] as? Int ?? 0
                let cw = usage["cache_creation_input_tokens"] as? Int ?? 0
                let cr = usage["cache_read_input_tokens"] as? Int ?? 0
                m.input += inTok; m.output += outTok; m.cacheWrite += cw; m.cacheRead += cr
                if let cost = obj["costUSD"] as? Double { m.cost += cost }
                else {
                    let r = rates(model)
                    m.cost += Double(inTok)/1e6*r.i + Double(outTok)/1e6*r.o + Double(cw)/1e6*r.cw + Double(cr)/1e6*r.cr
                }
                st!.models[model] = m
            }
            fileStates[key] = st
        }
        // Drop state for logs that aged out of the window (keeps the map bounded).
        fileStates = fileStates.filter { live.contains($0.key) }

        // Sum the per-file running totals.
        var models: [String: Model] = [:]
        for (_, st) in fileStates {
            for (name, fm) in st.models {
                var m = models[name] ?? Model(name: name)
                m.input += fm.input; m.output += fm.output
                m.cacheWrite += fm.cacheWrite; m.cacheRead += fm.cacheRead; m.cost += fm.cost
                models[name] = m
            }
        }
        let per = models.values.sorted { $0.cost > $1.cost }
        let totalCost = per.reduce(0) { $0 + $1.cost }
        let totalTokens = per.reduce(0) { $0 + $1.input + $1.output + $1.cacheWrite + $1.cacheRead }
        let result = Today(totalCost: totalCost, totalTokens: totalTokens, perModel: per)
        cachedSignature = signature
        cachedToday = result
        return result
    }

    // Cached formatters — reused across every log line (see today()).
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()

    // Plan limits from the Claude OAuth usage API (riven's "64% · 96%" = session /
    // weekly REMAINING %). Reads the OAuth token from ~/.claude/.credentials.json.
    struct Limits { let sessionRemaining: Int?; let weeklyRemaining: Int?
        var sessionResetsAt: String? = nil; var weeklyResetsAt: String? = nil }
    static func limits(_ completion: @escaping (Limits) -> Void) {
        guard let token = oauthToken() else { completion(Limits(sessionRemaining: nil, weeklyRemaining: nil)); return }
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        // The endpoint rejects requests without a claude-code User-Agent (returns
        // 401/403), which is why the widget was silently falling back to $cost.
        req.setValue("claude-code/2.1.69", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            guard let data,
                  let http = resp as? HTTPURLResponse, http.statusCode == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                completion(Limits(sessionRemaining: nil, weeklyRemaining: nil)); return
            }
            // remaining = 100 - utilization (riven's remaining()).
            func remaining(_ key: String) -> Int? {
                guard let d = obj[key] as? [String: Any],
                      let used = (d["utilization"] as? Double) ?? (d["used_pct"] as? Double) else { return nil }
                return max(0, Int((100 - used).rounded()))
            }
            func resets(_ key: String) -> String? { (obj[key] as? [String: Any])?["resets_at"] as? String }
            completion(Limits(sessionRemaining: remaining("five_hour"), weeklyRemaining: remaining("seven_day"),
                              sessionResetsAt: resets("five_hour"), weeklyResetsAt: resets("seven_day")))
        }.resume()
    }

    // Resolve the token AT MOST ONCE per app session and cache the result (even a
    // failure), so the keychain "allow access" dialog can appear a single time — never
    // again this session, whether the user allowed or denied it. (The repeated prompt
    // came from re-reading the keychain on every 60s poll.)
    private static var cachedToken: String??   // nil = not resolved; .some(nil) = tried, none
    private static func oauthToken() -> String? {
        if let cached = cachedToken { return cached }
        // 1) ~/.claude/.credentials.json (no prompt).
        let cred = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/.credentials.json")
        if let t = tokenFromJSON(try? Data(contentsOf: cred)) { cachedToken = t; return t }
        // 2) macOS keychain — may prompt once; the result (allow or deny) is cached.
        let t = tokenFromJSON(keychainCredentials())
        cachedToken = t
        return t
    }
    private static func keychainCredentials() -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Code-credentials",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }
    private static func tokenFromJSON(_ data: Data?) -> String? {
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let o = obj["claudeAiOauth"] as? [String: Any], let t = o["accessToken"] as? String { return t }
        if let t = obj["accessToken"] as? String { return t }
        return nil
    }
    static func fmtTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n)/1e6) }
        if n >= 1000 { return "\(Int((Double(n)/1000).rounded()))k" }
        return "\(n)"
    }
}
