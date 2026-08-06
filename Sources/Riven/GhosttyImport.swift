import AppKit

// 이미 ghostty 를 쓰던 사람의 설정을 가져온다.
//
// riven 의 터미널은 libghostty 라, 그 사람이 몇 달에 걸쳐 맞춰 둔 글꼴·크기·색이 이미 있다.
// 그걸 riven 에서 처음부터 다시 고르게 하는 건 실례다 — 한 번 눌러 가져오게 한다.
//
// ghostty 설정은 `key = value` 한 줄씩이고 `#` 주석과 빈 줄이 섞인다. 우리가 쓰는 것만
// 골라 읽는다 (모르는 키는 조용히 넘긴다 — 남의 설정 파일을 해석하려 들지 않는다).
enum GhosttyImport {

    struct Found {
        var fontFamily: String?
        var fontSize: Int?
        var theme: String?
        var background: String?
        var foreground: String?
        var path: URL

        /// 사람이 읽을 요약 — 무엇을 가져왔는지 눈으로 확인하고 되돌릴 수 있어야 한다.
        var summary: String {
            var parts: [String] = []
            if let f = fontFamily { parts.append("글꼴 \(f)") }
            if let s = fontSize { parts.append("크기 \(s)") }
            if let t = theme { parts.append("테마 \(t)") }
            if theme == nil, let b = background { parts.append("배경 \(b)") }
            return parts.isEmpty ? t("settings.ghosttyNothing") : parts.joined(separator: " · ")
        }
    }

    /// ghostty 가 설정을 두는 곳들. 먼저 찾은 것을 쓴다 (ghostty 자신의 탐색 순서와 같다).
    static var candidatePaths: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        var out: [URL] = []
        if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"], !xdg.isEmpty {
            out.append(URL(fileURLWithPath: xdg).appendingPathComponent("ghostty/config"))
        }
        out.append(home.appendingPathComponent(".config/ghostty/config"))
        out.append(home.appendingPathComponent("Library/Application Support/com.mitchellh.ghostty/config"))
        return out
    }

    static func locate() -> URL? {
        candidatePaths.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// 설정 파일을 읽어 우리가 쓰는 값만 뽑는다. 파일이 없거나 못 읽으면 nil.
    static func read(_ url: URL? = nil) -> Found? {
        guard let url = url ?? locate(),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        var f = Found(path: url)
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#"), let eq = line.firstIndex(of: "=") else { continue }
            let key = line[line.startIndex..<eq].trimmingCharacters(in: .whitespaces).lowercased()
            var val = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if val.hasPrefix("\"") && val.hasSuffix("\"") && val.count >= 2 { val = String(val.dropFirst().dropLast()) }
            guard !val.isEmpty else { continue }
            switch key {
            case "font-family":      if f.fontFamily == nil { f.fontFamily = val }   // 여러 줄이면 첫 줄이 본문용
            case "font-size":        f.fontSize = Int(Double(val) ?? 0)
            case "theme":            f.theme = val
            case "background":       f.background = normalizeHex(val)
            case "foreground":       f.foreground = normalizeHex(val)
            default: break
            }
        }
        return f
    }

    /// riven 설정에 적용한다. 돌려주는 문자열은 사용자에게 보여 줄 요약.
    @discardableResult
    static func apply(_ f: Found) -> String {
        var applied: [String] = []
        if let fam = f.fontFamily, !fam.isEmpty {
            Settings.shared.set("terminalFontFamily", fam)
            applied.append("글꼴 \(fam)")
        }
        if let size = f.fontSize, size >= 8, size <= 32 {
            Settings.shared.set("terminalFontSize", size)
            applied.append("크기 \(size)")
        }
        NotificationCenter.default.post(name: .rivenFontSizeChanged, object: nil)
        return applied.isEmpty ? t("settings.ghosttyNothing")
                               : t("settings.ghosttyApplied", ["items": applied.joined(separator: " · ")])
    }

    /// #rrggbb / rrggbb / 0xrrggbb 을 #rrggbb 로.
    private static func normalizeHex(_ s: String) -> String? {
        var v = s.lowercased()
        if v.hasPrefix("0x") { v = String(v.dropFirst(2)) }
        if v.hasPrefix("#") { v = String(v.dropFirst()) }
        guard v.count == 6, v.allSatisfy({ $0.isHexDigit }) else { return nil }
        return "#" + v
    }
}
