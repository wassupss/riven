import AppKit

// A top-anchored NSStackView for use as an NSScrollView documentView: AppKit
// clip views are bottom-left origin, so short content otherwise sinks to the
// bottom. Flipping the coordinate system top-aligns rows (search/git/changes).
final class FlippedStack: NSStackView {
    override var isFlipped: Bool { true }
}

// A view that never intercepts mouse events (for decorative overlays like the
// active-group focus ring).
final class PassthroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var mouseDownCanMoveWindow: Bool { false }
}

// An NSTextField cell that vertically centers its text (single-line inputs otherwise
// align the text to the top when the field is taller than the font).
final class VCenterTextFieldCell: NSTextFieldCell {
    private func centered(_ rect: NSRect) -> NSRect {
        let h = cellSize(forBounds: rect).height
        guard h < rect.height else { return rect }
        var r = rect; r.origin.y += (rect.height - h) / 2; r.size.height = h; return r
    }
    override func drawingRect(forBounds rect: NSRect) -> NSRect { super.drawingRect(forBounds: centered(rect)) }
    override func edit(withFrame rect: NSRect, in controlView: NSView, editor: NSText, delegate: Any?, event: NSEvent?) {
        super.edit(withFrame: centered(rect), in: controlView, editor: editor, delegate: delegate, event: event)
    }
    override func select(withFrame rect: NSRect, in controlView: NSView, editor: NSText, delegate: Any?, start: Int, length: Int) {
        super.select(withFrame: centered(rect), in: controlView, editor: editor, delegate: delegate, start: start, length: length)
    }
}

// A button with REAL internal padding (NSButton can't inset its title cleanly, so
// the old code hacked padding with spaces). Optional leading color dot (theme
// swatch). Rounded, themeable, with a click handler.
final class PadButton: NSView {
    private let label = NSTextField(labelWithString: "")
    private let dot = NSView()
    var onClick: (() -> Void)?
    var identifierString: String?

    init(title: String, font: NSFont, textColor: NSColor, bg: NSColor, border: NSColor,
         radius: CGFloat = 6, hPad: CGFloat = 12, height: CGFloat = 28, dotColor: NSColor? = nil) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = bg.cgColor
        layer?.cornerRadius = radius
        layer?.borderWidth = 1
        layer?.borderColor = border.cgColor
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: height).isActive = true

        label.stringValue = title; label.font = font; label.textColor = textColor
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        var leading = leadingAnchor
        var leadConst = hPad
        if let dotColor {
            dot.wantsLayer = true; dot.layer?.backgroundColor = dotColor.cgColor; dot.layer?.cornerRadius = 5.5
            dot.layer?.borderWidth = 1; dot.layer?.borderColor = Theme.edgeStrong.cgColor
            dot.translatesAutoresizingMaskIntoConstraints = false
            addSubview(dot)
            NSLayoutConstraint.activate([
                dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: hPad),
                dot.centerYAnchor.constraint(equalTo: centerYAnchor),
                dot.widthAnchor.constraint(equalToConstant: 11), dot.heightAnchor.constraint(equalToConstant: 11)])
            leading = dot.trailingAnchor; leadConst = 7
        }
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leading, constant: leadConst),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -hPad),
            label.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func mouseDown(with e: NSEvent) { onClick?() }
    func setTitle(_ s: String) { label.stringValue = s }
}

// Apple-style glassmorphism for floating dialogs (settings / add-panel / quick-open /
// command palette): a rounded NSVisualEffectView blur behind a translucent theme tint,
// with the window itself made transparent + shadowed. `content` is the panel's existing
// content view; a blur layer is inserted beneath everything and the content is tinted.
func installGlass(on panel: NSPanel, content: NSView, radius: CGFloat = 12) {
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true

    let blur = NSVisualEffectView(frame: content.bounds)
    blur.autoresizingMask = [.width, .height]
    blur.material = .hudWindow
    blur.blendingMode = .behindWindow
    blur.state = .active
    blur.wantsLayer = true
    blur.layer?.cornerRadius = radius
    blur.layer?.masksToBounds = true
    content.addSubview(blur, positioned: .below, relativeTo: content.subviews.first)

    content.wantsLayer = true
    content.layer?.cornerRadius = radius
    content.layer?.masksToBounds = true
    // A translucent theme tint over the blur — keeps the palette while frosted.
    content.layer?.backgroundColor = Theme.bg2.withAlphaComponent(0.72).cgColor
    content.layer?.borderWidth = 1
    content.layer?.borderColor = Theme.edge.cgColor
}

// Clamp a floating panel's frame to sit fully inside `parent`'s frame (with a margin),
// so a dialog anchored near an edge never spills past the app window.
func clampToWindow(_ panel: NSWindow, parent: NSWindow, margin: CGFloat = 8) {
    let p = parent.frame
    var f = panel.frame
    f.size.width = min(f.width, p.width - margin * 2)
    f.size.height = min(f.height, p.height - margin * 2)
    f.origin.x = min(max(f.minX, p.minX + margin), p.maxX - f.width - margin)
    f.origin.y = min(max(f.minY, p.minY + margin), p.maxY - f.height - margin)
    panel.setFrame(f, display: true)
}

// The dock header strip: behaves like a native titlebar — drag to move the window
// (via mouseDownCanMoveWindow), double-click to zoom per the user's macOS setting.
final class DraggableStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            // Match the system "double-click a window's title bar to…" action.
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" { window?.performMiniaturize(nil) }
            else if action != "None" { window?.performZoom(nil) }
        } else {
            super.mouseDown(with: event)
        }
    }
}
