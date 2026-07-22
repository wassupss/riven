import AppKit

// One color theme (matches riven's THEMES in state/themes.ts). Tokens are the
// same primitives riven layers over its :root palette; semantic colors fall back
// to the shared dark defaults unless a theme overrides them (light themes do).
struct ThemeDef {
    let id: String
    let name: String
    let shiki: String          // editor (Monaco/shiki) theme name
    let mode: String           // "dark" | "light"
    let bg, bg2, bg3, border, fg, fgDim, accent, accent2: String
    let success, warning, danger, info: String
}

// riven color themes + a runtime-switchable current palette. The default is
// `ember` — riven's factory default (state/settings.ts: theme:'ember') — so the
// native app matches the Electron app out of the box.
enum Theme {
    // Shared dark semantic defaults (used unless a theme overrides them).
    private static let dS = "#4cc38a", dW = "#e2b053", dD = "#e5534b", dI = "#5eb1ef"

    static let all: [ThemeDef] = [
        ThemeDef(id: "ember", name: "Ember", shiki: "dark-plus", mode: "dark",
                 bg: "#101113", bg2: "#16181b", bg3: "#1e2126", border: "#26292e",
                 fg: "#e3e5ea", fgDim: "#868d98", accent: "#ff7847", accent2: "#a18fff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "glacial", name: "Glacial", shiki: "night-owl", mode: "dark",
                 bg: "#0e1214", bg2: "#14191c", bg3: "#1c2327", border: "#242c30",
                 fg: "#e1e7e8", fgDim: "#839396", accent: "#3ec5b7", accent2: "#6ea8ff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "gold", name: "Gold", shiki: "kanagawa-wave", mode: "dark",
                 bg: "#121110", bg2: "#181613", bg3: "#201d18", border: "#2a2620",
                 fg: "#e7e3da", fgDim: "#948c7c", accent: "#e5b455", accent2: "#9d8cff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "rose", name: "Rose", shiki: "houston", mode: "dark",
                 bg: "#130f11", bg2: "#191315", bg3: "#221a1d", border: "#2d2327",
                 fg: "#e9e0e3", fgDim: "#96878c", accent: "#f0596e", accent2: "#a18fff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "slate", name: "Slate", shiki: "dark-plus", mode: "dark",
                 bg: "#0f1114", bg2: "#14171b", bg3: "#1c2026", border: "#262b32",
                 fg: "#e2e5ea", fgDim: "#848c99", accent: "#5b8fd0", accent2: "#9d8cff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "graphite", name: "Graphite", shiki: "dark-plus", mode: "dark",
                 bg: "#111113", bg2: "#171719", bg3: "#1f1f22", border: "#29292d",
                 fg: "#e4e4e7", fgDim: "#8a8a92", accent: "#7c86e8", accent2: "#a18fff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "abyss", name: "Abyss", shiki: "night-owl", mode: "dark",
                 bg: "#0d1217", bg2: "#12181e", bg3: "#192129", border: "#222c36",
                 fg: "#dfe7ec", fgDim: "#7e909c", accent: "#35c0e8", accent2: "#8f9dff",
                 success: dS, warning: dW, danger: dD, info: "#7cc4f5"),
        ThemeDef(id: "iris", name: "Iris", shiki: "houston", mode: "dark",
                 bg: "#100f15", bg2: "#16151d", bg3: "#1e1c26", border: "#282631",
                 fg: "#e5e3ee", fgDim: "#8b8898", accent: "#a48fff", accent2: "#6ec6ff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "fern", name: "Fern", shiki: "kanagawa-wave", mode: "dark",
                 bg: "#0e1310", bg2: "#131a16", bg3: "#1b241e", border: "#253028",
                 fg: "#e0e7e1", fgDim: "#83948a", accent: "#58c07a", accent2: "#a18fff",
                 success: "#7fd0a8", warning: dW, danger: dD, info: dI),
        ThemeDef(id: "orchid", name: "Orchid", shiki: "houston", mode: "dark",
                 bg: "#130f13", bg2: "#1a151a", bg3: "#231c23", border: "#2e252e",
                 fg: "#e9e2e9", fgDim: "#968a96", accent: "#d678db", accent2: "#9d8cff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "void", name: "Void", shiki: "dark-plus", mode: "dark",
                 bg: "#0a0a0c", bg2: "#0f0f12", bg3: "#161619", border: "#232327",
                 fg: "#f4f4f6", fgDim: "#9a9aa3", accent: "#eef0f3", accent2: "#a18fff",
                 success: dS, warning: dW, danger: dD, info: dI),
        ThemeDef(id: "paper", name: "Paper", shiki: "github-light", mode: "light",
                 bg: "#faf9f5", bg2: "#f2f0e9", bg3: "#e9e6dc", border: "#dbd6c8",
                 fg: "#2b2822", fgDim: "#6e675a", accent: "#b8430a", accent2: "#6d4fd0",
                 success: "#1d7a45", warning: "#8f6400", danger: "#bc3423", info: "#0f6cad"),
        ThemeDef(id: "daylight", name: "Daylight", shiki: "github-light", mode: "light",
                 bg: "#f6f8fa", bg2: "#eceff3", bg3: "#e2e6ec", border: "#d0d7de",
                 fg: "#1f2328", fgDim: "#59626d", accent: "#0969da", accent2: "#7a3ee8",
                 success: "#1a7f37", warning: "#9a6700", danger: "#cf222e", info: "#0b7285"),
        ThemeDef(id: "solarized-light", name: "Solarized Light", shiki: "solarized-light", mode: "light",
                 bg: "#fdf6e3", bg2: "#f3ecd7", bg3: "#eae2ca", border: "#d8cfb2",
                 fg: "#073642", fgDim: "#5c727c", accent: "#17699f", accent2: "#5c62c0",
                 success: "#5c7a00", warning: "#8f6c00", danger: "#c22f2c", info: "#17699f"),
    ]

    // The active theme, loaded from Settings (default ember). Mutated by apply().
    static var current: ThemeDef = all.first { $0.id == Settings.shared.string("theme", "ember") } ?? all[0]

    static func hex(_ s: String) -> NSColor {
        var h = s.hasPrefix("#") ? String(s.dropFirst()) : s
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        let v = UInt32(h, radix: 16) ?? 0
        return NSColor(calibratedRed: CGFloat((v >> 16) & 0xff) / 255,
                       green: CGFloat((v >> 8) & 0xff) / 255,
                       blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }

    // Token accessors — computed so they follow `current` after a live switch.
    static var bg: NSColor      { hex(current.bg) }
    static var bg2: NSColor     { hex(current.bg2) }
    static var bg3: NSColor     { hex(current.bg3) }
    static var border: NSColor  { hex(current.border) }
    static var fg: NSColor      { hex(current.fg) }
    static var fgDim: NSColor   { hex(current.fgDim) }
    static var accent: NSColor  { hex(current.accent) }
    static var accent2: NSColor { hex(current.accent2) }
    static var success: NSColor { hex(current.success) }
    static var warning: NSColor { hex(current.warning) }
    static var danger: NSColor  { hex(current.danger) }
    static var info: NSColor    { hex(current.info) }
    static var isLight: Bool    { current.mode == "light" }

    // Derived tokens (riven mixes these from the primitives in styles.css).
    static var accentMuted: NSColor { accent.withAlphaComponent(0.13) }            // --accent-muted
    static var accentBorder: NSColor { accent.withAlphaComponent(0.42) }          // --accent-border
    static var accent2Border: NSColor { accent2.withAlphaComponent(0.42) }        // --accent-2-border
    static var hoverStrong: NSColor { fg.withAlphaComponent(isLight ? 0.10 : 0.09) } // --hover-strong
    static var edgeStrong: NSColor { (isLight ? NSColor.black : .white).withAlphaComponent(isLight ? 0.18 : 0.14) } // --edge-strong
    static var hover: NSColor   { fg.withAlphaComponent(isLight ? 0.06 : 0.05) }  // --hover
    static var hairline: NSColor { (isLight ? NSColor.black : .white).withAlphaComponent(isLight ? 0.08 : 0.06) } // --hairline
    static var edge: NSColor    { (isLight ? NSColor.black : .white).withAlphaComponent(isLight ? 0.12 : 0.09) }  // --edge

    // git decoration colors — riven's exact --git-* tokens (VSCode-style working-tree
    // colours), not the generic semantic palette (untracked/renamed are GREEN, not blue).
    static var gitModified: NSColor  { isLight ? hex("#8f6a1e") : hex("#d3a45f") }  // amber
    static var gitAdded: NSColor     { isLight ? hex("#227d3f") : hex("#6cc08b") }  // green
    static var gitUntracked: NSColor { gitAdded }                                   // green
    static var gitRenamed: NSColor   { gitAdded }                                   // green
    static var gitDeleted: NSColor   { isLight ? hex("#a13a2a") : hex("#d16d5a") }  // red
    static var gitConflict: NSColor  { isLight ? hex("#c0393d") : hex("#e4676b") }  // strong red

    static let editorFont = "Monaco"
    static let uiFontSize: CGFloat = 12
    static let editorFontSize: CGFloat = 13

    // ---- live theme switching ----
    // Views that render themed chrome register here; apply() re-invokes their
    // color setup in place (no view recreation — recreating terminals crashes).
    private static var themables: [Weak] = []
    private final class Weak { weak var v: Themable?; init(_ v: Themable) { self.v = v } }
    static func register(_ v: Themable) { themables.append(Weak(v)) }

    // Switch the active theme by id, persist it, and re-theme all live chrome.
    // onEditorTheme receives the shiki theme name so Monaco can re-highlight.
    static func apply(id: String, onEditorTheme: ((String) -> Void)? = nil) {
        guard let def = all.first(where: { $0.id == id }) else { return }
        current = def
        Settings.shared.set("theme", id)
        NSApp.appearance = NSAppearance(named: def.mode == "light" ? .aqua : .darkAqua)
        themables.removeAll { $0.v == nil }
        for w in themables { w.v?.applyTheme() }
        onEditorTheme?(def.shiki)
    }
}

// A view that renders themed chrome and can re-apply its colors in place.
protocol Themable: AnyObject { func applyTheme() }
