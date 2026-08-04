import AppKit

// Agent group — riven's orchestration surface.
//
// Agents can already talk to each other (riven_agents / riven_ask_agent), but nothing told you the
// capability existed. This panel makes it a feature:
//   · 탭      — "새 그룹"(작성) + 지금 열려 있는 그룹 하나당 탭 하나
//   · 새 그룹  — one card per agent (nickname, persona, model, who it reports to) in a responsive grid
//   · 그룹 탭  — that group's reporting tree drawn as a flow chart
//
// Each agent gets a NICKNAME, which is how peers address it — "chat-90690212265" is a dock id, not
// something you'd type in a prompt. The hierarchy is real: creating the group lays the panes out by
// level (main left, its reports in the next column, theirs in the one after).

/// One node of a group's reporting tree, as read back from the live dock.
struct AgentNode {
    let name: String
    let persona: String?
    let model: String?      // "opus"/"sonnet"/… — nil이면 계정 기본
    let parent: String?
    let busy: Bool
    /// 지금 패널이 열려 있는지. 닫힌 멤버도 조직도에 흐리게 남겨 두고, 누르면 되살린다.
    var open: Bool = true
}

// MARK: - org chart

/// Draws a group's reporting tree as a flow diagram: rounded agent cards on a faint dot canvas,
/// joined by a shared bus per parent (down → rail → down into each child) rather than N crossing
/// elbows. Hover lifts a card; clicking one jumps to that agent's pane.
final class OrgChartView: NSView, Themable {
    var nodes: [AgentNode] = [] { didSet { rebuild(); needsDisplay = true } }
    /// Clicking a node jumps to that agent's pane.
    var onPick: ((String) -> Void)?
    /// 노드 오른쪽의 ✎ 를 누르면 그 에이전트 설정을 고친다.
    var onEdit: ((String) -> Void)?

    private var boxes: [(node: AgentNode, rect: NSRect)] = []
    /// 부모마다 하나: (부모 아래 점, 자식 위 점들, 레일 y)
    private var buses: [(from: NSPoint, to: [NSPoint], railY: CGFloat)] = []
    private var contentSize = NSSize(width: 0, height: 0)
    private var hovered: String?
    private var track: NSTrackingArea?
    private var lastWidth: CGFloat = 0

    override var isFlipped: Bool { true }
    override var intrinsicContentSize: NSSize { contentSize }

    /// 축소는 하지 않는다 — 줄이면 읽을 수 없다. 넓으면 그대로 두고 스크롤로 본다.
    private let scale: CGFloat = 1
    private var nodeW: CGFloat { UIScale.pt(168) * scale }
    private var nodeH: CGFloat { UIScale.pt(58) * scale }
    private var hGap: CGFloat { UIScale.pt(20) * scale }
    private var vGap: CGFloat { UIScale.pt(42) * scale }
    private var pad: CGFloat { UIScale.pt(16) * scale }
    private func font(_ size: CGFloat, _ w: NSFont.Weight = .regular) -> NSFont {
        UIScale.font(max(9, size * scale), w)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = track { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow], owner: self)
        addTrackingArea(t); track = t
    }
    override func layout() {
        super.layout()
        // 폭이 바뀌면 가운데 정렬을 다시 잡는다.
        if abs(lastWidth - bounds.width) > 0.5 { lastWidth = bounds.width; rebuild(); needsDisplay = true }
    }

    private func rebuild() {
        boxes = []; buses = []
        guard !nodes.isEmpty else { contentSize = .zero; invalidateIntrinsicContentSize(); return }
        let byName = Dictionary(nodes.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        var children: [String: [String]] = [:]
        var roots: [String] = []
        for n in nodes {
            if let p = n.parent, p != n.name, byName[p] != nil { children[p, default: []].append(n.name) }
            else { roots.append(n.name) }
        }
        // 슬롯 배정: 잎은 순서대로 한 칸씩, 부모는 자식들의 가운데.
        var slot: [String: CGFloat] = [:]
        var level: [String: Int] = [:]
        var next: CGFloat = 0
        var seen = Set<String>()
        func place(_ name: String, _ depth: Int) {
            guard seen.insert(name).inserted else { return }   // 순환 방어
            level[name] = depth
            let kids = children[name] ?? []
            if kids.isEmpty { slot[name] = next; next += 1; return }
            for k in kids { place(k, depth + 1) }
            let ss = kids.compactMap { slot[$0] }
            slot[name] = ss.isEmpty ? { let s = next; next += 1; return s }() : (ss.min()! + ss.max()!) / 2
        }
        for r in roots { place(r, 0) }
        for n in nodes where slot[n.name] == nil { place(n.name, 0) }   // 고아 방어

        var rect: [String: NSRect] = [:]
        var maxX: CGFloat = 0, maxY: CGFloat = 0
        for n in nodes {
            guard let s = slot[n.name], let d = level[n.name] else { continue }
            let r = NSRect(x: pad + s * (nodeW + hGap), y: pad + CGFloat(d) * (nodeH + vGap),
                           width: nodeW, height: nodeH)
            rect[n.name] = r
            maxX = max(maxX, r.maxX); maxY = max(maxY, r.maxY)
        }
        contentSize = NSSize(width: maxX + pad, height: maxY + pad)
        // 뷰가 내용보다 넓으면 가운데로 — 왼쪽에 몰려 있으면 허전하다.
        let dx = max(0, (bounds.width - contentSize.width) / 2)
        if dx > 0 { for k in rect.keys { rect[k]!.origin.x += dx } }
        for n in nodes { if let r = rect[n.name] { boxes.append((n, r)) } }
        for (parent, kids) in children {
            guard let pr = rect[parent] else { continue }
            let tops = kids.compactMap { rect[$0] }.map { NSPoint(x: $0.midX, y: $0.minY) }
            guard !tops.isEmpty else { continue }
            buses.append((from: NSPoint(x: pr.midX, y: pr.maxY), to: tops,
                          railY: pr.maxY + vGap / 2))
        }
        invalidateIntrinsicContentSize()
    }

    override func draw(_ dirty: NSRect) {
        Theme.bg.setFill(); dirty.fill()
        drawDotGrid(dirty)
        guard !boxes.isEmpty else {
            let s = t("team.none")
            let at: [NSAttributedString.Key: Any] = [.font: UIScale.font(UIScale.body), .foregroundColor: Theme.fgDim]
            let sz = (s as NSString).size(withAttributes: at)
            (s as NSString).draw(at: NSPoint(x: (bounds.width - sz.width) / 2, y: bounds.height / 2 - sz.height),
                                 withAttributes: at)
            return
        }
        drawBuses()
        for (n, r) in boxes { drawNode(n, r) }
    }

    /// 옅은 점 캔버스 — 다이어그램이라는 걸 배경만으로 알려준다.
    private func drawDotGrid(_ dirty: NSRect) {
        let step = UIScale.pt(16)
        Theme.fgDim.withAlphaComponent(0.10).setFill()
        var y = step / 2
        while y < bounds.height {
            var x = step / 2
            while x < bounds.width {
                if dirty.contains(NSPoint(x: x, y: y)) {
                    NSBezierPath(ovalIn: NSRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5)).fill()
                }
                x += step
            }
            y += step
        }
    }

    /// 부모마다 버스 하나: 아래로 → 가로 레일 → 각 자식 위로. 엘보가 겹치지 않는다.
    private func drawBuses() {
        for bus in buses {
            let p = NSBezierPath()
            p.lineWidth = 1.25
            p.lineCapStyle = .round; p.lineJoinStyle = .round
            p.move(to: bus.from); p.line(to: NSPoint(x: bus.from.x, y: bus.railY))
            if bus.to.count > 1 {
                let xs = bus.to.map { $0.x }
                p.move(to: NSPoint(x: xs.min()!, y: bus.railY))
                p.line(to: NSPoint(x: xs.max()!, y: bus.railY))
            }
            for t in bus.to {
                p.move(to: NSPoint(x: t.x, y: bus.railY))
                p.line(to: NSPoint(x: t.x, y: t.y - 3))
            }
            Theme.edge.setStroke()
            p.stroke()
            // 자식 쪽 끝에 작은 화살촉 — 방향(위→아래)을 분명히.
            Theme.edge.setFill()
            for t in bus.to {
                let a = NSBezierPath()
                a.move(to: NSPoint(x: t.x - 3.5, y: t.y - 4.5))
                a.line(to: NSPoint(x: t.x + 3.5, y: t.y - 4.5))
                a.line(to: NSPoint(x: t.x, y: t.y))
                a.close(); a.fill()
            }
        }
    }

    private func drawNode(_ n: AgentNode, _ r: NSRect) {
        let isMain = (n.parent == nil)
        let hot = (hovered == n.name)
        let box = NSBezierPath(roundedRect: r, xRadius: UIScale.pt(10), yRadius: UIScale.pt(10))
        if !n.open { box.setLineDash([4, 4], count: 2, phase: 0) }
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(hot ? 0.32 : 0.18)
        shadow.shadowBlurRadius = hot ? 10 : 5
        shadow.shadowOffset = NSSize(width: 0, height: -2)
        shadow.set()
        (hot ? Theme.bg2.blended(withFraction: 0.07, of: Theme.accent) ?? Theme.bg2 : Theme.bg2).setFill()
        box.fill()
        NSGraphicsContext.restoreGraphicsState()
        (isMain ? Theme.accent.withAlphaComponent(0.65) : (hot ? Theme.accent.withAlphaComponent(0.35) : Theme.edge)).setStroke()
        box.lineWidth = isMain ? 1.5 : 1
        box.stroke()

        // 아바타: 이름 첫 글자. 메인은 액센트로 채운다.
        let d = UIScale.pt(26) * scale
        let av = NSRect(x: r.minX + UIScale.pt(11) * scale, y: r.midY - d / 2, width: d, height: d)
        (isMain ? Theme.accent.withAlphaComponent(0.85) : Theme.accent.withAlphaComponent(0.14)).setFill()
        NSBezierPath(ovalIn: av).fill()
        let initial = String(n.name.prefix(1)).uppercased()
        let iAt: [NSAttributedString.Key: Any] = [
            .font: font(UIScale.caption, .bold),
            .foregroundColor: isMain ? ChatPanel.onColor(Theme.accent) : Theme.accent]
        let iSz = (initial as NSString).size(withAttributes: iAt)
        (initial as NSString).draw(at: NSPoint(x: av.midX - iSz.width / 2, y: av.midY - iSz.height / 2),
                                   withAttributes: iAt)

        let textX = av.maxX + UIScale.pt(9) * scale
        let textW = r.maxX - UIScale.pt(11) * scale - textX
        let nameAt: [NSAttributedString.Key: Any] = [
            .font: font(UIScale.body, .semibold),
            .foregroundColor: n.open ? Theme.fg : Theme.fgDim]
        (n.name as NSString).draw(in: NSRect(x: textX, y: r.minY + UIScale.pt(11) * scale,
                                             width: textW, height: UIScale.pt(18) * scale),
                                  withAttributes: nameAt)
        var sub = [n.persona, n.model.map { ChatPanel.modelLabel($0) }].compactMap { $0 }.joined(separator: " · ")
        if sub.isEmpty { sub = isMain ? t("team.main") : t("team.noPersona") }
        if !n.open { sub = t("team.closed") }
        let subAt: [NSAttributedString.Key: Any] = [
            .font: font(UIScale.caption), .foregroundColor: Theme.fgDim]
        (sub as NSString).draw(in: NSRect(x: textX, y: r.minY + UIScale.pt(30) * scale,
                                          width: textW, height: UIScale.pt(16) * scale),
                               withAttributes: subAt)
        // 작업 중이면 액센트 점. 마우스를 올리면 그 자리에 ✎ 가 나와 설정을 고칠 수 있다.
        if hot {
            let er = Self.editRect(in: r)
            let bg = NSBezierPath(roundedRect: er, xRadius: UIScale.pt(6), yRadius: UIScale.pt(6))
            Theme.accent.withAlphaComponent(0.16).setFill(); bg.fill()
            let at: [NSAttributedString.Key: Any] = [
                .font: UIScale.font(UIScale.caption, .semibold), .foregroundColor: Theme.accent]
            let sz = ("✎" as NSString).size(withAttributes: at)
            ("✎" as NSString).draw(at: NSPoint(x: er.midX - sz.width / 2, y: er.midY - sz.height / 2), withAttributes: at)
        } else if n.busy {
            let dot = NSRect(x: r.maxX - UIScale.pt(16) * scale, y: r.minY + UIScale.pt(11) * scale, width: 6, height: 6)
            Theme.accent.setFill(); NSBezierPath(ovalIn: dot).fill()
        }
    }

    func applyTheme() { needsDisplay = true }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let h = boxes.first(where: { $0.rect.contains(p) })?.node.name
        if h != hovered { hovered = h; needsDisplay = true }
    }
    override func mouseExited(with event: NSEvent) { hovered = nil; needsDisplay = true }
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let hit = boxes.first(where: { $0.rect.contains(p) }) else { return }
        if Self.editRect(in: hit.rect).contains(p) { onEdit?(hit.node.name) } else { onPick?(hit.node.name) }
    }
    /// 노드 상자 안에서 ✎ 가 차지하는 영역 (그리기와 히트 테스트가 같은 값을 쓴다).
    static func editRect(in r: NSRect) -> NSRect {
        let d = min(UIScale.pt(20), r.height * 0.38)
        return NSRect(x: r.maxX - d - 6, y: r.minY + 6, width: d, height: d)
    }
    /// 팝오버를 띄울 기준 사각형.
    func rect(of name: String) -> NSRect? { boxes.first { $0.node.name == name }?.rect }
}

// MARK: - responsive card grid

/// Frame-positioned responsive grid: cards flow left→right and wrap, columns derived from the
/// available width. Autolayout stacks can't reflow like this, and a fixed column count would
/// squash the cards when the panel is docked narrow.
final class CardGrid: NSView {
    var cards: [NSView] = []
    var cardH: CGFloat = 0 { didSet { needsLayout = true } }
    private var minCardW: CGFloat { UIScale.pt(235) }
    private var gap: CGFloat { UIScale.pt(10) }
    private var heightC: NSLayoutConstraint!
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        heightC = heightAnchor.constraint(equalToConstant: 0)
        heightC.isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        let w = bounds.width
        guard w > 1, cardH > 1 else { return }
        let cols = max(1, Int((w + gap) / (minCardW + gap)))
        let cw = (w - gap * CGFloat(cols - 1)) / CGFloat(cols)
        for (i, c) in cards.enumerated() {
            c.frame = NSRect(x: CGFloat(i % cols) * (cw + gap), y: CGFloat(i / cols) * (cardH + gap),
                             width: cw, height: cardH)
        }
        let rows = max(1, Int(ceil(Double(cards.count) / Double(cols))))
        let h = CGFloat(rows) * cardH + CGFloat(rows - 1) * gap
        if abs(heightC.constant - h) > 0.5 { heightC.constant = h }   // 루프 방지: 값이 바뀔 때만
        if ProcessInfo.processInfo.environment["RIVEN_GRIDDUMP"] != nil, "\(Int(w))/\(cards.count)" != lastDump {
            lastDump = "\(Int(w))/\(cards.count)"
            RLog.log("GRID w=\(Int(w)) cols=\(cols) rows=\(rows) card=\(Int(cw))x\(Int(cardH)) "
                   + cards.map { "(\(Int($0.frame.minX)),\(Int($0.frame.minY)))" }.joined(separator: " "))
        }
    }
    private var lastDump = ""
}

/// 그리드 마지막 칸에 놓이는 "에이전트 추가" 타일. 카드와 같은 크기·모서리로 흘러가므로
/// 버튼이 그리드 밖에 따로 떠 있을 때보다 "여기에 한 장 더 생긴다"가 바로 읽힌다.
final class AddCard: NSView, Themable {
    var onClick: (() -> Void)?
    var enabled = true { didSet { applyTheme() } }
    private let label = NSTextField(labelWithString: "+  " + t("team.add"))
    private var hot = false
    private var track: NSTrackingArea?
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        applyTheme(); applyScale()
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = track { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
        addTrackingArea(t); track = t
    }
    // 가운데 라벨이 클릭을 먹어 mouseDown이 안 오던 문제 — 타일 전체가 하나의 버튼이다.
    override func hitTest(_ point: NSPoint) -> NSView? {
        bounds.contains(convert(point, from: superview)) ? self : nil
    }
    override func mouseEntered(with e: NSEvent) { hot = enabled; needsDisplay = true }
    override func mouseExited(with e: NSEvent) { hot = false; needsDisplay = true }
    override func mouseDown(with e: NSEvent) { if enabled { onClick?() } }
    func applyScale() { label.font = UIScale.font(UIScale.body, .medium) }
    func applyTheme() {
        label.textColor = enabled ? Theme.fgDim : Theme.fgDim.withAlphaComponent(0.4)
        alphaValue = enabled ? 1 : 0.5
        needsDisplay = true
    }
    // 점선 테두리 — 실제 카드가 아니라 "빈 자리"라는 신호.
    override func draw(_ dirty: NSRect) {
        let r = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: r, xRadius: UIScale.pt(10), yRadius: UIScale.pt(10))
        if hot { Theme.accent.withAlphaComponent(0.06).setFill(); path.fill() }
        path.lineWidth = 1
        path.setLineDash([4, 4], count: 2, phase: 0)
        (hot ? Theme.accent.withAlphaComponent(0.7) : Theme.edge).setStroke()
        path.stroke()
    }
}

/// 조직도 노드의 ✎ 로 여는 편집 폼: 이름·모델·보고 대상. 페르소나(--agent)는 프로세스
/// 기동 인자라 실행 중에는 못 바꾸므로 값만 보여준다.
final class AgentEditForm: NSView, Themable {
    /// 저장(기존 편집) 또는 추가(새 멤버). persona 는 새 멤버일 때만 의미가 있다.
    var onSave: ((_ name: String, _ persona: String?, _ model: String?, _ parent: String?) -> Void)?
    var onCancel: (() -> Void)?
    /// 이 멤버를 그룹에서 완전히 뺀다 (패널을 닫고 명단에서도 지운다).
    var onDelete: (() -> Void)?
    private let nameField = RivenInput(placeholder: t("team.mainName"))
    private let modelSelect = RivenSelect(ChatPanel.selectableModels.map { $0.0 }, compact: true)
    private let parentSelect: RivenSelect
    private let personaSelect: RivenSelect
    private let personaLabel = NSTextField(labelWithString: "")
    private let peers: [String]
    private let personas: [String]
    private let isNew: Bool

    init(node: AgentNode, peers: [String], isMain: Bool, personas: [String] = [], isNew: Bool = false) {
        self.peers = peers
        self.personas = personas
        self.isNew = isNew
        parentSelect = RivenSelect([t("team.noParent")] + peers, compact: true)
        personaSelect = RivenSelect([t("team.noPersona")] + personas, compact: true)
        super.init(frame: NSRect(x: 0, y: 0, width: 300, height: 0))
        wantsLayer = true
        nameField.stringValue = node.name
        if let m = node.model, let i = ChatPanel.selectableModels.firstIndex(where: { $0.1 == m }) {
            modelSelect.selectItem(at: i)
        }
        if let p = node.parent, let i = peers.firstIndex(of: p) { parentSelect.selectItem(at: i + 1) }
        parentSelect.isEnabled = !isMain          // 메인은 보고 대상이 없다
        // 기존 멤버의 페르소나는 프로세스 기동 인자라 못 바꾼다 → 값만 표시. 새 멤버는 고를 수 있다.
        personaLabel.stringValue = node.persona.map { "\(t("team.persona")): \($0)" } ?? ""
        personaLabel.isHidden = isNew || personaLabel.stringValue.isEmpty
        personaLabel.translatesAutoresizingMaskIntoConstraints = false

        func row(_ title: String, _ control: NSView) -> NSStackView {
            let l = NSTextField(labelWithString: title)
            l.font = UIScale.font(UIScale.caption); l.textColor = Theme.fgDim
            l.translatesAutoresizingMaskIntoConstraints = false
            l.widthAnchor.constraint(equalToConstant: UIScale.pt(58)).isActive = true
            let h = NSStackView(views: [l, control])
            h.orientation = .horizontal; h.spacing = 8; h.alignment = .centerY
            return h
        }
        let save = RivenPrimaryButton(isNew ? t("team.addOne") : t("common.save"), target: self, action: #selector(saveTapped))
        let cancel = RivenSecondaryButton(t("common.cancel"), target: self, action: #selector(cancelTapped))
        var buttonViews: [NSView] = [cancel, save]
        if !isNew, !isMain {
            let del = RivenSecondaryButton(t("team.remove"), target: self, action: #selector(deleteTapped))
            del.contentTintColor = Theme.danger
            del.attributedTitle = NSAttributedString(string: t("team.remove"), attributes: [
                .foregroundColor: Theme.danger, .font: UIScale.font(UIScale.body, .medium)])
            buttonViews.insert(del, at: 0)
        }
        let buttons = NSStackView(views: buttonViews)
        buttons.orientation = .horizontal; buttons.spacing = 8; buttons.distribution = .fillEqually

        var rows: [NSView] = [row(t("team.nameField"), nameField)]
        if isNew { rows.append(row(t("team.persona"), personaSelect)) }
        rows += [row(t("team.model"), modelSelect), row(t("team.reportsTo"), parentSelect), personaLabel, buttons]
        let stack = NSStackView(views: rows)
        stack.orientation = .vertical; stack.spacing = 9; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            widthAnchor.constraint(equalToConstant: UIScale.pt(300)),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        personaLabel.font = UIScale.font(UIScale.caption)
        applyTheme(); Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }
    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        personaLabel.textColor = Theme.fgDim
    }
    func focusName() { window?.makeFirstResponder(nameField) }

    @objc private func saveTapped() {
        let mi = modelSelect.indexOfSelectedItem
        let pi = parentSelect.indexOfSelectedItem
        let ps = personaSelect.indexOfSelectedItem
        onSave?(nameField.stringValue.trimmingCharacters(in: .whitespaces),
                (isNew && ps > 0 && ps - 1 < personas.count) ? personas[ps - 1] : nil,
                mi > 0 ? ChatPanel.selectableModels[mi].1 : nil,
                (parentSelect.isEnabled && pi > 0 && pi - 1 < peers.count) ? peers[pi - 1] : nil)
    }
    @objc private func cancelTapped() { onCancel?() }
    @objc private func deleteTapped() { onDelete?() }
}

// MARK: - panel

final class AgentGroupPanel: NSView, Themable, Scalable {
    /// (nickname, persona, index of the agent it reports to) — the FIRST entry is the main agent.
    var onCreate: ((_ group: String, _ members: [(name: String, agent: String?, model: String?, parent: Int?)]) -> Void)?
    /// Custom agents available for the persona picker (.claude/agents).
    var agentsProvider: (() -> [String])?
    /// Groups currently open in the dock: name → members (for the chips + org chart).
    var groupsProvider: (() -> [(group: String, members: [AgentNode])])?
    /// Clicking a node in an existing group's chart focuses that pane.
    var onFocusAgent: ((_ group: String, _ name: String) -> Void)?
    /// 조직도에서 고친 설정을 실제 팬에 적용한다 (이름·모델·보고 대상).
    var onEditAgent: ((_ group: String, _ old: String, _ name: String, _ model: String?, _ parent: String?) -> Void)?
    /// 기존 그룹에 멤버를 하나 더 만든다.
    var onAddAgent: ((_ group: String, _ name: String, _ persona: String?, _ model: String?, _ parent: String?) -> Void)?
    /// 멤버를 그룹에서 완전히 뺀다 (패널을 닫고 명단에서도 지운다).
    var onRemoveAgent: ((_ group: String, _ name: String) -> Void)?

    private static let minAgents = 2
    private static let maxAgents = 8

    private let titleLabel = NSTextField(labelWithString: t("title.team"))
    private let hint = NSTextField(labelWithString: t("team.hint"))
    private let tabStrip = RivenTabStrip(frame: .zero)
    private let previewBtn = RivenSecondaryButton(t("team.preview"), target: nil, action: #selector(togglePreview))
    private let addToGroupBtn = RivenSecondaryButton(t("team.addToGroup"), target: nil, action: #selector(addToGroup))
    private let groupLabel = NSTextField(labelWithString: t("team.name"))
    private let groupField = RivenInput(placeholder: t("team.nameDefault"))
    private let grid = CardGrid()
    private let gridScroll = NSScrollView()
    private let chart = OrgChartView()
    private let chartScroll = NSScrollView()
    private let addTile = AddCard(frame: .zero)
    private let createBtn: RivenPrimaryButton

    /// nil = the draft being edited; otherwise an existing group's name.
    private var shownGroup: String?
    /// 작성 중인 구성을 조직도로 미리 보는 중인지.
    private var previewing = false

    private final class Card: NSView, Themable {
        let badge = NSTextField(labelWithString: "")
        let name: RivenInput
        let persona: RivenSelect
        let model: RivenSelect
        let modelLabel = NSTextField(labelWithString: t("team.model"))
        let parent: RivenSelect
        let parentLabel = NSTextField(labelWithString: t("team.reportsTo"))
        let remove = CircleButton()
        var isMain = false
        init(personas: [String]) {
            name = RivenInput()
            persona = RivenSelect(personas, compact: true)
            model = RivenSelect(ChatPanel.selectableModels.map { $0.0 }, compact: true)
            parent = RivenSelect([], compact: true)
            super.init(frame: .zero)
            wantsLayer = true
            layer?.cornerRadius = UIScale.pt(10)
            layer?.borderWidth = 1
            [badge, remove, name, persona, modelLabel, model, parentLabel, parent].forEach {
                $0.translatesAutoresizingMaskIntoConstraints = false; addSubview($0)
            }
            remove.isBordered = false
            remove.toolTip = t("team.removeTip")
            let pad = UIScale.pt(11), gap = UIScale.pt(7)
            let gutter = UIScale.pt(58)   // 라벨 폭: 모델/보고 대상 드롭다운이 같은 선에서 시작하도록
            NSLayoutConstraint.activate([
                badge.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
                badge.topAnchor.constraint(equalTo: topAnchor, constant: pad),
                remove.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad + 3),
                remove.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
                remove.widthAnchor.constraint(equalToConstant: UIScale.pt(18)),
                remove.heightAnchor.constraint(equalToConstant: UIScale.pt(18)),
                name.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
                name.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
                name.topAnchor.constraint(equalTo: badge.bottomAnchor, constant: gap),
                persona.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
                persona.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
                persona.topAnchor.constraint(equalTo: name.bottomAnchor, constant: gap),
                modelLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
                modelLabel.topAnchor.constraint(equalTo: persona.bottomAnchor, constant: gap + 2),
                modelLabel.widthAnchor.constraint(equalToConstant: gutter - 6),
                model.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad + gutter),
                model.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
                model.centerYAnchor.constraint(equalTo: modelLabel.centerYAnchor),
                parentLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
                parentLabel.topAnchor.constraint(equalTo: model.bottomAnchor, constant: gap),
                parentLabel.widthAnchor.constraint(equalToConstant: gutter - 6),
                parent.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad + gutter),
                parent.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
                parent.centerYAnchor.constraint(equalTo: parentLabel.centerYAnchor),
            ])
            applyTheme(); applyScale()
            Theme.register(self)
        }
        required init?(coder: NSCoder) { fatalError() }
        func applyTheme() {
            layer?.backgroundColor = Theme.bg.cgColor
            layer?.borderColor = (isMain ? Theme.accent.withAlphaComponent(0.5) : Theme.edge).cgColor
            badge.textColor = isMain ? Theme.accent : Theme.fgDim
            parentLabel.textColor = Theme.fgDim
            modelLabel.textColor = Theme.fgDim
            remove.attributedTitle = NSAttributedString(string: "✕", attributes: [
                .foregroundColor: Theme.fgDim, .font: UIScale.font(UIScale.caption)])
        }
        func applyScale() {
            badge.font = UIScale.font(UIScale.caption, .semibold)
            parentLabel.font = UIScale.font(UIScale.caption)
            modelLabel.font = UIScale.font(UIScale.caption)
        }
    }
    private var cards: [Card] = []

    override init(frame: NSRect) {
        createBtn = RivenPrimaryButton(t("team.create"), target: nil, action: #selector(create))
        super.init(frame: frame)
        wantsLayer = true
        [createBtn, previewBtn, addToGroupBtn].forEach { $0.target = self }
        addTile.onClick = { [weak self] in self?.addAgent() }
        tabStrip.onSelect = { [weak self] i in self?.tabPicked(i) }

        [titleLabel, hint, groupLabel].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
        tabStrip.translatesAutoresizingMaskIntoConstraints = false
        hint.lineBreakMode = .byWordWrapping
        hint.maximumNumberOfLines = 3
        groupField.stringValue = t("team.nameDefault")

        let head = NSStackView(views: [groupLabel, groupField])
        head.orientation = .horizontal; head.spacing = 8; head.alignment = .centerY
        head.translatesAutoresizingMaskIntoConstraints = false
        head0 = head
        groupField.setContentHuggingPriority(.defaultLow, for: .horizontal)

        for sv in [gridScroll, chartScroll] {
            sv.drawsBackground = false; sv.hasVerticalScroller = true; sv.autohidesScrollers = true
            sv.translatesAutoresizingMaskIntoConstraints = false
        }
        gridScroll.documentView = grid
        chartScroll.documentView = chart
        chartScroll.hasHorizontalScroller = true
        // 이게 빠지면 아래 제약이 오토리사이징과 충돌해 문서 뷰가 0x0으로 남는다 —
        // 조직도가 넓어져도 스크롤이 안 되고 잘려 보이던 원인.
        chart.translatesAutoresizingMaskIntoConstraints = false
        chart.onPick = { [weak self] name in
            guard let self, let g = self.shownGroup else { return }
            self.onFocusAgent?(g, name)
        }
        chart.onEdit = { [weak self] name in self?.editAgent(name) }

        [titleLabel, hint, tabStrip, head, gridScroll, chartScroll, previewBtn, createBtn, addToGroupBtn].forEach { addSubview($0) }
        grid.addSubview(addTile)

        let pad: CGFloat = 14
        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: pad),
            hint.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            hint.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            hint.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 5),

            // 탭 스트립은 패널 폭을 꽉 채운다 — 기준선(hairline)이 섹션 구분선 역할까지 한다.
            tabStrip.leadingAnchor.constraint(equalTo: leadingAnchor),
            tabStrip.trailingAnchor.constraint(equalTo: trailingAnchor),
            tabStrip.topAnchor.constraint(equalTo: hint.bottomAnchor, constant: 14),

            head.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            head.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            head.topAnchor.constraint(equalTo: tabStrip.bottomAnchor, constant: 14),

            gridScroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            gridScroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            gridScroll.topAnchor.constraint(equalTo: head.bottomAnchor, constant: 12),
            gridScroll.bottomAnchor.constraint(equalTo: previewBtn.topAnchor, constant: -12),
            previewBtn.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            previewBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            previewBtn.bottomAnchor.constraint(equalTo: createBtn.topAnchor, constant: -8),
            // 그리드는 클립뷰 폭을 그대로 따라가고 높이만 스스로 정한다 → 가로 스크롤 없음.
            grid.topAnchor.constraint(equalTo: gridScroll.contentView.topAnchor),
            grid.leadingAnchor.constraint(equalTo: gridScroll.contentView.leadingAnchor),
            grid.widthAnchor.constraint(equalTo: gridScroll.contentView.widthAnchor),

            chart.widthAnchor.constraint(greaterThanOrEqualTo: chartScroll.contentView.widthAnchor),
            chart.topAnchor.constraint(equalTo: chartScroll.contentView.topAnchor),
            chart.leadingAnchor.constraint(equalTo: chartScroll.contentView.leadingAnchor),
            chartScroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            chartScroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            chartScroll.topAnchor.constraint(equalTo: tabStrip.bottomAnchor, constant: 12),
            chartScroll.bottomAnchor.constraint(equalTo: addToGroupBtn.topAnchor, constant: -10),
            addToGroupBtn.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            addToGroupBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            addToGroupBtn.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -pad),

            createBtn.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            createBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            createBtn.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -pad),
        ])
        // 기본은 메인 + 멤버 2 = 3장. 더 필요하면 "에이전트 추가"로 늘린다.
        for _ in 0..<3 { appendCard() }
        applyTheme(); applyScale()
        refresh()          // 탭("새 그룹" + 열려 있는 그룹)을 처음부터 채운다
        Theme.register(self); UIScale.register(self)
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.titleLabel.stringValue = t("title.team")
            self.hint.stringValue = t("team.hint")
            self.groupLabel.stringValue = t("team.name")
            self.createBtn.title = t("team.create"); self.createBtn.applyTheme()
            self.previewBtn.title = t("team.preview"); self.previewBtn.applyTheme()
            self.relabel(); self.refresh()
        }
        if ProcessInfo.processInfo.environment["RIVEN_GRIDDUMP"] != nil { selfTest() }
    }
    required init?(coder: NSCoder) { fatalError() }

    /// 패널이 호스트에 붙을 때마다(열기·워크스페이스 복귀) 탭을 새로 읽는다 — 예전에는
    /// toggleDockPanel 경로에서만 갱신해서, 레이아웃 복원으로 열린 패널엔 탭이 하나도 없었다.
    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        if superview != nil { refresh() }
    }

    private var langObserver: NSObjectProtocol?
    deinit { if let o = langObserver { NotificationCenter.default.removeObserver(o) } }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        titleLabel.textColor = Theme.fg
        hint.textColor = Theme.fgDim
        groupLabel.textColor = Theme.fg
        cards.forEach { $0.applyTheme() }
    }
    func applyScale() {
        titleLabel.font = UIScale.font(UIScale.title, .semibold)
        hint.font = UIScale.font(UIScale.small)
        groupLabel.font = UIScale.font(UIScale.body)
        cards.forEach { $0.applyScale() }
        grid.cardH = UIScale.pt(196)
    }

    /// 패널이 열릴 때마다 탭을 다시 만든다 — 첫 탭은 "새 그룹"(작성), 나머지는 지금 열려 있는
    /// 그룹들. 탭 하나가 곧 화면 하나라 별도의 모드 스위치가 필요 없다.
    func refresh() {
        groups = groupsProvider?() ?? []
        if let g = shownGroup, !groups.contains(where: { $0.group == g }) { shownGroup = nil }
        tabStrip.tabs = [(t("team.draft"), nil)] + groups.map { ($0.group, $0.members.count) }
        let idx = shownGroup.flatMap { g in groups.firstIndex(where: { $0.group == g }).map { $0 + 1 } } ?? 0
        tabStrip.select(idx)
        applyTab()
    }
    private var groups: [(group: String, members: [AgentNode])] = []
    /// 벤치용: [에이전트 추가] 를 n번 누른 것과 같은 경로.
    func debugAddAgents(_ n: Int) { for _ in 0..<n { addAgent() } }
    /// 벤치용: UI에서 [그룹 만들기] 를 누른 것과 같은 경로.
    func debugCreate() { create() }
    /// 벤치용: 선택된 탭 / 조직도가 보이는지.
    func debugSelectedTab() -> String { debugTabTitles().indices.contains(tabStrip.selected) ? debugTabTitles()[tabStrip.selected] : "?" }
    func debugChartVisible() -> Bool { !chartScroll.isHidden }
    /// 벤치용: 지금 보이는 탭 라벨.
    func debugTabTitles() -> [String] {
        tabStrip.tabs.map { tab in tab.1.map { "\(tab.0)(\($0))" } ?? tab.0 }
    }

    /// 그룹을 만든 직후 호출: 탭을 새로 읽고 그 그룹 탭으로 옮겨 조직도를 보여준다.
    func show(group: String) {
        shownGroup = group
        previewing = false
        refresh()
    }

    private var editPopover: NSPopover?
    /// 노드의 ✎ → 그 에이전트 설정 팝오버.
    private func editAgent(_ name: String) {
        guard let g = shownGroup,
              let members = groups.first(where: { $0.group == g })?.members,
              let node = members.first(where: { $0.name == name }) else { return }
        let form = AgentEditForm(node: node, peers: members.map { $0.name }.filter { $0 != name },
                                 isMain: node.parent == nil)
        form.onSave = { [weak self] newName, _, model, parent in
            guard let self else { return }
            self.editPopover?.close(); self.editPopover = nil
            self.onEditAgent?(g, name, newName.isEmpty ? name : newName, model, parent)
            self.refresh()
        }
        form.onDelete = { [weak self] in
            guard let self else { return }
            self.editPopover?.close(); self.editPopover = nil
            self.onRemoveAgent?(g, name)
            self.refresh()
        }
        form.onCancel = { [weak self] in self?.editPopover?.close(); self?.editPopover = nil }
        let vc = NSViewController(); vc.view = form
        let pop = NSPopover(); pop.contentViewController = vc; pop.behavior = .transient
        editPopover = pop
        let anchor = chart.rect(of: name) ?? NSRect(x: 0, y: 0, width: 1, height: 1)
        pop.show(relativeTo: anchor, of: chart, preferredEdge: .maxY)
        DispatchQueue.main.async { form.focusName() }
    }

    private func tabPicked(_ i: Int) {
        shownGroup = (i == 0) ? nil : (i - 1 < groups.count ? groups[i - 1].group : nil)
        if shownGroup != nil { previewing = false }   // 기존 그룹 탭은 언제나 조직도
        applyTab()
    }

    /// 지금 탭에 맞는 화면을 보인다: 새 그룹 = 구성(또는 미리보기), 그룹 = 조직도.
    private func applyTab() {
        let showChart = (shownGroup != nil) || previewing
        [head0, gridScroll].forEach { $0?.isHidden = showChart }
        createBtn.isHidden = (shownGroup != nil)
        previewBtn.isHidden = (shownGroup != nil)
        addToGroupBtn.isHidden = (shownGroup == nil)   // 기존 그룹 탭에서만
        previewBtn.title = t(previewing ? "team.backToSetup" : "team.preview")
        previewBtn.applyTheme()
        chartScroll.isHidden = !showChart
        redrawChart()
    }

    @objc private func togglePreview() { previewing.toggle(); applyTab() }

    /// 기존 그룹에 멤버 추가 — 이름·페르소나·모델·보고 대상을 받아 팬을 하나 더 연다.
    @objc private func addToGroup() {
        guard let g = shownGroup, let members = groups.first(where: { $0.group == g })?.members else { return }
        let names = members.map { $0.name }
        let fresh = AgentNode(name: t("team.memberDefault", ["n": members.count]), persona: nil, model: nil,
                              parent: names.first, busy: false, open: true)
        let form = AgentEditForm(node: fresh, peers: names, isMain: false,
                                 personas: agentsProvider?() ?? [], isNew: true)
        form.onSave = { [weak self] name, persona, model, parent in
            guard let self else { return }
            self.editPopover?.close(); self.editPopover = nil
            self.onAddAgent?(g, name.isEmpty ? fresh.name : name, persona, model, parent ?? names.first)
            self.refresh()
        }
        form.onCancel = { [weak self] in self?.editPopover?.close(); self?.editPopover = nil }
        let vc = NSViewController(); vc.view = form
        let pop = NSPopover(); pop.contentViewController = vc; pop.behavior = .transient
        editPopover = pop
        pop.show(relativeTo: addToGroupBtn.bounds, of: addToGroupBtn, preferredEdge: .maxY)
        DispatchQueue.main.async { form.focusName() }
    }

    private func redrawChart() {
        if let g = shownGroup, let found = (groupsProvider?() ?? []).first(where: { $0.group == g }) {
            chart.nodes = found.members
        } else {
            // 작성 중인 구성을 그대로 미리 본다 — 만들기 전에 조직도가 맞는지 확인할 수 있게.
            chart.nodes = cards.enumerated().map { i, c in
                // 상위 드롭다운의 항목은 카드와 1:1 (i번째 항목 = i번째 카드, 자기 자신은 "—").
                let pi = c.parent.indexOfSelectedItem
                let parent = (i > 0 && pi >= 0 && pi < cards.count && pi != i) ? cards[pi].name.stringValue : nil
                let mi = c.model.indexOfSelectedItem
                return AgentNode(name: c.name.stringValue,
                                 persona: c.persona.indexOfSelectedItem > 0 ? c.persona.titleOfSelectedItem : nil,
                                 model: mi > 0 ? ChatPanel.selectableModels[mi].1 : nil,
                                 parent: i == 0 ? nil : (parent ?? cards[0].name.stringValue),
                                 busy: false)
            }
        }
    }

    /// applyTab에서 감추려면 참조가 필요해서 보관 (스택뷰라 타입이 NSView).
    private weak var head0: NSView?
    // MARK: - cards

    private func appendCard() {
        guard cards.count < Self.maxAgents else { return }
        let i = cards.count
        let card = Card(personas: [t("team.noPersona")] + (agentsProvider?() ?? []))
        card.name.placeholderString = i == 0 ? t("team.mainName") : t("team.memberName", ["n": i])
        card.name.stringValue = i == 0 ? t("team.mainDefault") : t("team.memberDefault", ["n": i])
        card.name.target = self; card.name.action = #selector(fieldEdited)
        card.persona.target = self; card.persona.action = #selector(fieldEdited)
        card.model.target = self; card.model.action = #selector(fieldEdited)
        card.parent.target = self; card.parent.action = #selector(fieldEdited)
        card.remove.target = self; card.remove.action = #selector(removeCard(_:))
        cards.append(card)
        grid.addSubview(card, positioned: .below, relativeTo: addTile)   // 추가 타일은 항상 마지막 칸
        relabel()
    }

    @objc private func fieldEdited() { relabelParents(); redrawChart() }

    @objc private func addAgent() {
        appendCard()
        grid.layoutSubtreeIfNeeded()
        if let last = cards.last {
            grid.scrollToVisible(last.frame)
            window?.makeFirstResponder(last.name)
        }
    }

    @objc private func removeCard(_ sender: NSButton) {
        guard cards.count > Self.minAgents,
              let card = cards.first(where: { $0.remove === sender }) else { return }
        card.removeFromSuperview()
        cards.removeAll { $0 === card }
        relabel()
    }

    /// 배지·제거 버튼·상위 선택지를 현재 구성에 맞춘다 — 카드를 지우면 번호가 밀린다.
    private func relabel() {
        for (i, c) in cards.enumerated() {
            c.isMain = (i == 0)
            c.badge.stringValue = i == 0 ? t("team.main") : "\(i + 1)"
            c.remove.isHidden = (i == 0) || cards.count <= Self.minAgents
            c.parentLabel.isHidden = (i == 0)     // 메인은 보고 대상이 없다
            c.parent.isHidden = (i == 0)
            c.applyTheme(); c.applyScale()
        }
        relabelParents()
        // 상한에 닿으면 타일은 남기되 비활성 — 자리가 사라지면 레이아웃이 튄다.
        addTile.enabled = cards.count < Self.maxAgents
        grid.cards = cards + [addTile]
        grid.needsLayout = true
        redrawChart()
    }

    /// 상위 드롭다운은 "자기 자신을 뺀 나머지 에이전트" — 이름을 고쳐도 그대로 따라간다.
    private func relabelParents() {
        for (i, c) in cards.enumerated() where i > 0 {
            let keep = c.parent.indexOfSelectedItem
            let titles = cards.enumerated().map { j, o in
                j == i ? "(본인)" : (o.name.stringValue.isEmpty ? "\(j + 1)" : o.name.stringValue)
            }
            c.parent.removeAllItems()
            c.parent.addItems(withTitles: titles.enumerated().map { j, s in j == i ? "(본인)" : s })
            c.parent.item(at: i)?.isEnabled = false
            c.parent.selectItem(at: keep >= 0 && keep < titles.count && keep != i ? keep : 0)
        }
    }

    // MARK: - create

    @objc private func create() {
        let specs: [(name: String, agent: String?, model: String?, parent: Int?)] = cards.enumerated().map { i, c in
            let nick = c.name.stringValue.trimmingCharacters(in: .whitespaces)
            let persona = c.persona.indexOfSelectedItem > 0 ? c.persona.titleOfSelectedItem : nil
            let mi = c.model.indexOfSelectedItem
            let pi = c.parent.indexOfSelectedItem
            let parent: Int? = (i == 0 || pi < 0 || pi == i) ? nil : pi
            return (name: nick.isEmpty ? (i == 0 ? t("team.mainDefault") : t("team.memberDefault", ["n": i])) : nick,
                    agent: persona,
                    model: mi > 0 ? ChatPanel.selectableModels[mi].1 : nil,   // 0번 = 계정 기본
                    parent: i == 0 ? nil : (parent ?? 0))   // 지정이 없으면 메인 직속
        }
        let group = groupField.stringValue.trimmingCharacters(in: .whitespaces)
        onCreate?(group.isEmpty ? t("team.nameDefault") : group, specs)
    }

    // RIVEN_GRIDDUMP=1: 추가/제거 + 상한/하한 + 번호 재배치 + 조직도 레이아웃을 클릭 없이 훑는다.
    private func selfTest() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self else { return }
            for (label, v) in [("card0", self.cards.first as NSView?), ("addTile", self.addTile), ("nameField", self.cards.first?.name)] {
                guard let v, let win = self.window, let root = win.contentView else { continue }
                let p = v.convert(NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil)
                let hit = root.hitTest(root.convert(p, from: nil))
                RLog.log("GRID hit \(label) → \(hit.map { String(describing: type(of: $0)) } ?? "nil")")
            }
            for _ in 0..<7 { self.addAgent() }               // 상한(8)에서 멈춰야 함
            RLog.log("GRID selftest afterAdd=\(self.cards.count) addEnabled=\(self.addTile.enabled)")
            // 상한 있는 for로 돈다 — 조건부 while은 removeCard의 하한 가드에 걸리는 순간
            // 메인 스레드를 통째로 잡아먹고(앱이 SIGTERM에도 안 죽는다) 만다.
            for _ in 0..<Self.maxAgents where self.cards.count > Self.minAgents {
                if let last = self.cards.last { self.removeCard(last.remove) }
            }
            if let last = self.cards.last { self.removeCard(last.remove) }   // 하한에서 더 안 줄어야 함
            RLog.log("GRID selftest afterRemove=\(self.cards.count) "
                   + "badges=" + self.cards.map { $0.badge.stringValue }.joined(separator: ","))
            // 3단 계층을 만들어 조직도 배치를 확인: 메인 ← A, B / A ← C
            for _ in 0..<2 { self.addAgent() }
            self.cards[2].parent.selectItem(at: 0); self.cards[3].parent.selectItem(at: 1)
            self.fieldEdited()
            self.previewing = true; self.applyTab()
            self.chartScroll.layoutSubtreeIfNeeded()
            RLog.log("GRID tabs=" + self.tabStrip.tabs.map { "\($0.0)\($0.1.map { n in "(\(n))" } ?? "")" }.joined(separator: "|")
                   + " selected=\(self.tabStrip.selected) chartVisible=\(!self.chartScroll.isHidden)")
            RLog.log("GRID models=" + ChatPanel.selectableModels.map { $0.1 }.joined(separator: ","))
            // 넓은 조직도(멤버 전원이 메인 직속 = 열이 많음)에서 가로 스크롤이 되는지.
            for _ in 0..<5 { self.addAgent() }
            for (i, c) in self.cards.enumerated() where i > 0 { c.parent.selectItem(at: 0) }
            self.fieldEdited()
            self.previewing = true; self.applyTab()
            self.chartScroll.layoutSubtreeIfNeeded()
            RLog.log("GRID wide chart=\(Int(self.chart.frame.width))x\(Int(self.chart.frame.height)) "
                   + "intrinsic=\(Int(self.chart.intrinsicContentSize.width)) "
                   + "clip=\(Int(self.chartScroll.contentView.bounds.width)) "
                   + "docVisible=\(Int(self.chartScroll.documentVisibleRect.width)) "
                   + "hScroller=\(self.chartScroll.horizontalScroller?.isHidden == false)")
            RLog.log("GRID chart nodes=\(self.chart.nodes.count) frame=\(Int(self.chart.frame.width))x\(Int(self.chart.frame.height)) "
                   + "size=\(NSStringFromSize(self.chart.intrinsicContentSize)) "
                   + self.chart.nodes.map { "\($0.name)←\($0.parent ?? "-")" }.joined(separator: " "))
            self.previewing = false; self.applyTab()
        }
    }
}
