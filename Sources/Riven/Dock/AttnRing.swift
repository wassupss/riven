import AppKit

// riven's terminal-panel state ring (.terminal-panel.busy/.attn::after), drawn as
// a non-interactive overlay ABOVE the Metal terminal — an inset box-shadow on the
// panel itself would sit behind the edge-to-edge terminal surface and be invisible.
//
//  • busy  → a STATIC 1.5px inset ring in the violet "working" accent.
//  • attn  → a themed ember that TRAVELS around the border: a bright accent head
//            chasing a dim tail (riven clips a rotating conic-gradient to the ring).
//
// The ring band is a FIXED rounded-rect mask on a container layer; the conic
// gradient lives inside that container and only the gradient rotates, so the ring
// outline stays aligned to the panel while the bright head sweeps around it. (If we
// rotated the masked layer itself, the whole rounded rectangle would spin.)
final class AttnRingView: NSView {
    enum State { case none, busy, attn }

    private let container = CALayer()       // masked to the ring; holds the rotating gradient
    private let gradient = CAGradientLayer() // attn ember (conic), oversized so rotation always covers the band
    private let maskShape = CAShapeLayer()  // ring band = opaque → clips the gradient to a 1.5px ring
    private let busyRing = CAShapeLayer()   // static violet ring for the busy state
    private let lineW: CGFloat = 1.5
    private let radius: CGFloat = 2

    var state: State = .none { didSet { if state != oldValue { apply() } } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = false

        gradient.type = .conic
        // The ember: dim accent for most of the sweep, brightening to a hot head near
        // the end (≈350°) — the same stops riven uses in its conic-gradient.
        gradient.locations = [0.0, 0.56, 0.83, 0.97, 1.0]
        gradient.startPoint = CGPoint(x: 0.5, y: 0.5)
        gradient.endPoint = CGPoint(x: 0.5, y: 0.0)
        gradient.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        container.addSublayer(gradient)
        container.mask = maskShape
        container.isHidden = true
        layer?.addSublayer(container)

        maskShape.fillColor = NSColor.clear.cgColor
        maskShape.strokeColor = NSColor.black.cgColor   // opaque = the visible ring band
        maskShape.lineWidth = lineW

        busyRing.fillColor = NSColor.clear.cgColor
        busyRing.lineWidth = lineW
        busyRing.isHidden = true
        layer?.addSublayer(busyRing)
        applyColors()
    }
    required init?(coder: NSCoder) { fatalError() }

    // Never intercept clicks — the terminal underneath must stay interactive.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var mouseDownCanMoveWindow: Bool { false }

    override func layout() {
        super.layout()
        // Layer geometry changes shouldn't animate (they'd lag the resize).
        CATransaction.begin(); CATransaction.setDisableActions(true)
        container.frame = bounds
        // A stroked rounded-rect path, inset by half the line width so the 1.5px ring
        // sits fully inside the panel edge.
        let inset = lineW / 2
        let r = bounds.insetBy(dx: inset, dy: inset)
        let path = CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
        maskShape.frame = bounds; maskShape.path = path
        busyRing.frame = bounds; busyRing.path = path
        // Oversize the gradient (centered) so that at any rotation it still covers the
        // whole ring band — a bounds-sized square would leave the corners uncovered.
        let side = max(bounds.width, bounds.height) * 1.6
        gradient.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        gradient.position = CGPoint(x: bounds.midX, y: bounds.midY)
        CATransaction.commit()
    }

    // Re-read theme colors (accent / working accent) — called on theme change.
    func applyColors() {
        let accent = Theme.accent
        gradient.colors = [
            accent.withAlphaComponent(0.06).cgColor,
            accent.withAlphaComponent(0.06).cgColor,
            accent.withAlphaComponent(0.55).cgColor,
            accent.cgColor,
            accent.withAlphaComponent(0.06).cgColor,
        ]
        busyRing.strokeColor = Theme.accent2Border.cgColor
    }

    private func apply() {
        switch state {
        case .none:
            container.isHidden = true
            busyRing.isHidden = true
            gradient.removeAnimation(forKey: "spin")
        case .busy:
            container.isHidden = true
            gradient.removeAnimation(forKey: "spin")
            busyRing.strokeColor = Theme.accent2Border.cgColor
            busyRing.isHidden = false
        case .attn:
            busyRing.isHidden = true
            container.isHidden = false
            if gradient.animation(forKey: "spin") == nil {
                let spin = CABasicAnimation(keyPath: "transform.rotation.z")
                spin.fromValue = 0
                spin.toValue = 2 * Double.pi
                spin.duration = 2.2
                spin.repeatCount = .infinity
                spin.isRemovedOnCompletion = false
                gradient.add(spin, forKey: "spin")
            }
        }
    }
}
