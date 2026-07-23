import AppKit

// 카드 드래그 재정렬용 pasteboard 타입 (dock의 dockPBType과 같은 방식).
let wsRailPBType = NSPasteboard.PasteboardType("com.riven.workspacecard")

// Left workspace rail — cmux-style cards (matches riven's WorkspaceTabs). One
// card per open folder; click to activate, + to open another. Phase 4 will add
// multi-workspace switching; for now it shows the active workspace.
final class WorkspaceRail: NSView, Themable {
    // 카드 좌우 여백 — 섹션 타이틀(12pt)과 같은 인셋이라 창 왼쪽 가장자리에 붙지 않는다.
    private static let cardInset: CGFloat = 12
    private var workspaces: [URL] = []
    private var active: URL?
    private var customNames: [URL: String] = [:]
    private var activities: [URL: PaneActivity] = [:]
    private var dots: [URL: NSView] = [:]
    private var shortcutLabels: [URL: NSTextField] = [:]
    private var flagsMonitor: Any?

    // Show the ⌘N chips while Command is held (a hover-like hint).
    private func installCommandHint() {
        flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] e in
            let cmd = e.modifierFlags.contains(.command)
            self?.shortcutLabels.values.forEach { $0.isHidden = !cmd }
            return e
        }
    }

    // Update a workspace's status dot without rebuilding the whole rail.
    func setActivity(_ url: URL, _ a: PaneActivity) {
        activities[url] = a
        if let dot = dots[url] { applyActivity(dot, a) }
    }
    private func applyActivity(_ dot: NSView, _ a: PaneActivity) {
        dot.layer?.removeAnimation(forKey: "pulse")
        switch a {
        case .idle: dot.layer?.backgroundColor = Theme.fgDim.cgColor; dot.layer?.opacity = 1
        case .busy: dot.layer?.backgroundColor = Theme.accent2.cgColor; dot.layer?.opacity = 1   // violet
        case .attn:
            dot.layer?.backgroundColor = Theme.warning.cgColor                                   // amber, pulsing
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1; pulse.toValue = 0.3; pulse.duration = 0.7
            pulse.autoreverses = true; pulse.repeatCount = .infinity
            dot.layer?.add(pulse, forKey: "pulse")
        }
    }
    var onOpen: (() -> Void)?
    var onSelect: ((URL) -> Void)?
    var onClose: ((URL) -> Void)?
    var onReveal: ((URL) -> Void)?
    // 카드를 끌어 순서를 바꾸면 새 순서 전체를 넘긴다 (main.swift가 workspaces 배열을
    // 같은 순서로 맞추고 persistSession()으로 저장 → 재시작해도 순서가 유지된다).
    var onReorder: (([URL]) -> Void)?

    // 드래그 중인 워크스페이스 (dock의 DockManager.draggingPanel과 같은 패턴).
    static var draggingWorkspace: URL?
    // 드롭 위치를 보여 주는 삽입 인디케이터 (accent 2px 라인).
    private let dropLine = NSView()

    private let stack = FlippedStack()
    private let scroll = NSScrollView()
    private let titleLabel = NSTextField(labelWithString: t("ws.title"))
    private let addButton = NSButton(title: "+", target: nil, action: nil)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        let title = titleLabel
        title.font = UIScale.font(11, .medium)
        title.textColor = Theme.fgDim
        title.translatesAutoresizingMaskIntoConstraints = false

        let add = addButton
        add.target = self; add.action = #selector(addClicked)
        add.isBordered = false
        add.font = UIScale.font(16)
        add.contentTintColor = Theme.fgDim
        add.translatesAutoresizingMaskIntoConstraints = false

        stack.orientation = .vertical
        stack.spacing = 3
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Cards live in a scroll view so many workspaces scroll instead of overflowing.
        scroll.documentView = stack
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        // 삽입 인디케이터는 스크롤 위에 떠 있는 오버레이 — 프레임으로 직접 배치한다.
        dropLine.wantsLayer = true
        dropLine.layer?.backgroundColor = Theme.accent.cgColor
        dropLine.layer?.cornerRadius = 1
        dropLine.isHidden = true

        addSubview(title); addSubview(add); addSubview(scroll); addSubview(dropLine)
        registerForDraggedTypes([wsRailPBType])
        let inset = WorkspaceRail.cardInset
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset),
            title.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            add.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            add.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            add.widthAnchor.constraint(equalToConstant: 22),
            // 좌우 여백은 스크롤뷰 자체에 준다. documentView(stack)의 leading 제약은
            // NSScrollView가 문서를 원점에 배치하며 무시해서, 예전엔 width 제약(-inset*2)만
            // 먹혀 왼쪽은 창에 딱 붙고 오른쪽에만 여백이 생겼다.
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -inset),
            scroll.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.widthAnchor)
        ])
        Theme.register(self)
        installCommandHint()
        NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.titleLabel.stringValue = t("ws.title"); self?.rebuild()
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        titleLabel.textColor = Theme.fgDim
        addButton.contentTintColor = Theme.fgDim
        dropLine.layer?.backgroundColor = Theme.accent.cgColor
        rebuild()   // cards recolor from the current palette
    }

    // ---- 카드 드래그 재정렬 (dock 패널 드래그와 같은 NSPasteboard 방식) ----
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation { updateDrop(s) }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { updateDrop(s) }
    override func draggingExited(_ s: NSDraggingInfo?) { hideDropLine() }
    override func draggingEnded(_ s: NSDraggingInfo) { hideDropLine(); WorkspaceRail.draggingWorkspace = nil }
    private func hideDropLine() { dropLine.isHidden = true }

    // 커서 위치 → 삽입 인덱스(0...count). 각 카드의 중앙선을 넘어가면 그 아래로 친다.
    private func dropIndex(_ s: NSDraggingInfo) -> Int {
        let p = stack.convert(s.draggingLocation, from: nil)   // FlippedStack: y가 아래로 증가
        var idx = 0
        for v in stack.arrangedSubviews {
            if p.y > v.frame.midY { idx += 1 } else { break }
        }
        return min(idx, workspaces.count)
    }

    private func updateDrop(_ s: NSDraggingInfo) -> NSDragOperation {
        guard let url = WorkspaceRail.draggingWorkspace, workspaces.contains(url), workspaces.count > 1 else { return [] }
        let cards = stack.arrangedSubviews
        let idx = dropIndex(s)
        // 인디케이터는 idx번째 카드의 위쪽 경계(마지막이면 마지막 카드 아래)에 놓는다.
        let y: CGFloat
        if cards.isEmpty { y = 0 }
        else if idx < cards.count { y = cards[idx].frame.minY - stack.spacing / 2 }
        else { y = cards[cards.count - 1].frame.maxY + stack.spacing / 2 }
        let r = convert(NSRect(x: 0, y: y - 1, width: stack.bounds.width, height: 2), from: stack)
        dropLine.frame = NSRect(x: r.minX, y: r.minY, width: r.width, height: 2)
        dropLine.isHidden = false
        return .move
    }

    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        defer { hideDropLine() }
        guard let url = WorkspaceRail.draggingWorkspace,
              let from = workspaces.firstIndex(of: url) else { return false }
        var to = dropIndex(s)
        if to > from { to -= 1 }                       // 자기 자신을 빼고 나면 한 칸 당겨진다
        guard to != from, to >= 0, to < workspaces.count else { return false }
        workspaces.insert(workspaces.remove(at: from), at: to)
        rebuild()                                      // ⌘N 칩 번호까지 새 순서로 다시 그린다
        onReorder?(workspaces)
        return true
    }

    @objc private func addClicked() { onOpen?() }

    func addWorkspace(_ url: URL) {
        if !workspaces.contains(url) { workspaces.append(url) }
        active = url
        rebuild()
    }
    // Update which card is highlighted (called when the active workspace switches, so
    // the highlight never lags behind the shown content).
    func setActive(_ url: URL) {
        guard active != url else { return }
        active = url
        rebuild()
    }

    // Re-lay-out the cards at the current UI zoom (fonts + card height read UIScale).
    func rebuildForScale() { rebuild() }

    private func rebuild() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        dots.removeAll(); shortcutLabels.removeAll()
        var activeCard: NSView?
        for ws in workspaces {
            let card = makeCard(ws)
            stack.addArrangedSubview(card)
            // Constrain width AFTER adding to the stack (common ancestor exists).
            card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            if ws == active { activeCard = card }
        }
        // Scroll the active workspace into view (switching to an off-screen one reveals it).
        if let activeCard {
            DispatchQueue.main.async { [weak self] in
                self?.layoutSubtreeIfNeeded()
                activeCard.scrollToVisible(activeCard.bounds)
            }
        }
    }

    private func makeCard(_ url: URL) -> NSView {
        let isActive = url == active
        let card = WSCard(url: url)
        card.wantsLayer = true
        card.layer?.cornerRadius = 8    // --radius-md
        // riven active card: bg-3 fill + --edge border + inset top catch-light (--lift).
        // A per-workspace colour tints the card SUBTLY (blended into the base so the name
        // stays legible), a touch stronger when active.
        var base = isActive ? Theme.bg3 : NSColor.clear
        if let c = cardColors[url] {
            base = (isActive ? Theme.bg3 : Theme.bg2).blended(withFraction: isActive ? 0.28 : 0.18, of: c) ?? base
        }
        card.layer?.backgroundColor = base.cgColor
        card.layer?.borderWidth = 1
        card.layer?.borderColor = (cardColors[url].map { $0.withAlphaComponent(0.55) } ?? (isActive ? Theme.edge : NSColor.clear)).cgColor
        card.onSelect = { [weak self] in self?.onSelect?(url) }
        card.onContextMenu = { [weak self] in self?.cardMenu(url) }
        card.translatesAutoresizingMaskIntoConstraints = false

        // Row 1: activity dot (7px, riven .ws-card-dot) + workspace name. Color reflects
        // this workspace's rollup: idle grey / busy violet / attn amber (pulsing).
        let dot = NSView(); dot.wantsLayer = true
        dot.layer?.cornerRadius = 3.5
        dot.translatesAutoresizingMaskIntoConstraints = false
        dots[url] = dot
        applyActivity(dot, activities[url] ?? .idle)
        // Same-path instances carry a #2/#3 fragment — show it so duplicate folders are
        // distinguishable in the rail.
        let baseName = customNames[url] ?? url.lastPathComponent
        let name = NSTextField(labelWithString: url.fragment.map { "\(baseName) #\($0)" } ?? baseName)
        name.font = UIScale.font(12, isActive ? .semibold : .medium)
        name.textColor = isActive ? Theme.fg : Theme.hex("#c9c9d0")
        name.lineBreakMode = .byTruncatingTail
        name.translatesAutoresizingMaskIntoConstraints = false

        // Row 2: shortened path.
        let path = NSTextField(labelWithString: shorten(url.path))
        path.font = UIScale.font(10)
        path.textColor = Theme.fgDim
        path.lineBreakMode = .byTruncatingMiddle
        path.translatesAutoresizingMaskIntoConstraints = false

        // Row 3: git branch (⑂ branch).
        let branchIcon = NSImageView()
        branchIcon.image = NSImage(systemSymbolName: "arrow.triangle.branch",
            accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 9, weight: .regular))
        branchIcon.contentTintColor = Theme.fgDim
        branchIcon.translatesAutoresizingMaskIntoConstraints = false
        let branch = NSTextField(labelWithString: branches[url] ?? "")
        branch.font = UIScale.mono(10)  // riven .ws-card-git mono
        branch.textColor = Theme.fgDim
        branch.translatesAutoresizingMaskIntoConstraints = false
        let branchRow = NSStackView(views: [branchIcon, branch])
        branchRow.orientation = .horizontal; branchRow.spacing = 4; branchRow.alignment = .centerY
        branchRow.translatesAutoresizingMaskIntoConstraints = false
        branchRow.isHidden = (branches[url] ?? "").isEmpty

        // ⌘N hint chip (top-right) — shown only while Command is held (like a hover).
        let idx = (workspaces.firstIndex(of: url) ?? 0) + 1
        let kbd = NSTextField(labelWithString: idx <= 9 ? "⌘\(idx)" : "")
        kbd.font = UIScale.mono(10, .medium); kbd.textColor = Theme.accent
        kbd.wantsLayer = true; kbd.layer?.backgroundColor = Theme.accentMuted.cgColor
        kbd.layer?.cornerRadius = 4; kbd.drawsBackground = false
        kbd.alignment = .center; kbd.isHidden = true
        kbd.translatesAutoresizingMaskIntoConstraints = false
        shortcutLabels[url] = kbd

        card.addSubview(dot); card.addSubview(name); card.addSubview(path); card.addSubview(branchRow); card.addSubview(kbd)
        NSLayoutConstraint.activate([
            card.heightAnchor.constraint(equalToConstant: UIScale.pt(60)),
            kbd.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -8),
            kbd.topAnchor.constraint(equalTo: card.topAnchor, constant: 8),
            kbd.widthAnchor.constraint(greaterThanOrEqualToConstant: 22),
            kbd.heightAnchor.constraint(equalToConstant: UIScale.pt(15)),
            dot.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 9),
            dot.centerYAnchor.constraint(equalTo: name.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 7),
            dot.heightAnchor.constraint(equalToConstant: 7),
            name.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 7),
            name.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -9),
            name.topAnchor.constraint(equalTo: card.topAnchor, constant: 8),
            path.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 9),
            path.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -9),
            path.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 3),
            branchRow.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 9),
            branchRow.topAnchor.constraint(equalTo: path.bottomAnchor, constant: 3)
        ])
        return card
    }

    private final class ColorChoice { let url: URL; let color: NSColor?; init(url: URL, color: NSColor?) { self.url = url; self.color = color } }
    private var branches: [URL: String] = [:]
    func setBranch(_ url: URL, _ branch: String?) {
        branches[url] = branch
        rebuild()
    }

    private func shorten(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
    }

    // Right-click menu on a workspace card (riven's workspace context menu).
    private func cardMenu(_ url: URL) -> NSMenu {
        let m = NSMenu()
        func add(_ title: String, _ sel: Selector) {
            let it = NSMenuItem(title: title, action: sel, keyEquivalent: "")
            it.target = self; it.representedObject = url; m.addItem(it)
        }
        add(t("ws.rename"), #selector(renameCard(_:)))
        add(t("ws.reveal"), #selector(revealCard(_:)))
        add(t("ws.copyPath"), #selector(copyPathCard(_:)))
        // Subtle per-workspace background tint (glassmorphism-like — text stays legible).
        let colorItem = NSMenuItem(title: t("ws.color"), action: nil, keyEquivalent: "")
        let colorMenu = NSMenu()
        let presets: [(String, NSColor?)] = [("기본", nil), ("빨강", .systemRed), ("주황", .systemOrange),
            ("노랑", .systemYellow), ("초록", .systemGreen), ("파랑", .systemBlue), ("청록", .systemTeal), ("보라", .systemPurple), ("분홍", .systemPink)]
        for (name, color) in presets {
            let it = NSMenuItem(title: name, action: #selector(setCardColor(_:)), keyEquivalent: "")
            it.target = self; it.representedObject = ColorChoice(url: url, color: color)
            it.image = colorSwatchImage(color)          // show the actual colour
            if cardColors[url] == color { it.state = .on }   // check the current one
            colorMenu.addItem(it)
        }
        colorItem.submenu = colorMenu
        m.addItem(colorItem)
        m.addItem(.separator())
        add(t("ws.close"), #selector(closeCard(_:)))
        return m
    }
    // A small rounded colour swatch for the menu (a hollow ring for "기본"/none).
    private func colorSwatchImage(_ color: NSColor?) -> NSImage {
        let size = NSSize(width: 13, height: 13)
        let img = NSImage(size: size)
        img.lockFocus()
        let rect = NSRect(x: 0.5, y: 0.5, width: 12, height: 12)
        let path = NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3)
        if let color { color.setFill(); path.fill() }
        else { Theme.fgDim.withAlphaComponent(0.5).setStroke(); path.lineWidth = 1; path.stroke() }
        img.unlockFocus()
        return img
    }
    private var cardColors: [URL: NSColor] = [:]
    func setColor(_ url: URL, _ color: NSColor?) { cardColors[url] = color; rebuild() }
    var onSetColor: ((URL, NSColor?) -> Void)?
    @objc private func setCardColor(_ s: NSMenuItem) {
        guard let c = s.representedObject as? ColorChoice else { return }
        cardColors[c.url] = c.color
        onSetColor?(c.url, c.color); rebuild()
    }
    @objc private func renameCard(_ s: NSMenuItem) {
        guard let url = s.representedObject as? URL else { return }
        let a = NSAlert(); a.messageText = t("ws.renameTitle")
        a.addButton(withTitle: "확인"); a.addButton(withTitle: "취소")
        let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        f.stringValue = customNames[url] ?? url.lastPathComponent
        a.accessoryView = f; a.window.initialFirstResponder = f
        if a.runModal() == .alertFirstButtonReturn {
            let v = f.stringValue.trimmingCharacters(in: .whitespaces)
            if v.isEmpty { customNames[url] = nil } else { customNames[url] = v }
            rebuild()
        }
    }
    @objc private func revealCard(_ s: NSMenuItem) { if let u = s.representedObject as? URL { onReveal?(u) } }
    @objc private func copyPathCard(_ s: NSMenuItem) {
        guard let u = s.representedObject as? URL else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(u.path, forType: .string)
    }
    @objc private func closeCard(_ s: NSMenuItem) {
        guard let u = s.representedObject as? URL else { return }
        workspaces.removeAll { $0 == u }; customNames[u] = nil; rebuild(); onClose?(u)
    }
    func closeWorkspace(_ url: URL) { workspaces.removeAll { $0 == url }; rebuild() }
}

// 워크스페이스 카드: 클릭하면 활성화, 위/아래로 끌면 레일 안에서 순서를 바꾼다
// (dock 탭 드래그와 같은 NSPasteboard 방식).
final class WSCard: NSView, NSDraggingSource {
    let url: URL
    var onSelect: (() -> Void)?
    var onContextMenu: (() -> NSMenu?)?
    override var mouseDownCanMoveWindow: Bool { false }   // 카드 드래그는 창을 옮기지 않는다
    init(url: URL) { self.url = url; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }

    // 이름/경로 라벨 위를 눌러도 카드 자신이 클릭·드래그를 받게 한다.
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }

    private var down: NSPoint = .zero
    private var dragging = false
    override func mouseDown(with e: NSEvent) { down = e.locationInWindow; dragging = false }
    override func mouseDragged(with e: NSEvent) {
        // 몇 pt 움직인 뒤에야 드래그를 시작한다 (그냥 클릭은 여전히 활성화).
        guard !dragging else { return }
        guard hypot(e.locationInWindow.x - down.x, e.locationInWindow.y - down.y) > 4 else { return }
        dragging = true
        WorkspaceRail.draggingWorkspace = url
        let item = NSPasteboardItem()
        item.setString(url.absoluteString, forType: wsRailPBType)
        let dragItem = NSDraggingItem(pasteboardWriter: item)
        dragItem.setDraggingFrame(bounds, contents: snapshot())
        beginDraggingSession(with: [dragItem], event: e, source: self)
    }
    override func mouseUp(with e: NSEvent) {
        if !dragging { onSelect?() }
        dragging = false
    }
    func draggingSession(_ s: NSDraggingSession, sourceOperationMaskFor c: NSDraggingContext) -> NSDragOperation { .move }
    func draggingSession(_ s: NSDraggingSession, endedAt p: NSPoint, operation: NSDragOperation) {
        WorkspaceRail.draggingWorkspace = nil
        dragging = false
    }
    private func snapshot() -> NSImage {
        let img = NSImage(size: bounds.size)
        if let rep = bitmapImageRepForCachingDisplay(in: bounds) {
            cacheDisplay(in: bounds, to: rep)
            img.addRepresentation(rep)
        }
        return img
    }

    override func menu(for event: NSEvent) -> NSMenu? { onContextMenu?() }
}
