import AppKit

// 브라우저의 개인 데이터: 방문 기록 · 북마크 · 파비콘.
//
// riven 은 "IDE 옆에 붙은 미니 브라우저"가 아니라 평소 브라우저를 대체하는 자리를 노린다.
// 그러려면 주소를 매번 손으로 치지 않아도 되어야 하고(기록·북마크·자동완성), 탭이 여러 개일 때
// 어느 사이트인지 한눈에 보여야 한다(파비콘). 그 세 가지를 여기서 관리한다.
//
// 저장 위치는 riven 지원 폴더다. 워크스페이스 레포 안에 두면 git status 에 뜨고 에이전트의
// `git add -A` 에 딸려 들어간다 (메모가 같은 이유로 지원 폴더를 쓴다).
// 동기화: 방문 기록·북마크는 개인 데이터라 Settings 를 거치지 않고 자체 파일로 둔다. Settings 는
// 기본이 클라우드 동기화(제외가 denylist)라, 여기에 넣으면 실수로 서버에 올라간다.
enum BrowserStore {

    // MARK: - 모델

    struct Visit: Codable {
        var url: String
        var title: String
        var last: Date
        var count: Int
    }
    struct Bookmark: Codable, Equatable {
        var url: String
        var title: String
        var folder: String      // 빈 문자열이면 최상위
        var added: Date
    }
    /// 자동완성 한 줄. `kind` 는 아이콘·정렬에 쓴다.
    struct Suggestion: Equatable {
        enum Kind { case openTab, bookmark, history, search }
        let kind: Kind
        let title: String
        let url: String
        let score: Double
    }

    // MARK: - 저장 위치

    private static let queue = DispatchQueue(label: "com.riven.browser.store")
    private static func dir() -> URL {
        let d = AppPaths.support("browser")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private static var historyURL: URL { dir().appendingPathComponent("history.json") }
    private static var bookmarksURL: URL { dir().appendingPathComponent("bookmarks.json") }

    // MARK: - 메모리 상태 (읽기는 메인에서 즉답, 쓰기는 백그라운드)

    private static var visits: [String: Visit] = load(historyURL) ?? [:]
    private static var marks: [Bookmark] = load(bookmarksURL) ?? []
    private static var dirtyHistory = false
    private static var dirtyMarks = false

    private static func load<T: Decodable>(_ url: URL) -> T? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: d)
    }
    /// 파일 쓰기는 항상 백그라운드에서. 기록이 수천 건이어도 타이핑이 끊기지 않아야 한다.
    private static func flush() {
        let h = dirtyHistory ? visits : nil
        let m = dirtyMarks ? marks : nil
        dirtyHistory = false; dirtyMarks = false
        queue.async {
            if let h, let d = try? JSONEncoder().encode(h) { try? d.write(to: historyURL, options: .atomic) }
            if let m, let d = try? JSONEncoder().encode(m) { try? d.write(to: bookmarksURL, options: .atomic) }
        }
    }

    // MARK: - 방문 기록

    /// 상한. 넘으면 오래되고 적게 방문한 것부터 버린다.
    static let historyLimit = 5_000

    /// 페이지를 다 읽었을 때 부른다. `private` 이면(시크릿 탭) 아무것도 남기지 않는다.
    static func recordVisit(url: URL?, title: String, isPrivate: Bool) {
        guard !isPrivate, let url, let s = normalized(url) else { return }
        var v = visits[s] ?? Visit(url: s, title: title, last: Date(), count: 0)
        v.title = title.isEmpty ? v.title : title
        v.last = Date()
        v.count += 1
        visits[s] = v
        if visits.count > historyLimit { prune() }
        dirtyHistory = true
        flush()
    }
    /// 방문 횟수가 적고 오래된 것부터 10% 를 덜어낸다 (매번 정렬하지 않도록 뭉텅이로).
    private static func prune() {
        let drop = max(1, visits.count / 10)
        let victims = visits.values
            .sorted { ($0.count, $0.last) < ($1.count, $1.last) }
            .prefix(drop)
        for v in victims { visits.removeValue(forKey: v.url) }
    }
    static func history(limit: Int = 200) -> [Visit] {
        visits.values.sorted { $0.last > $1.last }.prefix(limit).map { $0 }
    }
    static func clearHistory(since: Date? = nil) {
        if let since { visits = visits.filter { $0.value.last < since } } else { visits.removeAll() }
        dirtyHistory = true; flush()
    }
    static func removeHistory(url: String) {
        visits.removeValue(forKey: url); dirtyHistory = true; flush()
    }

    // MARK: - 북마크

    static func bookmarks(folder: String? = nil) -> [Bookmark] {
        let all = marks.sorted { $0.added > $1.added }
        guard let folder else { return all }
        return all.filter { $0.folder == folder }
    }
    static func isBookmarked(_ url: URL?) -> Bool {
        guard let s = normalized(url) else { return false }
        return marks.contains { $0.url == s }
    }
    /// 별 버튼: 있으면 지우고 없으면 넣는다. 지금 상태(추가됐는지)를 돌려준다.
    @discardableResult
    static func toggleBookmark(url: URL?, title: String, folder: String = "") -> Bool {
        guard let s = normalized(url) else { return false }
        if let i = marks.firstIndex(where: { $0.url == s }) {
            marks.remove(at: i); dirtyMarks = true; flush(); return false
        }
        marks.append(Bookmark(url: s, title: title.isEmpty ? s : title, folder: folder, added: Date()))
        dirtyMarks = true; flush(); return true
    }
    static func renameBookmark(url: String, title: String) {
        guard let i = marks.firstIndex(where: { $0.url == url }) else { return }
        marks[i].title = title; dirtyMarks = true; flush()
    }
    static func moveBookmark(url: String, folder: String) {
        guard let i = marks.firstIndex(where: { $0.url == url }) else { return }
        marks[i].folder = folder; dirtyMarks = true; flush()
    }
    static func removeBookmark(url: String) {
        marks.removeAll { $0.url == url }; dirtyMarks = true; flush()
    }
    static func folders() -> [String] {
        Array(Set(marks.map { $0.folder }.filter { !$0.isEmpty })).sorted()
    }

    // MARK: - 주소창 자동완성
    //
    // 브라우저 체감의 대부분이 여기서 갈린다. 몇 글자만 쳐도 원하는 페이지가 첫 줄에 와야 한다.
    // 점수는 (자주 갔는가 · 최근에 갔는가 · 어디가 맞았는가) 세 가지를 섞는다. 주소의 시작이
    // 맞으면 크게 올리고(도메인을 치는 습관), 제목만 맞으면 낮게 준다.

    static func suggest(_ raw: String, openTabs: [(title: String, url: String)] = [], limit: Int = 8) -> [Suggestion] {
        let q = raw.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return [] }
        var out: [Suggestion] = []

        // 1) 열려 있는 탭 — 이미 띄워 둔 걸 또 여는 실수를 막는다.
        for t in openTabs where match(t.title, t.url, q) != nil {
            out.append(Suggestion(kind: .openTab, title: t.title, url: t.url,
                                  score: 900 + (match(t.title, t.url, q) ?? 0)))
        }
        // 2) 북마크 — 일부러 저장한 것이니 기록보다 위.
        for b in marks {
            guard let m = match(b.title, b.url, q) else { continue }
            out.append(Suggestion(kind: .bookmark, title: b.title, url: b.url, score: 600 + m))
        }
        // 3) 방문 기록 — 횟수와 최근성을 함께 본다.
        let now = Date()
        for v in visits.values {
            guard let m = match(v.title, v.url, q) else { continue }
            let days = max(0, now.timeIntervalSince(v.last) / 86_400)
            let recency = 60 / (1 + days)                 // 오늘이면 60, 일주일 전이면 약 7
            let freq = min(60, Double(v.count) * 6)
            out.append(Suggestion(kind: .history, title: v.title, url: v.url, score: m + recency + freq))
        }
        // 같은 주소가 여러 갈래로 들어오면 가장 높은 점수만 남긴다.
        var best: [String: Suggestion] = [:]
        for s in out where (best[s.url]?.score ?? -1) < s.score { best[s.url] = s }
        var list = best.values.sorted { $0.score > $1.score }
        if list.count > limit { list = Array(list.prefix(limit)) }

        // 4) 검색은 마지막 줄에 항상 하나. 주소처럼 생겼으면 넣지 않는다.
        if !looksLikeURL(q) {
            list.append(Suggestion(kind: .search, title: raw, url: searchURL(raw), score: 0))
        }
        return list
    }

    /// 맞았으면 위치 점수(앞에서 맞을수록 높다), 아니면 nil.
    private static func match(_ title: String, _ url: String, _ q: String) -> Double? {
        let t = title.lowercased(), u = url.lowercased()
        let host = hostPart(u)
        if host.hasPrefix(q) { return 220 }                  // 도메인을 치기 시작했다
        if u.hasPrefix(q) || u.hasPrefix("https://" + q) || u.hasPrefix("http://" + q) { return 200 }
        if t.hasPrefix(q) { return 150 }
        if host.contains(q) { return 90 }
        if u.contains(q) { return 60 }
        if t.contains(q) { return 40 }
        return nil
    }
    private static func hostPart(_ u: String) -> String {
        guard let r = u.range(of: "://") else { return u }
        let rest = u[r.upperBound...]
        return String(rest.prefix(while: { $0 != "/" }))
    }
    /// 공백이 있거나 점이 없으면 검색어로 본다 (localhost·포트는 주소로).
    static func looksLikeURL(_ s: String) -> Bool {
        if s.contains(" ") { return false }
        if s.hasPrefix("localhost") || s.hasPrefix("127.0.0.1") || s.contains("://") { return true }
        return s.contains(".")
    }
    /// 주소창에 친 게 주소가 아니면 여기로 보낸다. 기본은 구글 — 평소 쓰는 검색이 나와야지,
    /// 주소창에 검색어를 쳤는데 낯선 엔진이 뜨면 그 자체가 걸림돌이다.
    static func searchURL(_ q: String) -> String {
        let e = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        let template = Settings.shared.string("browserSearch", "https://www.google.com/search?q={q}")
        return template.replacingOccurrences(of: "{q}", with: e)
    }

    /// 자동완성·기록의 키. 조각(#...)은 떼고 끝의 / 는 통일한다.
    private static func normalized(_ url: URL?) -> String? {
        guard let url, let scheme = url.scheme, scheme == "http" || scheme == "https" || scheme == "file"
        else { return nil }
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        c?.fragment = nil
        // 끝의 / 는 떼고 본다. news.ycombinator.com 과 news.ycombinator.com/ 은 같은 페이지인데
        // 따로 세면 기록 목록에 같은 줄이 두 번 뜬다 (실제로 그렇게 보였다).
        if c?.path == "/" { c?.path = "" }
        var s = c?.url?.absoluteString ?? url.absoluteString
        while s.hasSuffix("/") && s.filter({ $0 == "/" }).count > 2 { s.removeLast() }
        return s
    }

    // MARK: - 사이트별 확대
    //
    // 글씨가 작은 사이트를 볼 때마다 다시 확대하는 건 성가시다. 호스트마다 기억해 두고
    // 다음에 그 사이트를 열면 그대로 맞춘다 (1.0 이면 기억하지 않는다 — 기본값이니까).

    private static var zooms: [String: Double] = Settings.shared.object("browserZooms") as? [String: Double] ?? [:]

    static func zoom(for url: URL?) -> Double {
        guard let h = url?.host else { return 1 }
        return zooms[h] ?? 1
    }
    static func setZoom(_ z: Double, for url: URL?) {
        guard let h = url?.host else { return }
        if abs(z - 1) < 0.01 { zooms.removeValue(forKey: h) } else { zooms[h] = z }
        Settings.shared.set("browserZooms", zooms)
    }

    // MARK: - 파비콘
    //
    // 색 점은 임시방편이었다. 탭이 여러 개일 때 어느 사이트인지 알아보는 가장 빠른 신호는
    // 결국 파비콘이다. 호스트마다 한 번만 받아 디스크에 캐시하고, 같은 호스트 요청은 합친다.

    private static var icons: [String: NSImage] = [:]          // host → 아이콘 (메모리)
    private static var iconWaiters: [String: [(NSImage?) -> Void]] = [:]
    private static var iconFailed: Set<String> = []

    private static func iconFile(_ host: String) -> URL {
        let safe = host.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        return dir().appendingPathComponent("icons", isDirectory: true).appendingPathComponent(safe + ".png")
    }

    /// 이미 받아 둔 아이콘 (동기, 없으면 nil). 탭을 그릴 때 쓴다.
    static func cachedIcon(host: String) -> NSImage? {
        guard !host.isEmpty else { return nil }
        if let i = icons[host] { return i }
        let f = iconFile(host)
        guard let d = try? Data(contentsOf: f), let img = NSImage(data: d) else { return nil }
        icons[host] = img
        return img
    }

    /// 없으면 받아 온다. 완료 콜백은 메인에서 부른다. 같은 호스트 중복 요청은 하나로 합친다.
    static func icon(for url: URL?, done: @escaping (NSImage?) -> Void) {
        guard let host = url?.host, !host.isEmpty else { done(nil); return }
        if let i = cachedIcon(host: host) { done(i); return }
        if iconFailed.contains(host) { done(nil); return }
        if iconWaiters[host] != nil { iconWaiters[host]?.append(done); return }
        iconWaiters[host] = [done]

        let scheme = url?.scheme ?? "https"
        let candidates = [
            URL(string: "\(scheme)://\(host)/favicon.ico"),
            URL(string: "\(scheme)://\(host)/apple-touch-icon.png"),
        ].compactMap { $0 }

        func attempt(_ i: Int) {
            guard i < candidates.count else { finish(host, nil); return }
            var req = URLRequest(url: candidates[i])
            req.timeoutInterval = 5
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                if ok, let data, let img = NSImage(data: data), img.size.width > 0 {
                    try? FileManager.default.createDirectory(at: iconFile(host).deletingLastPathComponent(),
                                                             withIntermediateDirectories: true)
                    try? data.write(to: iconFile(host), options: .atomic)
                    finish(host, img)
                } else {
                    attempt(i + 1)
                }
            }.resume()
        }
        attempt(0)
    }
    private static func finish(_ host: String, _ img: NSImage?) {
        DispatchQueue.main.async {
            if let img { icons[host] = img } else { iconFailed.insert(host) }
            let waiters = iconWaiters.removeValue(forKey: host) ?? []
            waiters.forEach { $0(img) }
        }
    }

    /// 파비콘이 없을 때 쓰는 대체 표시 — 호스트에서 뽑은 색 (같은 사이트끼리 같은 색).
    static func fallbackColor(host: String) -> NSColor {
        guard !host.isEmpty else { return Theme.fgDim.withAlphaComponent(0.5) }
        var h: UInt64 = 5381
        for b in host.utf8 { h = (h &* 33) &+ UInt64(b) }
        return NSColor(hue: CGFloat(h % 360) / 360, saturation: 0.55, brightness: 0.85, alpha: 1)
    }

    // MARK: - 벤치용

    static func debugReset() {
        visits.removeAll(); marks.removeAll(); icons.removeAll(); iconFailed.removeAll()
        dirtyHistory = true; dirtyMarks = true; flush()
    }
    static var debugCounts: (history: Int, bookmarks: Int) { (visits.count, marks.count) }
}
