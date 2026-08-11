import AppKit

// Shared control components + metrics.
//
// Sizes used to be hand-written at every call site (a height here, a bezel there, padding
// nowhere), so the same kind of control ended up a different size in each panel - and a field
// with no height constraint collapsed to its minimum. Build controls through these factories and
// they come out consistent, themed, and correctly sized.
enum UIMetrics {
    /// Standard control height (inputs, selects, buttons on one row).
    static var rowH: CGFloat { UIScale.pt(32) }
    /// Compact height for dense tables.
    static var rowHCompact: CGFloat { UIScale.pt(28) }
    static var radius: CGFloat { 6 }
    /// Text inset inside an input (NSTextField has none of its own).
    static var inputInset: NSSize { NSSize(width: 10, height: 6) }
    static var gap: CGFloat { 6 }
}

// NSTextField has no content inset, so with a layer-drawn border the text sits flush against the
// edge. This cell insets the text and the field editor alike.
final class PaddedFieldCell: NSTextFieldCell {
    var inset = UIMetrics.inputInset
    override func drawingRect(forBounds rect: NSRect) -> NSRect {
        super.drawingRect(forBounds: rect.insetBy(dx: inset.width, dy: inset.height))
    }
    override func edit(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, event: NSEvent?) {
        super.edit(withFrame: drawingRect(forBounds: rect), in: view, editor: editor, delegate: delegate, event: event)
    }
    override func select(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, start: Int, length: Int) {
        super.select(withFrame: drawingRect(forBounds: rect), in: view, editor: editor, delegate: delegate, start: start, length: length)
    }
}

/// A themed text input: rounded, 1pt border, padded, fixed row height. Re-themes itself.
final class RivenInput: NSTextField, Themable {
    private var mono = false
    convenience init(placeholder: String = "", mono: Bool = false, compact: Bool = false) {
        self.init(frame: .zero)
        self.mono = mono
        let c = PaddedFieldCell(textCell: "")
        c.isEditable = true; c.isSelectable = true; c.isScrollable = true; c.wraps = false
        cell = c
        placeholderString = placeholder
        isBordered = false; drawsBackground = false; focusRingType = .none
        usesSingleLineMode = true
        wantsLayer = true
        layer?.cornerRadius = UIMetrics.radius
        layer?.borderWidth = 1
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: compact ? UIMetrics.rowHCompact : UIMetrics.rowH).isActive = true
        applyFont(); applyTheme()
        Theme.register(self)
    }
    private func applyFont() { font = mono ? UIScale.mono(UIScale.body) : UIScale.font(UIScale.body) }
    func applyTheme() {
        textColor = Theme.fg
        layer?.backgroundColor = Theme.bg.cgColor
        layer?.borderColor = Theme.edge.cgColor
    }
    /// Strip the box (used when the field IS a table cell and the row draws the grid).
    func makeBare() {
        layer?.borderWidth = 0
        layer?.backgroundColor = NSColor.clear.cgColor
    }
}

/// A themed dropdown sized like RivenInput so they line up on one row.
final class RivenSelect: NSPopUpButton, Themable {
    convenience init(_ titles: [String], compact: Bool = false) {
        self.init(frame: .zero, pullsDown: false)
        addItems(withTitles: titles)
        font = UIScale.font(UIScale.body)
        bezelStyle = .roundRect
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: compact ? UIMetrics.rowHCompact : UIMetrics.rowH).isActive = true
        applyTheme()
        Theme.register(self)
    }
    func applyTheme() { contentTintColor = Theme.fg }
}

/// Outlined secondary button - same height/radius as the primary so the two line up
/// in a column or a row; used for non-committing actions next to a primary (add a row,
/// cancel, reset).
final class RivenSecondaryButton: NSButton, Themable {
    convenience init(_ title: String, target: AnyObject?, action: Selector) {
        self.init(frame: .zero)
        self.title = title
        self.target = target; self.action = action
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = UIMetrics.radius
        layer?.borderWidth = 1
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: UIMetrics.rowH).isActive = true
        applyTheme()
        Theme.register(self)
    }
    func applyTheme() {
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.borderColor = Theme.edge.cgColor
        contentTintColor = Theme.fg
        attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: Theme.fg, .font: UIScale.font(UIScale.body, .medium)])
    }
}

/// Flat underline tabs - the same tab language as the dock strip (text + a 2pt accent underline
/// under the active one, hairline baseline across the whole strip). NOT pills: a pill reads as a
/// filter chip, and a row of pills next to another row of pills reads as nothing at all.
final class RivenTabStrip: NSView, Themable, Scalable {
    /// (label, optional trailing count) per tab.
    var tabs: [(String, Int?)] = [] { didSet { rebuild() } }
    private(set) var selected = 0
    var onSelect: ((Int) -> Void)?

    private let row = NSStackView()
    private let scroll = NSScrollView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        row.orientation = .horizontal; row.spacing = 0; row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = row
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false; scroll.hasVerticalScroller = false
        scroll.horizontalScrollElasticity = .allowed; scroll.verticalScrollElasticity = .none
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            row.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            row.heightAnchor.constraint(equalTo: scroll.heightAnchor),
        ])
        heightAnchor.constraint(equalToConstant: UIScale.pt(32)).isActive = true
        Theme.register(self); UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func select(_ i: Int, notify: Bool = false) {
        guard i >= 0, i < tabs.count else { return }
        selected = i; rebuild()
        if notify { onSelect?(i) }
    }
    func applyTheme() { rebuild() }
    func applyScale() { rebuild() }

    /// 세로 델타를 가로 이동으로 (탭이 많아 넘칠 때 휠로 훑을 수 있게).
    override func scrollWheel(with e: NSEvent) {
        let dx = e.scrollingDeltaX != 0 ? e.scrollingDeltaX : e.scrollingDeltaY
        guard dx != 0 else { super.scrollWheel(with: e); return }
        let maxX = max(0, row.frame.width - scroll.contentView.bounds.width)
        let x = min(maxX, max(0, scroll.contentView.bounds.origin.x - dx))
        scroll.contentView.scroll(to: NSPoint(x: x, y: 0))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    // 아래쪽 하드라인(기준선)은 스트립 자신이 그린다 - 탭 사이 간격에서도 끊기지 않게.
    override func draw(_ dirty: NSRect) {
        Theme.hairline.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    }

    private func rebuild() {
        row.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, tab) in tabs.enumerated() {
            row.addArrangedSubview(TabItem(title: tab.0, count: tab.1, active: i == selected) { [weak self] in
                self?.select(i, notify: true)
            })
        }
        needsDisplay = true
    }

    private final class TabItem: NSView {
        private let onTap: () -> Void
        private let active: Bool
        private var hot = false
        private var track: NSTrackingArea?
        init(title: String, count: Int?, active: Bool, onTap: @escaping () -> Void) {
            self.onTap = onTap; self.active = active
            super.init(frame: .zero)
            wantsLayer = true
            translatesAutoresizingMaskIntoConstraints = false
            let label = NSTextField(labelWithString: title)
            label.font = UIScale.font(UIScale.body, active ? .semibold : .regular)
            label.textColor = active ? Theme.fg : Theme.fgDim
            label.translatesAutoresizingMaskIntoConstraints = false
            var views: [NSView] = [label]
            if let count {
                let c = NSTextField(labelWithString: "\(count)")
                c.font = UIScale.font(UIScale.caption, .medium)
                c.textColor = active ? Theme.accent : Theme.fgDim.withAlphaComponent(0.8)
                c.translatesAutoresizingMaskIntoConstraints = false
                views.append(c)
            }
            let stack = NSStackView(views: views)
            stack.orientation = .horizontal; stack.spacing = 5; stack.alignment = .firstBaseline
            stack.translatesAutoresizingMaskIntoConstraints = false
            addSubview(stack)
            let pad = UIScale.pt(13)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
                stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
                stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
        }
        required init?(coder: NSCoder) { fatalError() }
        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let t = track { removeTrackingArea(t) }
            let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
            addTrackingArea(t); track = t
        }
        override func hitTest(_ p: NSPoint) -> NSView? { bounds.contains(convert(p, from: superview)) ? self : nil }
        override func mouseEntered(with e: NSEvent) { hot = true; needsDisplay = true }
        override func mouseExited(with e: NSEvent) { hot = false; needsDisplay = true }
        override func mouseDown(with e: NSEvent) { onTap() }
        override func draw(_ dirty: NSRect) {
            if hot && !active {
                Theme.fgDim.withAlphaComponent(0.07).setFill()
                NSRect(x: 0, y: 1, width: bounds.width, height: bounds.height - 1).fill()
            }
            guard active else { return }
            Theme.accent.setFill()
            NSRect(x: 0, y: 0, width: bounds.width, height: 2).fill()
        }
    }
}

/// Filled primary button (accent) with a label colour picked for contrast.
final class RivenPrimaryButton: NSButton, Themable {
    convenience init(_ title: String, target: AnyObject?, action: Selector) {
        self.init(frame: .zero)
        self.title = title
        self.target = target; self.action = action
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = UIMetrics.radius
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: UIMetrics.rowH).isActive = true
        applyTheme()
        Theme.register(self)
    }
    /// Accent by default; pass a colour for destructive/alternate states.
    var fill: NSColor = Theme.accent { didSet { applyTheme() } }
    func applyTheme() {
        layer?.backgroundColor = fill.cgColor
        let on = ChatPanel.onColor(fill)
        contentTintColor = on
        attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: on, .font: UIScale.font(UIScale.body, .semibold)])
    }
}
