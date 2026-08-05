import AppKit

// The 30px tab strip atop a DockGroup (riven's .dock-tabs). One DockTab per panel;
// active tab = bg fill + inset accent underline. Tabs drag to rearrange.
final class DockTabBar: NSView {
    weak var group: DockGroup?
    private let stack = NSStackView()
    // 탭이 바 너비를 넘으면 예전에는 그냥 잘려서, 뒤쪽 탭은 보이지도 클릭·드래그되지도
    // 않았다(⌘T로 탭을 늘리면 접근 불가). 에디터 탭 스트립(overflow-x:auto)처럼 가로
    // 스크롤을 붙인다.
    private let scroll = NSScrollView()
    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor
        stack.orientation = .horizontal
        stack.spacing = 0
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false      // 30px 스트립이라 스크롤러는 숨기고 휠/트랙패드로만
        scroll.hasVerticalScroller = false
        scroll.horizontalScrollElasticity = .allowed
        scroll.verticalScrollElasticity = .none
        scroll.automaticallyAdjustsContentInsets = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.heightAnchor)
        ])
        // Bottom hairline.
        let hair = NSView(); hair.wantsLayer = true
        hair.layer?.backgroundColor = Theme.hairline.cgColor
        hair.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hair)
        NSLayoutConstraint.activate([
            hair.leadingAnchor.constraint(equalTo: leadingAnchor),
            hair.trailingAnchor.constraint(equalTo: trailingAnchor),
            hair.bottomAnchor.constraint(equalTo: bottomAnchor),
            hair.heightAnchor.constraint(equalToConstant: 1)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    // 일반 마우스 휠은 세로 델타만 준다 — 가로 스트립이므로 세로 델타를 가로 이동으로
    // 바꿔 준다 (트랙패드 가로 스와이프는 그대로 동작).
    override func scrollWheel(with e: NSEvent) {
        let dx = e.scrollingDeltaX != 0 ? e.scrollingDeltaX : e.scrollingDeltaY
        guard dx != 0 else { super.scrollWheel(with: e); return }
        let maxX = max(0, stack.frame.width - scroll.contentView.bounds.width)
        let x = min(maxX, max(0, scroll.contentView.bounds.origin.x - dx))
        scroll.contentView.scroll(to: NSPoint(x: x, y: 0))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    // 활성 탭이 스크롤 밖에 있으면 보이게 끌어온다 (탭 전환/추가 시).
    private func revealActiveTab() {
        guard let group, group.panels.indices.contains(group.activeIndex),
              stack.arrangedSubviews.indices.contains(group.activeIndex) else { return }
        let tab = stack.arrangedSubviews[group.activeIndex]
        stack.layoutSubtreeIfNeeded()
        tab.scrollToVisible(tab.bounds)
    }

    func rebuild() {
        layer?.backgroundColor = Theme.bg2.cgColor
        guard let group else { stack.arrangedSubviews.forEach { $0.removeFromSuperview() }; return }
        // 상태만 바뀐 흔한 경우(busy → 완료)에는 탭 뷰를 다시 만들지 않는다. 다시 만들면
        // 제목의 shimmer 가 매번 처음부터 다시 시작해 깜빡이고, 애니메이션 레이어도 계속
        // 새로 붙었다 떨어진다. 구성이 그대로면 제자리에서 갱신만 한다.
        let tabs = stack.arrangedSubviews.compactMap { $0 as? DockTab }
        if tabs.count == group.panels.count,
           zip(tabs, group.panels).allSatisfy({ $0.panelId == $1.id }) {
            for (i, tab) in tabs.enumerated() {
                tab.update(active: i == group.activeIndex, groupActive: group.isActiveGroup)
            }
            DispatchQueue.main.async { [weak self] in self?.revealActiveTab() }
            return
        }
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, panel) in group.panels.enumerated() {
            let tab = DockTab(panel: panel, active: i == group.activeIndex, groupActive: group.isActiveGroup)
            tab.onSelect = { [weak group] in group?.select(id: panel.id) }
            tab.onClose = { [weak self] in self?.close(panel) }
            stack.addArrangedSubview(tab)
        }
        DispatchQueue.main.async { [weak self] in self?.revealActiveTab() }
    }

    /// 디버그: 이 바의 탭들이 지금 실제로 애니메이션 중인지 (렌더 트리의 presentation 값).
    func debugStatusReport() -> String {
        stack.arrangedSubviews.compactMap { ($0 as? DockTab)?.debugAnim() }.joined(separator: " | ")
    }

    private func close(_ panel: DockPanel) {
        guard let group, let mgr = group.manager else { return }
        if panel.closable { mgr.removePanel(panel) }
    }
}

// A single dock tab: icon + title + (optional) close button. Dragging it begins a
// panel move; the DockGroup under the cursor decides tab-vs-split on drop.
final class DockTab: NSView, NSDraggingSource {
    private let panel: DockPanel
    private var active: Bool
    private var groupActive: Bool
    override var mouseDownCanMoveWindow: Bool { false }   // tab drags rearrange panels, never move the window
    var onSelect: (() -> Void)?
    var onClose: (() -> Void)?
    private var underline: NSView?
    private var closeButton: HoverX?
    private let titleLabel = ShimmerLabel(labelWithString: "")
    private let statusDot = StatusPulseDot(diameter: UIScale.pt(7))
    private let iconView = NSImageView()
    var panelId: String { panel.id }

    init(panel: DockPanel, active: Bool, groupActive: Bool = true) {
        self.panel = panel; self.active = active; self.groupActive = groupActive
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = (active ? Theme.bg : NSColor.clear).cgColor
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: DockGroup.tabBarHeight).isActive = true
        // 폭 상한이 없으면 긴 제목("배포팀 · 리드")이 줄지 않고 바 밖으로 넘쳐 잘린다.
        // 상한을 두고 라벨의 압축 저항을 낮춰야 비로소 "…"로 잘린다.
        widthAnchor.constraint(lessThanOrEqualToConstant: UIScale.pt(200)).isActive = true
        widthAnchor.constraint(greaterThanOrEqualToConstant: UIScale.pt(84)).isActive = true

        let icon = iconView
        icon.image = panel.icon
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: panel.icon == nil ? 0 : UIScale.pt(14)).isActive = true
        icon.heightAnchor.constraint(equalToConstant: UIScale.pt(14)).isActive = true

        // 상태 점: 사람을 부르는 상태(승인 대기 / 완료)에만 뜬다. "작업 중"은 제목이
        // 훑리는 것으로 이미 말하고 있어서 점을 겹치지 않는다 — 레일의 에이전트 행과
        // 같은 어휘다.
        let badge = statusDot

        let title = titleLabel
        title.font = UIScale.font(UIScale.body)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)
        title.translatesAutoresizingMaskIntoConstraints = false

        let close = HoverX()
        close.isHidden = !panel.closable
        close.onClick = { [weak self] in self?.onClose?() }
        close.contentTintColor = Theme.fgDim
        close.translatesAutoresizingMaskIntoConstraints = false
        closeButton = close

        // 점은 늘 자리에 두고 상태에 따라 숨긴다 (NSStackView 는 숨은 뷰를 접는다).
        // 상태가 바뀔 때마다 탭을 다시 만들지 않기 위한 전제다.
        var views: [NSView] = panel.icon == nil ? [] : [icon]
        views.append(badge); views.append(title); views.append(close)
        let row = NSStackView(views: views)
        row.orientation = .horizontal; row.spacing = 6; row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: UIScale.pt(11)),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -UIScale.pt(9)),
            row.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])

        // right divider hairline (riven .dock-tab border-right)
        let sep = NSView(); sep.wantsLayer = true
        sep.layer?.backgroundColor = Theme.hairline.cgColor
        sep.translatesAutoresizingMaskIntoConstraints = false
        addSubview(sep)
        NSLayoutConstraint.activate([
            sep.trailingAnchor.constraint(equalTo: trailingAnchor),
            sep.topAnchor.constraint(equalTo: topAnchor),
            sep.bottomAnchor.constraint(equalTo: bottomAnchor),
            sep.widthAnchor.constraint(equalToConstant: 1)
        ])
        // 2px accent underline — full accent when the group is focused, faint
        // when it isn't (so only the focused pane shows the hot ember marker).
        // 탭을 다시 만들지 않고 활성 상태를 바꿀 수 있게 항상 만들어 두고 숨긴다.
        let u = NSView(); u.wantsLayer = true
        u.translatesAutoresizingMaskIntoConstraints = false
        addSubview(u)
        NSLayoutConstraint.activate([
            u.leadingAnchor.constraint(equalTo: leadingAnchor),
            u.trailingAnchor.constraint(equalTo: trailingAnchor),
            u.bottomAnchor.constraint(equalTo: bottomAnchor),
            u.heightAnchor.constraint(equalToConstant: 2)
        ])
        underline = u
        update(active: active, groupActive: groupActive)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// 제자리 갱신 — 제목·상태·활성 표시만 바꾼다 (탭 뷰를 다시 만들면 shimmer 가
    /// 매번 처음으로 되감기고 레이어가 계속 새로 붙는다).
    func update(active: Bool, groupActive: Bool) {
        self.active = active; self.groupActive = groupActive
        layer?.backgroundColor = (active ? Theme.bg : NSColor.clear).cgColor
        if titleLabel.stringValue != panel.title { titleLabel.stringValue = panel.title }
        // Active tab in the focused group is full-strength; in an unfocused group it's
        // muted; non-active tabs are dim. This is riven's focus cue (no border box).
        titleLabel.textColor = active ? (groupActive ? Theme.fg : Theme.fgDim)
                                      : Theme.fgDim.withAlphaComponent(0.7)
        let status = panel.status
        titleLabel.shimmering = status.shimmers
        statusDot.set(color: status.showsTabDot ? status.color : nil, pulsing: status.pulses)
        // 역할이 있는 에이전트 팬은 탭 아이콘도 그 에이전트의 아바타로 — 탭이 여러 개
        // 열려 있을 때 "이 탭이 누구인지"가 제목을 읽기 전에 보인다.
        let wanted = panel.avatarKey.flatMap {
            AgentAvatar.image(for: $0, override: panel.chatAvatar, size: UIScale.pt(12))
        } ?? panel.icon
        if iconView.image !== wanted { iconView.image = wanted }
        underline?.isHidden = !active
        underline?.layer?.backgroundColor =
            (groupActive ? Theme.accent : Theme.accent.withAlphaComponent(0.25)).cgColor
    }

    /// 디버그: 렌더 트리에서 지금 이 탭이 어떤 상태인지. presentation() 은 화면에 실제로
    /// 나가는 값이라, 애니메이션이 걸려만 있고 안 도는 경우를 구분할 수 있다.
    func debugAnim() -> String {
        let loc = (titleLabel.layer?.mask?.presentation() as? CAGradientLayer)?
            .locations?.first?.doubleValue
        let op = statusDot.isHidden ? nil : statusDot.layer?.presentation()?.opacity
        return "\(panel.title)[\(panel.status)] shimmer=\(loc.map { String(format: "%.2f", $0) } ?? "-")"
             + " dot=\(op.map { String(format: "%.2f", $0) } ?? "-")"
    }

    // Right-click: rename or close the panel.
    override func menu(for event: NSEvent) -> NSMenu? {
        let m = NSMenu()
        let rename = NSMenuItem(title: "이름 변경", action: #selector(renameTab), keyEquivalent: "")
        rename.target = self; m.addItem(rename)
        if panel.closable {
            m.addItem(.separator())
            let close = NSMenuItem(title: "닫기", action: #selector(closeFromMenu), keyEquivalent: "")
            close.target = self; m.addItem(close)
        }
        return m
    }
    @objc private func renameTab() {
        let a = NSAlert(); a.messageText = "패널 이름 변경"
        a.addButton(withTitle: "확인"); a.addButton(withTitle: "취소")
        let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24)); f.stringValue = panel.title
        a.accessoryView = f; a.window.initialFirstResponder = f
        if a.runModal() == .alertFirstButtonReturn {
            let v = f.stringValue.trimmingCharacters(in: .whitespaces)
            if !v.isEmpty { panel.title = v; panel.group?.tabBar.rebuild() }
        }
    }
    @objc private func closeFromMenu() { onClose?() }

    // Route all clicks/drags to the tab itself, except the × button (so both tab
    // selection and tab dragging work even though the label/icon sit on top).
    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        if let c = closeButton, !c.isHidden, hit === c { return c }
        return hit == nil ? nil : self
    }

    private var down: NSPoint = .zero
    private var dragging = false
    override func mouseDown(with e: NSEvent) { down = e.locationInWindow; dragging = false }
    override func mouseDragged(with e: NSEvent) {
        // Start a drag after moving a few points (so a click still selects).
        guard !dragging else { return }
        let d = hypot(e.locationInWindow.x - down.x, e.locationInWindow.y - down.y)
        guard d > 4 else { return }
        dragging = true
        guard let mgr = panel.group?.manager else { return }
        DockManager.draggingPanel = panel
        mgr.beginDrag()                       // add drop zones to every group
        let item = NSPasteboardItem()
        item.setString(panel.id, forType: dockPBType)
        let dragItem = NSDraggingItem(pasteboardWriter: item)
        dragItem.setDraggingFrame(bounds, contents: snapshot())
        beginDraggingSession(with: [dragItem], event: e, source: self)
    }
    override func mouseUp(with e: NSEvent) {
        if !dragging { onSelect?() }          // a plain click selects the tab
        dragging = false
    }

    func draggingSession(_ s: NSDraggingSession, sourceOperationMaskFor c: NSDraggingContext) -> NSDragOperation { .move }
    func draggingSession(_ s: NSDraggingSession, endedAt p: NSPoint, operation: NSDragOperation) {
        panel.group?.manager?.endDrag()
        DockManager.draggingPanel = nil
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
}

// A borderless "×" that tints on hover — the dock tab's close affordance.
final class HoverX: NSButton {
    var onClick: (() -> Void)?
    override init(frame: NSRect) {
        super.init(frame: frame)
        isBordered = false; imagePosition = .imageOnly
        image = NSImage(systemSymbolName: "xmark", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: UIScale.pt(9), weight: .semibold))
        target = self; action = #selector(fire)
        widthAnchor.constraint(equalToConstant: UIScale.pt(14)).isActive = true
        heightAnchor.constraint(equalToConstant: UIScale.pt(14)).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func fire() { onClick?() }
}
