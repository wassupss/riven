import AppKit

// Shared control components + metrics.
//
// Sizes used to be hand-written at every call site (a height here, a bezel there, padding
// nowhere), so the same kind of control ended up a different size in each panel — and a field
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
