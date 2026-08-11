import AppKit

/// 아바타 고르는 줄 - 미리보기 + 글리프 한 줄 + 색 한 줄 + "자동".
///
/// 조합은 8글리프 × 12색 = 96가지인데 96칸을 늘어놓으면 편집 팝오버가 그것만으로 꽉 찬다.
/// 두 축을 따로 고르게 하면 20칸으로 같은 96가지를 다 덮는다. 왼쪽 미리보기가 조직도
/// 카드에 실제로 그려지는 모습 그대로라, 고르는 동안 결과를 바로 본다.
///
/// 값은 [[AgentAvatar]] 의 "글리프.색" 문자열이고, nil 이면 이름 해시 자동 배정이다.
/// 자동일 때도 미리보기와 선택 표시는 "지금 실제로 보이는 조합"을 가리킨다 - 자동이
/// 고른 것과 사용자가 고른 것이 화면에서 달라 보이면 안 된다.
final class AvatarPicker: NSView, Themable, Scalable {
    /// 고른 값이 바뀔 때마다 부른다 (nil = 자동).
    var onChange: ((String?) -> Void)?

    private let key: String
    private var override: String?
    private let preview = AvatarPreview()
    private var glyphChips: [CircleButton] = []
    private var colorChips: [CircleButton] = []

    /// - Parameters:
    ///   - key: 아바타 키(역할 이름) - 자동 배정의 기준.
    ///   - value: 지금 저장된 값 (nil = 자동).
    init(key: String, value: String?) {
        self.key = key
        self.override = value
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        // 편집 팝오버는 300pt 고정폭이고 왼쪽에 라벨 열이 있어서, 이 줄에 실제로 쓸 수 있는
        // 폭은 200pt 남짓이다. 색 12칸을 미리보기와 한 줄에 두면 잘리므로 두 줄로 나눈다:
        //   1줄 = 미리보기 + 글리프 8, 2줄 = 색 12, 3줄 = 자동으로 되돌리기.
        preview.translatesAutoresizingMaskIntoConstraints = false
        preview.widthAnchor.constraint(equalToConstant: UIScale.pt(26)).isActive = true
        preview.heightAnchor.constraint(equalToConstant: UIScale.pt(26)).isActive = true


        for i in 0..<AgentAvatar.glyphCount {
            let b = chip(UIScale.pt(16))
            b.tag = i
            b.target = self; b.action = #selector(glyphPicked(_:))
            b.toolTip = t("team.avatar")
            glyphChips.append(b)
        }
        for i in 0..<AgentAvatar.colorCount {
            let b = chip(UIScale.pt(14))
            b.tag = i
            b.target = self; b.action = #selector(colorPicked(_:))
            colorChips.append(b)
        }

        let glyphRow = NSStackView(views: [preview] + glyphChips)
        glyphRow.orientation = .horizontal; glyphRow.spacing = UIScale.pt(3); glyphRow.alignment = .centerY
        glyphRow.setCustomSpacing(UIScale.pt(8), after: preview)
        let colorRow = NSStackView(views: colorChips)
        colorRow.orientation = .horizontal; colorRow.spacing = UIScale.pt(2); colorRow.alignment = .centerY
        let rows = NSStackView(views: [glyphRow, colorRow])
        rows.orientation = .vertical; rows.spacing = UIScale.pt(6); rows.alignment = .leading
        rows.translatesAutoresizingMaskIntoConstraints = false

        addSubview(rows)
        NSLayoutConstraint.activate([
            rows.leadingAnchor.constraint(equalTo: leadingAnchor),
            rows.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            rows.topAnchor.constraint(equalTo: topAnchor),
            rows.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        apply()
        Theme.register(self); UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// 지금 고른 값 (nil = 자동).
    var value: String? { override }

    private func chip(_ d: CGFloat) -> CircleButton {
        let b = CircleButton()
        b.isBordered = false
        b.title = ""
        b.imagePosition = .imageOnly
        b.translatesAutoresizingMaskIntoConstraints = false
        b.widthAnchor.constraint(equalToConstant: d).isActive = true
        b.heightAnchor.constraint(equalToConstant: d).isActive = true
        return b
    }

    @objc private func glyphPicked(_ sender: NSButton) {
        let cur = AgentAvatar.spec(for: key, override: override)
        set(AgentAvatar.encode(glyph: sender.tag, color: cur.color))
    }
    @objc private func colorPicked(_ sender: NSButton) {
        let cur = AgentAvatar.spec(for: key, override: override)
        set(AgentAvatar.encode(glyph: cur.glyph, color: sender.tag))
    }

    private func set(_ v: String?) {
        guard v != override else { return }
        override = v
        apply()
        onChange?(v)
    }

    /// 지금 값에 맞춰 미리보기·선택 표시·칩 색을 다시 칠한다.
    private func apply() {
        let spec = AgentAvatar.spec(for: key, override: override)
        preview.set(key: key, override: override)
        let tint = AgentAvatar.color(index: spec.color)
        for (i, b) in glyphChips.enumerated() {
            let on = (i == spec.glyph)
            b.image = NSImage(systemSymbolName: AgentAvatar.symbolName(index: i),
                              accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: UIScale.pt(9), weight: .semibold))
            b.contentTintColor = on ? tint : Theme.fgDim
            b.fillColor = on ? tint.withAlphaComponent(0.18) : Theme.hover
            b.strokeColor = on ? tint : .clear
            b.strokeWidth = on ? 1.5 : 0
        }
        for (i, b) in colorChips.enumerated() {
            let on = (i == spec.color)
            b.image = nil
            b.fillColor = AgentAvatar.color(index: i)
            b.strokeColor = on ? Theme.fg : .clear
            b.strokeWidth = on ? 2 : 0
        }
        // 자동으로 되돌릴 게 없으면 버튼을 흐리게 (누를 수는 있어도 바뀌는 게 없다).
    }

    func applyTheme() { apply() }
    func applyScale() { apply() }
}

/// 조직도 카드에 그려지는 것과 같은 방식의 아바타 미리보기 (원 + 글리프).
private final class AvatarPreview: NSView {
    private var key = ""
    private var override: String?
    func set(key: String, override: String?) {
        self.key = key; self.override = override
        needsDisplay = true
    }
    override func draw(_ dirty: NSRect) {
        guard !key.isEmpty else { return }
        AgentAvatar.draw(key: key, override: override, in: bounds.insetBy(dx: 1, dy: 1), filled: true)
    }
}
