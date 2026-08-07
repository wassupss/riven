import Foundation

// Codex 쪽 사용량. [[Usage]] 가 Claude 로그로 하는 일을 Codex 로그로 한다.
//
// 헤더의 "36% · 74%" 는 오랫동안 Claude 것만이었다. Codex 챗이 생기면서 그 숫자는
// 틀린 게 아니라 *일부만 맞는* 것이 됐다 — Codex 로 아무리 돌려도 눈금이 움직이지
// 않으니, 사용자는 한도를 실제보다 넉넉하게 읽게 된다.
//
// 프로세스를 띄우지 않는다. app-server 에 물어보면 계정 정보만 주고 한도는 턴이 돌 때
// 알림으로만 오는데, 같은 값이 Codex 자신의 세션 로그에 남는다:
//
//   ~/.codex/sessions/<yyyy>/<MM>/<dd>/rollout-*.jsonl
//     {"type":"event_msg","payload":{"type":"token_count",
//        "info":{"last_token_usage":{…}}, "rate_limits":{"primary":{"used_percent":12.0,…}}}}
//
// 날짜별 폴더라 "오늘" 만 읽으면 되고, 파일도 세션 하나치라 작다 — Claude 트랜스크립트를
// 증분 파싱해야 했던 사정(100MB+)이 여기엔 없다.
enum CodexUsage {

    struct Limits {
        /// 남은 비율. Codex 는 "쓴 %" 로 주지만 riven 은 남은 쪽으로 통일한다 — 두 CLI 를
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
}
