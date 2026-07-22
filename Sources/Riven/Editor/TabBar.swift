import AppKit

// VS Code-style editor tab strip. Tracks open file paths, the active one, and
// dirty state; notifies on select / close.
final class TabBar: NSView, Themable {
    private(set) var tabs: [String] = []          // file paths, in order
    private(set) var active: String?
    private var dirty: Set<String> = []
    var onSelect: ((String) -> Void)?
    var onClose: ((String) -> Void)?
    var onCloseOthers: ((String) -> Void)?
    var onCloseAll: (() -> Void)?

    private let stack = NSStackView()
    private let scroll = NSScrollView()

    func closeOthers(except path: String) {
        for p in tabs where p != path { dirty.remove(p) }
        tabs = tabs.contains(path) ? [path] : []
        active = tabs.first
        rebuild()
    }
    func closeAll() { tabs = []; dirty = []; active = nil; rebuild() }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor
        stack.orientation = .horizontal
        stack.spacing = 0
        stack.alignment = .centerY
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false
        scroll.frame = bounds
        scroll.autoresizingMask = [.width, .height]
        addSubview(scroll)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentView.bottomAnchor)
        ])
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        rebuild()   // re-makes tabs with the current palette
    }

    func open(_ path: String) {
        if !tabs.contains(path) { tabs.append(path) }
        active = path
        rebuild()
    }
    func close(_ path: String) {
        guard let idx = tabs.firstIndex(of: path) else { return }
        tabs.remove(at: idx)
        dirty.remove(path)
        if active == path { active = tabs.indices.contains(idx) ? tabs[idx] : tabs.last }
        rebuild()
        if let a = active { onSelect?(a) }
    }
    func setActive(_ path: String) { active = path; rebuild() }
    func setDirty(_ path: String, _ isDirty: Bool) {
        if isDirty { dirty.insert(path) } else { dirty.remove(path) }
        rebuild()
    }
    func isDirty(_ path: String) -> Bool { dirty.contains(path) }

    private func rebuild() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for path in tabs {
            stack.addArrangedSubview(makeTab(path))
        }
    }

    private func makeTab(_ path: String) -> NSView {
        let isActive = path == active
        let isDirty = dirty.contains(path)
        let name = (path as NSString).lastPathComponent
        let tab = TabButton(path: path)
        tab.wantsLayer = true
        // riven .file-tab.active: background melts into the editor canvas (--bg).
        tab.layer?.backgroundColor = (isActive ? Theme.bg : NSColor.clear).cgColor
        tab.onSelect = { [weak self] in self?.onSelect?(path) }
        tab.onClose = { [weak self] in self?.onClose?(path) }
        tab.onContextMenu = { [weak self] event in self?.showMenu(for: path, event: event, in: tab) }

        let label = NSTextField(labelWithString: name)
        label.font = .systemFont(ofSize: 12)
        label.textColor = isActive ? Theme.fg : Theme.fgDim
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false

        // Trailing dirty dot (riven .tab-dirty-dot: 11px, --fg, only when unsaved).
        let dot = NSTextField(labelWithString: isDirty ? "●" : "")
        dot.font = .systemFont(ofSize: 9); dot.textColor = Theme.fg
        dot.translatesAutoresizingMaskIntoConstraints = false

        let close = HoverCloseX(); close.onClick = { [weak tab] in tab?.closeClicked() }
        close.translatesAutoresizingMaskIntoConstraints = false

        tab.addSubview(label); tab.addSubview(dot); tab.addSubview(close)
        tab.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            tab.heightAnchor.constraint(equalToConstant: 28),
            tab.widthAnchor.constraint(greaterThanOrEqualToConstant: 92),
            tab.widthAnchor.constraint(lessThanOrEqualToConstant: 200),
            label.leadingAnchor.constraint(equalTo: tab.leadingAnchor, constant: 12),
            label.centerYAnchor.constraint(equalTo: tab.centerYAnchor),
            dot.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: 5),
            dot.centerYAnchor.constraint(equalTo: tab.centerYAnchor),
            close.leadingAnchor.constraint(greaterThanOrEqualTo: dot.trailingAnchor, constant: 4),
            close.trailingAnchor.constraint(equalTo: tab.trailingAnchor, constant: -8),
            close.centerYAnchor.constraint(equalTo: tab.centerYAnchor)
        ])
        // 2px ember underline on the active tab (riven box-shadow: inset 0 -2px accent).
        if isActive {
            let u = NSView(); u.wantsLayer = true; u.layer?.backgroundColor = Theme.accent.cgColor
            u.translatesAutoresizingMaskIntoConstraints = false
            tab.addSubview(u)
            NSLayoutConstraint.activate([
                u.leadingAnchor.constraint(equalTo: tab.leadingAnchor),
                u.trailingAnchor.constraint(equalTo: tab.trailingAnchor),
                u.bottomAnchor.constraint(equalTo: tab.bottomAnchor),
                u.heightAnchor.constraint(equalToConstant: 2)
            ])
        }
        // right border (hairline)
        let border = NSView(); border.wantsLayer = true
        border.layer?.backgroundColor = Theme.hairline.cgColor
        border.translatesAutoresizingMaskIntoConstraints = false
        tab.addSubview(border)
        NSLayoutConstraint.activate([
            border.trailingAnchor.constraint(equalTo: tab.trailingAnchor),
            border.topAnchor.constraint(equalTo: tab.topAnchor),
            border.bottomAnchor.constraint(equalTo: tab.bottomAnchor),
            border.widthAnchor.constraint(equalToConstant: 1)
        ])
        return tab
    }
}

// The tab's close affordance: a 12px ✕ at 55% opacity that turns red on hover
// (riven .file-tab-close). Clicking it closes the tab without selecting it.
final class HoverCloseX: NSView {
    var onClick: (() -> Void)?
    private let x = NSTextField(labelWithString: "✕")
    private var tracking: NSTrackingArea?
    override init(frame: NSRect) {
        super.init(frame: frame)
        x.font = .systemFont(ofSize: 10); x.textColor = Theme.fgDim
        x.alphaValue = 0.55
        x.translatesAutoresizingMaskIntoConstraints = false
        addSubview(x)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 16), heightAnchor.constraint(equalToConstant: 16),
            x.centerXAnchor.constraint(equalTo: centerXAnchor), x.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(t); tracking = t
    }
    override func mouseEntered(with e: NSEvent) { x.textColor = Theme.danger; x.alphaValue = 1 }
    override func mouseExited(with e: NSEvent) { x.textColor = Theme.fgDim; x.alphaValue = 0.55 }
    override func mouseDown(with e: NSEvent) {}   // swallow so the tab isn't selected
    override func mouseUp(with e: NSEvent) { if bounds.contains(convert(e.locationInWindow, from: nil)) { onClick?() } }
}

// A clickable tab (select on click, close via ✕, right-click for a menu).
final class TabButton: NSView {
    let path: String
    var onSelect: (() -> Void)?
    var onClose: (() -> Void)?
    var onContextMenu: ((NSEvent) -> Void)?
    var onDragEnd: ((_ windowPoint: NSPoint) -> Void)?   // dragged tab released → maybe split
    private var dragStart: NSPoint?
    private var dragging = false
    init(path: String) { self.path = path; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    // Select on click; DRAG the tab to split the editor (release over the editor area).
    override func mouseDown(with event: NSEvent) { dragStart = event.locationInWindow; dragging = false }
    override func mouseDragged(with event: NSEvent) {
        guard let s = dragStart else { return }
        let p = event.locationInWindow
        if abs(p.x - s.x) > 10 || abs(p.y - s.y) > 10 { dragging = true }
    }
    override func mouseUp(with event: NSEvent) {
        if dragging { onDragEnd?(event.locationInWindow) } else { onSelect?() }
        dragging = false; dragStart = nil
    }
    override func rightMouseDown(with event: NSEvent) { onContextMenu?(event) }
    @objc func closeClicked() { onClose?() }
}

extension TabBar {
    fileprivate func showMenu(for path: String, event: NSEvent, in view: NSView) {
        let menu = NSMenu()
        menu.addItem(withTitle: "닫기", action: #selector(menuClose), keyEquivalent: "").representedObject = path
        menu.addItem(withTitle: "다른 탭 닫기", action: #selector(menuCloseOthers), keyEquivalent: "").representedObject = path
        menu.addItem(withTitle: "모두 닫기", action: #selector(menuCloseAll), keyEquivalent: "")
        for it in menu.items { it.target = self }
        NSMenu.popUpContextMenu(menu, with: event, for: view)
    }
    @objc fileprivate func menuClose(_ s: NSMenuItem) { if let p = s.representedObject as? String { onClose?(p) } }
    @objc fileprivate func menuCloseOthers(_ s: NSMenuItem) { if let p = s.representedObject as? String { onCloseOthers?(p) } }
    @objc fileprivate func menuCloseAll(_ s: NSMenuItem) { onCloseAll?() }
}
