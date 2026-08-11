import Foundation

// Codex 쪽 사용량. [[Usage]] 가 Claude 로그로 하는 일을 Codex 로그로 한다.
//
// 헤더의 "36% · 74%" 는 오랫동안 Claude 것만이었다. Codex 챗이 생기면서 그 숫자는
// 틀린 게 아니라 *일부만 맞는* 것이 됐다 - Codex 로 아무리 돌려도 눈금이 움직이지
// 않으니, 사용자는 한도를 실제보다 넉넉하게 읽게 된다.
//
// 프로세스를 띄우지 않는다. app-server 에 물어보면 계정 정보만 주고 한도는 턴이 돌 때
// 알림으로만 오는데, 같은 값이 Codex 자신의 세션 로그에 남는다:
//
//   ~/.codex/sessions/<yyyy>/<MM>/<dd>/rollout-*.jsonl
//     {"type":"event_msg","payload":{"type":"token_count",
//        "info":{"last_token_usage":{…}}, "rate_limits":{"primary":{"used_percent":12.0,…}}}}
//
// 날짜별 폴더라 "오늘" 만 읽으면 되고, 파일도 세션 하나치라 작다 - Claude 트랜스크립트를
// 증분 파싱해야 했던 사정(100MB+)이 여기엔 없다.
enum CodexUsage {

    struct Limits {
        /// 남은 비율. Codex 는 "쓴 %" 로 주지만 riven 은 남은 쪽으로 통일한다 - 두 CLI 를
        /// 나란히 놓는 화면에서 방향이 다르면 정반대로 읽힌다.
        let remainingPercent: Int
        let windowMinutes: Int
        let resetsAt: Date?
        let planType: String?
    }

    struct Today {
        var totalTokens = 0
        var turns = 0
    }

    private static var cachedSignature = ""
    private static var cachedToday = Today()
    private static var cachedLimits: Limits?

    /// 오늘자 세션 폴더. 없으면 nil (Codex 를 오늘 한 번도 안 썼다).
    private static func todayDir() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let root = (ProcessInfo.processInfo.environment["CODEX_HOME"].map { URL(fileURLWithPath: $0) }
                    ?? home.appendingPathComponent(".codex")).appendingPathComponent("sessions")
        let c = Calendar.current, now = Date()
        let dir = root
            .appendingPathComponent(String(format: "%04d", c.component(.year, from: now)))
            .appendingPathComponent(String(format: "%02d", c.component(.month, from: now)))
            .appendingPathComponent(String(format: "%02d", c.component(.day, from: now)))
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { return nil }
        return dir
    }

    /// 오늘 쓴 토큰 + 마지막으로 알려진 한도. 파일이 그대로면 다시 읽지 않는다.
    @discardableResult
    static func scan() -> (today: Today, limits: Limits?) {
        guard let dir = todayDir(),
              let files = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey])
        else { return (Today(), nil) }

        var candidates: [(url: URL, mod: Date, size: Int)] = []
        for u in files where u.pathExtension == "jsonl" {
            let v = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            candidates.append((u, v?.contentModificationDate ?? .distantPast, v?.fileSize ?? 0))
        }
        candidates.sort { $0.mod < $1.mod }        // 오래된 것부터 → 마지막 한도가 가장 최신
        let signature = candidates.map { "\($0.url.lastPathComponent):\($0.size)" }.joined(separator: "|")
        if signature == cachedSignature { return (cachedToday, cachedLimits) }

        var today = Today()
        var limits: Limits?
        for c in candidates {
            guard let text = try? String(contentsOf: c.url, encoding: .utf8) else { continue }
            for line in text.split(separator: "\n") {
                // 대부분의 줄은 token_count 가 아니다. JSON 을 세우기 전에 값싸게 걸러낸다.
                guard line.contains("token_count"),
                      let d = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                      let payload = obj["payload"] as? [String: Any],
                      payload["type"] as? String == "token_count" else { continue }
                // 턴마다의 사용량은 last_token_usage. total_token_usage 는 세션 누계라
                // 그대로 더하면 턴 수만큼 부풀어 오른다.
                if let info = payload["info"] as? [String: Any],
                   let last = info["last_token_usage"] as? [String: Any] {
                    today.totalTokens += (last["total_tokens"] as? Int)
                        ?? ((last["input_tokens"] as? Int ?? 0) + (last["output_tokens"] as? Int ?? 0))
                    today.turns += 1
                }
                if let rl = payload["rate_limits"] as? [String: Any],
                   let primary = rl["primary"] as? [String: Any],
                   let used = primary["used_percent"] as? Double {
                    let resets = (primary["resets_at"] as? Double).map { Date(timeIntervalSince1970: $0) }
                    limits = Limits(remainingPercent: max(0, min(100, Int((100 - used).rounded()))),
                                    windowMinutes: primary["window_minutes"] as? Int ?? 0,
                                    resetsAt: resets,
                                    planType: rl["plan_type"] as? String)
                }
            }
        }
        cachedSignature = signature
        cachedToday = today
        cachedLimits = limits
        return (today, limits)
    }

    /// 창 길이를 사람 말로 ("30일", "5시간"). 창이 CLI 마다 달라서 숫자만으론 못 읽는다.
    static func windowLabel(_ minutes: Int) -> String {
        if minutes >= 1440 { return t("usage.window.days", ["n": String(minutes / 1440)]) }
        if minutes >= 60 { return t("usage.window.hours", ["n": String(minutes / 60)]) }
        return t("usage.window.mins", ["n": String(minutes)])
    }

    /// 이 폴더에서 돌았던 Codex 대화들 (최근 것부터).
    ///
    /// 각 롤아웃 파일의 첫 줄이 session_meta 이고 거기에 cwd 와 session_id 가 들어 있다.
    /// 그래서 파일을 통째로 읽지 않고 앞부분만 본다 - 대화가 길면 파일이 커진다.
    /// 제목은 첫 user_message 를 쓴다 (Codex 는 요약 제목을 파일에 남기지 않는다).
    static func sessions(cwd: String, limit: Int = 12) -> [(id: String, title: String, date: String)] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let root = (ProcessInfo.processInfo.environment["CODEX_HOME"].map { URL(fileURLWithPath: $0) }
                    ?? home.appendingPathComponent(".codex")).appendingPathComponent("sessions")
        let fm = FileManager.default
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return [] }
        var found: [(id: String, title: String, date: Date)] = []
        for case let url as URL in en where url.pathExtension == "jsonl" {
            guard found.count < 400 else { break }                 // 오래 쓴 사람의 로그는 수천 개다
            guard let head = firstLines(url, max: 40) else { continue }
            var id: String?, title = "", matches = false
            for line in head {
                guard let d = line.data(using: .utf8),
                      let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                      let payload = o["payload"] as? [String: Any] else { continue }
                if o["type"] as? String == "session_meta" {
                    guard payload["cwd"] as? String == cwd else { break }   // 다른 폴더의 대화
                    matches = true
                    id = payload["session_id"] as? String
                } else if payload["type"] as? String == "user_message", title.isEmpty {
                    title = (payload["message"] as? String ?? "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                        .replacingOccurrences(of: "\n", with: " ")
                    break
                }
            }
            guard matches, let id else { continue }
            let mod = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            found.append((id: id, title: title.isEmpty ? id : String(title.prefix(60)), date: mod))
        }
        let fmt = DateFormatter(); fmt.dateFormat = "MM/dd HH:mm"
        return found.sorted { $0.date > $1.date }.prefix(limit)
            .map { (id: $0.id, title: $0.title, date: fmt.string(from: $0.date)) }
    }

    /// 파일 앞부분에서 줄 몇 개만. 롤아웃은 한 줄이 길 수 있어 넉넉히 읽고 자른다.
    private static func firstLines(_ url: URL, max: Int) -> [String]? {
        guard let fh = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? fh.close() }
        guard let data = try? fh.read(upToCount: 256 * 1024), let text = String(data: data, encoding: .utf8) else { return nil }
        return Array(text.split(separator: "\n", omittingEmptySubsequences: true).prefix(max).map(String.init))
    }

    /// 고를 수 있는 Codex 모델. Codex 가 받아 둔 카탈로그에서 읽는다 - 목록을 앱에 박아
    /// 두면 Codex 가 모델을 바꿀 때마다 riven 이 낡는다. 못 읽으면 빈 목록을 주고,
    /// 부르는 쪽은 "기본" 만 보여 준다.
    static func availableModels() -> [(label: String, id: String)] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let root = ProcessInfo.processInfo.environment["CODEX_HOME"].map { URL(fileURLWithPath: $0) }
                   ?? home.appendingPathComponent(".codex")
        guard let d = try? Data(contentsOf: root.appendingPathComponent("models_cache.json")),
              let obj = try? JSONSerialization.jsonObject(with: d) else { return [] }
        var out: [(label: String, id: String)] = []
        var seen = Set<String>()
        func walk(_ o: Any) {
            if let m = o as? [String: Any] {
                if let slug = m["slug"] as? String, let name = m["display_name"] as? String,
                   // 리뷰 전용처럼 대화에 고를 수 없는 것은 뺀다.
                   m["hidden"] as? Bool != true, !slug.contains("review"),
                   seen.insert(slug).inserted {
                    out.append((label: name, id: slug))
                }
                m.values.forEach(walk)
            } else if let a = o as? [Any] { a.forEach(walk) }
        }
        walk(obj)
        return out
    }
}
