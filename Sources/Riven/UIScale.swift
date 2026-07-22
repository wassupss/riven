import AppKit

// Global UI zoom (⌘+ / ⌘- / ⌘0). Electron riven gets this for free via the
// browser's page zoom — the whole renderer scales. Natively there's no single
// zoom knob, so we keep ONE factor here and route every chrome font + metric
// through it, then rebuild the affected components. The editor (Monaco font) and
// terminal (ghostty font) scale via their own font APIs so they stay crisp — this
// factor is the common multiplier that keeps all of it in lock-step.
enum UIScale {
    // Session-only (starts at 1.0 each launch) so the AppKit chrome, editor and
    // terminal never get out of sync after a relaunch — the terminal's ghostty font
    // zoom is relative-only and can't be restored to an absolute size at startup.
    private(set) static var factor: CGFloat = 1

    static let minPct = 60, maxPct = 200

    // Nudge the zoom one step (±10%). Returns the base editor/terminal font size
    // (13pt design base × factor, rounded) so callers can push it to Monaco/ghostty.
    @discardableResult
    static func step(_ delta: Int) -> Int {
        let pct = max(minPct, min(maxPct, Int((factor * 100).rounded()) + delta * 10))
        factor = CGFloat(pct) / 100
        return baseFontSize
    }
    @discardableResult
    static func reset() -> Int {
        factor = 1
        return baseFontSize
    }

    // The editor/terminal font size that corresponds to the current zoom (12 base).
    static var baseFontSize: Int { max(8, Int((12 * factor).rounded())) }

    // Scale a design-time point metric (height, padding, radius…).
    static func pt(_ v: CGFloat) -> CGFloat { (v * factor).rounded() }
    // A scaled UI font / monospaced font.
    static func font(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .systemFont(ofSize: size * factor, weight: weight)
    }
    static func mono(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .monospacedSystemFont(ofSize: size * factor, weight: weight)
    }
}
