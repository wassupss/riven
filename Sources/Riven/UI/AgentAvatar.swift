import AppKit

/// 에이전트 식별 아바타 — 이름에서 결정론적으로 뽑는 사람 모양 글리프 + 색.
///
/// 이미지 에셋을 번들하지 않는다. SF Symbols 는 시스템이 이미 메모리에 들고 있고 벡터라
/// 배율(UIScale)마다 파일을 따로 둘 필요도 없다. 이름 해시로 (글리프, 색조)를 고르므로
/// 설정 없이도 에이전트마다 다른 아바타가 되고, 조직도·레일·독 탭이 같은 키를 쓰면
/// 세 군데에서 같은 얼굴이 나온다.
///
/// 키는 "역할"이지 "팬"이 아니다 — 닉네임(그룹 멤버) → 커스텀 에이전트 → 에이전트 종류
/// 순으로 고른다. 팬 id 를 쓰면 재시작마다 얼굴이 바뀌고, 제목을 쓰면 AI 요약 제목이
/// 갱신될 때마다 바뀐다.
enum AgentAvatar {
    /// 이름 → 아바타 키. 비어 있으면 nil (아바타 없음).
    static func key(nickname: String?, agent: String?, kind: String?) -> String? {
        for c in [nickname, agent, kind] {
            if let s = c?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
        }
        return nil
    }

    // 사람 모양 글리프 — 색이 정체성의 대부분을 지고, 글리프가 한 겹 더 갈라 준다
    // (12색 × 8글리프 = 96가지). 이름은 모두 SF Symbols 이고, 혹시 이 OS 에 없으면
    // person.fill 로 떨어진다.
    //
    // 후보를 11pt(탭·레일 실제 크기)로 렌더해 보고 고른 목록이다. 작은 크기에서 속이 꽉 찬
    // 도형으로 뭉개지는 것들(face.smiling.fill·person.crop.circle.fill = 그냥 원,
    // person.text.rectangle.fill = 그냥 사각형)은 뺐다 — 상태 점과 헷갈리기까지 한다.
    private static let symbols = [
        "person.fill", "person.2.fill", "person.bust.fill", "brain.head.profile",
        "figure.walk", "figure.stand", "figure.wave", "figure.arms.open",
    ]
    // 무채색·탁한 구간을 뺀 색조. 밝기/채도는 테마 모드에 맞춰 아래서 정한다.
    private static let hues: [CGFloat] = [
        0.02, 0.08, 0.12, 0.28, 0.38, 0.46, 0.53, 0.60, 0.68, 0.75, 0.83, 0.92,
    ]

    /// FNV-1a 64bit. Swift 의 hashValue 는 프로세스마다 시드가 달라서 못 쓴다 — 재시작하면
    /// 얼굴이 바뀐다.
    private static func hash(_ s: String) -> UInt64 {
        var h: UInt64 = 0xcbf29ce484222325
        for b in s.lowercased().utf8 {
            h ^= UInt64(b)
            h = h &* 0x100000001b3
        }
        return h
    }

    static func symbolName(for key: String) -> String {
        let name = symbols[Int(hash(key) % UInt64(symbols.count))]
        return NSImage(systemSymbolName: name, accessibilityDescription: nil) == nil ? "person.fill" : name
    }

    /// 아바타 색. 색조는 이름에 고정, 채도·밝기만 테마 모드를 따른다 (밝은 테마에서
    /// 파스텔이 흰 배경에 묻히지 않도록).
    static func color(for key: String) -> NSColor {
        let hue = hues[Int(hash(key) / 8 % UInt64(hues.count))]   // 글리프와 다른 비트를 쓴다
        return Theme.isLight
            ? NSColor(calibratedHue: hue, saturation: 0.82, brightness: 0.62, alpha: 1)
            : NSColor(calibratedHue: hue, saturation: 0.55, brightness: 0.95, alpha: 1)
    }

    // 색까지 구워 넣은 심볼 이미지 캐시. 키에 테마 모드가 들어가므로 테마를 바꿔도
    // 예전 색이 재사용되지 않는다.
    private static var cache: [String: NSImage] = [:]

    /// 탭·레일에 그대로 꽂을 수 있는 색 입힌 심볼 이미지. contentTintColor 를 따로
    /// 걸지 말 것 (팔레트 색이 덮인다).
    static func image(for key: String, size: CGFloat, weight: NSFont.Weight = .semibold) -> NSImage? {
        let sym = symbolName(for: key)
        let tint = color(for: key)
        let ck = "\(sym)|\(Int(size.rounded()))|\(weight.rawValue)|\(Theme.current.mode)|\(tint.hexish)"
        if let hit = cache[ck] { return hit }
        guard let base = NSImage(systemSymbolName: sym, accessibilityDescription: key) else { return nil }
        let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
            .applying(NSImage.SymbolConfiguration(paletteColors: [tint]))
        guard let img = base.withSymbolConfiguration(cfg) else { return nil }
        if cache.count > 256 { cache.removeAll() }      // 이름·배율이 늘어나도 무한히 크지 않게
        cache[ck] = img
        return img
    }

    /// 조직도처럼 직접 그리는 곳을 위한 헬퍼 — 원형 배경 + 가운데 글리프.
    /// filled = 리드 노드(색을 꽉 채우고 글리프는 반전).
    static func draw(key: String, in rect: NSRect, filled: Bool) {
        let tint = color(for: key)
        (filled ? tint.withAlphaComponent(0.9) : tint.withAlphaComponent(0.16)).setFill()
        NSBezierPath(ovalIn: rect).fill()
        let glyphColor = filled ? ChatPanel.onColor(tint) : tint
        let sym = symbolName(for: key)
        let cfg = NSImage.SymbolConfiguration(pointSize: rect.height * 0.58, weight: .semibold)
            .applying(NSImage.SymbolConfiguration(paletteColors: [glyphColor]))
        guard let img = NSImage(systemSymbolName: sym, accessibilityDescription: key)?
            .withSymbolConfiguration(cfg) else { return }
        let s = img.size
        img.draw(in: NSRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2,
                            width: s.width, height: s.height))
    }
}

private extension NSColor {
    /// 캐시 키용 짧은 색 표현 (테마 팔레트가 같은 모드 안에서 바뀌어도 구분되게).
    var hexish: String {
        guard let c = usingColorSpace(.sRGB) else { return "?" }
        return String(format: "%02x%02x%02x", Int(c.redComponent * 255),
                      Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }
}
