import AppKit

// Global UI zoom (⌘+ / ⌘- / ⌘0). Electron riven gets this for free via the
// browser's page zoom - the whole renderer scales. Natively there's no single
// zoom knob, so we keep ONE factor here and route every chrome font + metric
// through it, then rebuild the affected components. The editor (Monaco font) and
// terminal (ghostty font) scale via their own font APIs so they stay crisp - this
// factor is the common multiplier that keeps all of it in lock-step.
enum UIScale {
    // Session-only (starts at 1.0 each launch) so the AppKit chrome, editor and
    // terminal never get out of sync after a relaunch - the terminal's ghostty font
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

    // Zoom applied to a USER-CHOSEN base size. The Settings font sizes (editorFontSize /
    // terminalFontSize) are the base; ⌘+/⌘−/⌘0 scale them. Keeping one formula here is
    // what makes zoom move the editor and terminal together with the rest of the chrome -
    // previously zoom pushed `baseFontSize` while the views re-asserted the raw setting,
    // so the two fought and the editor/terminal appeared not to zoom at all.
    static func scaled(_ base: Int) -> Int { max(8, Int((CGFloat(base) * factor).rounded())) }
    static var editorFontSize: Int { scaled(Settings.shared.int("editorFontSize", 13)) }
    static var terminalFontSize: Int { scaled(Settings.shared.int("terminalFontSize", 13)) }

    // ---- type scale -------------------------------------------------------
    // ONE ladder for the whole app. Sizes used to be picked ad-hoc per view (8, 9, 10, 10.5, 11,
    // 12, 12.5, 13, 14…), which is why panels looked inconsistent - one list 10pt, the next 12pt.
    // Use these names, not raw numbers:
    //   caption  meta//badges (timestamps, token counts, +N/−N)
    //   small    secondary text (paths, dim hints, compact buttons)
    //   body     default UI text (list rows, labels, fields)
    //   title    panel/section headers
    //   prose    chat message text - reading content, deliberately larger than chrome
    static let caption: CGFloat = 10.5
    static let small: CGFloat = 11.5
    static let body: CGFloat = 12.5
    static let title: CGFloat = 14
    static let prose: CGFloat = 14.5

    // Scale a design-time point metric (height, padding, radius…).
    static func pt(_ v: CGFloat) -> CGFloat { (v * factor).rounded() }
    // A scaled UI font / monospaced font.
    static func font(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .systemFont(ofSize: size * factor, weight: weight)
    }
    static func mono(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .monospacedSystemFont(ofSize: size * factor, weight: weight)
    }

    // Live re-scale broadcast, mirroring Theme.register / applyTheme. Persistent
    // panels register once; `broadcast()` (called from applyUIScale on ⌘+/⌘−/⌘0)
    // tells each to re-apply its fonts. Transient overlays don't register - they
    // read UIScale.font fresh every time they're opened.
    private static let scalables = NSHashTable<AnyObject>.weakObjects()
    static func register(_ v: Scalable) { scalables.add(v) }
    static func broadcast() { for case let s as Scalable in scalables.allObjects { s.applyScale() } }
}

protocol Scalable: AnyObject { func applyScale() }
