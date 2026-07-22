import AppKit

// Material-Icon-Theme-style file-type icons — a native port of riven's
// components/FileIcon.tsx. Icons are drawn with CoreGraphics into a 16×16
// NSImage (no assets, no SVG dependency), matching riven's colors + glyphs:
// colored badges (TS/JS/GO/…), "#" marks (css/scss/less), folder glyphs, etc.
enum FileIcon {
    static let size: CGFloat = 15

    // Cache by resolved icon id so we draw each glyph once.
    private static var cache: [String: NSImage] = [:]

    static func image(name: String, isDir: Bool, open: Bool = false) -> NSImage {
        let id = isDir ? (open ? "folderOpen" : "folder") : iconId(for: name)
        if let img = cache[id] { return img }
        let img = draw(id)
        cache[id] = img
        return img
    }

    // ---- drawing ----
    private static func draw(_ id: String) -> NSImage {
        NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
            let ctx = NSGraphicsContext.current!.cgContext
            render(id, ctx)
            return true
        }
    }

    private static func color(_ hex: String) -> NSColor { Theme.hex(hex) }

    // Rounded-rect badge with centered label (TS, JS, GO, C++, …).
    private static func badge(_ ctx: CGContext, bg: String, label: String, fg: String = "#ffffff", fs: CGFloat = 7) {
        let rect = CGRect(x: 1, y: 1, width: 14, height: 14)
        let path = CGPath(roundedRect: rect, cornerWidth: 3, cornerHeight: 3, transform: nil)
        ctx.addPath(path); ctx.setFillColor(color(bg).cgColor); ctx.fillPath()
        text(ctx, label, size: fs, color: fg, weight: .bold, cx: 8, cy: 8)
    }

    // A centered text glyph (the "#" / "{ }" marks).
    private static func glyph(_ ctx: CGContext, _ s: String, color hex: String, size fs: CGFloat) {
        text(ctx, s, size: fs, color: hex, weight: .bold, cx: 8, cy: 8)
    }

    private static func text(_ ctx: CGContext, _ s: String, size: CGFloat, color hex: String,
                             weight: NSFont.Weight, cx: CGFloat, cy: CGFloat) {
        let font = NSFont.systemFont(ofSize: size, weight: weight)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color(hex)]
        let str = NSAttributedString(string: s, attributes: attrs)
        let sz = str.size()
        // CoreGraphics origin is bottom-left; NSAttributedString draws upright here.
        NSGraphicsContext.saveGraphicsState()
        str.draw(at: NSPoint(x: cx - sz.width / 2, y: cy - sz.height / 2))
        NSGraphicsContext.restoreGraphicsState()
        _ = ctx
    }

    private static func filledCircle(_ ctx: CGContext, cx: CGFloat, cy: CGFloat, r: CGFloat, _ hex: String) {
        ctx.setFillColor(color(hex).cgColor)
        ctx.fillEllipse(in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
    }

    private static func render(_ id: String, _ ctx: CGContext) {
        switch id {
        case "folder":
            ctx.setFillColor(color("#8bb3d9").cgColor)
            let p = CGMutablePath()
            p.move(to: CGPoint(x: 1, y: 3))
            p.addLine(to: CGPoint(x: 6, y: 3))
            p.addLine(to: CGPoint(x: 7.5, y: 4.5))
            p.addLine(to: CGPoint(x: 15, y: 4.5))
            p.addLine(to: CGPoint(x: 15, y: 13))
            p.addLine(to: CGPoint(x: 1, y: 13))
            p.closeSubpath()
            ctx.addPath(p); ctx.fillPath()
        case "folderOpen":
            ctx.setFillColor(color("#6f94ba").cgColor)
            ctx.fill(CGRect(x: 1, y: 4, width: 14, height: 9))
            ctx.setFillColor(color("#8bb3d9").cgColor)
            let p = CGMutablePath()
            p.move(to: CGPoint(x: 1, y: 4)); p.addLine(to: CGPoint(x: 15, y: 4))
            p.addLine(to: CGPoint(x: 13, y: 12)); p.addLine(to: CGPoint(x: 1, y: 12))
            p.closeSubpath(); ctx.addPath(p); ctx.fillPath()
        case "ts":       badge(ctx, bg: "#3178c6", label: "TS")
        case "tsx":      badge(ctx, bg: "#3178c6", label: "TSX", fs: 5.5)
        case "js":       badge(ctx, bg: "#f5de19", label: "JS", fg: "#2b2b2b")
        case "jsx":      badge(ctx, bg: "#20232a", label: "JSX", fg: "#61dafb", fs: 5.5)
        case "json":     glyph(ctx, "{}", color: "#fbc02d", size: 9)
        case "css":      glyph(ctx, "#", color: "#42a5f5", size: 13)
        case "scss":     glyph(ctx, "#", color: "#f06292", size: 13)
        case "less":     glyph(ctx, "#", color: "#7986cb", size: 13)
        case "html":     glyph(ctx, "<>", color: "#e44d26", size: 9)
        case "xml":      glyph(ctx, "<>", color: "#ffb300", size: 9)
        case "md":       badge(ctx, bg: "#42a5f5", label: "M↓", fs: 6.5)
        case "py":
            filledCircle(ctx, cx: 8, cy: 8, r: 6.6, "#4584b6")
            glyph(ctx, "Py", color: "#ffd43b", size: 6.5)
        case "rs":
            filledCircle(ctx, cx: 8, cy: 8, r: 6.8, "#ef6c30")
            glyph(ctx, "R", color: "#ffffff", size: 8)
        case "go":       badge(ctx, bg: "#00acd7", label: "GO", fs: 6.5)
        case "swift":
            filledCircle(ctx, cx: 8, cy: 8, r: 6.8, "#f05138")
            glyph(ctx, "S", color: "#ffffff", size: 8)
        case "java":     badge(ctx, bg: "#e76f00", label: "J", fs: 8.5)
        case "c":        badge(ctx, bg: "#0277bd", label: "C", fs: 8.5)
        case "cpp":      badge(ctx, bg: "#0288d1", label: "C++", fs: 6)
        case "h":        badge(ctx, bg: "#7e57c2", label: "H", fs: 8)
        case "sh":
            ctx.setFillColor(color("#37474f").cgColor)
            ctx.addPath(CGPath(roundedRect: CGRect(x: 1, y: 2.5, width: 14, height: 11), cornerWidth: 2, cornerHeight: 2, transform: nil))
            ctx.fillPath()
            glyph(ctx, ">_", color: "#89e051", size: 6)
        case "yaml":     glyph(ctx, "≣", color: "#ff5252", size: 12)
        case "toml":     badge(ctx, bg: "#9c4221", label: "T", fs: 8.5)
        case "sql":      badge(ctx, bg: "#e38c00", label: "SQL", fs: 5)
        case "image":
            ctx.setFillColor(color("#26a69a").cgColor)
            ctx.addPath(CGPath(roundedRect: CGRect(x: 1, y: 2.5, width: 14, height: 11), cornerWidth: 1.5, cornerHeight: 1.5, transform: nil))
            ctx.fillPath()
            filledCircle(ctx, cx: 5.2, cy: 10, r: 1.5, "#ffee58")
        case "svg":      glyph(ctx, "▽", color: "#ffb13b", size: 11)
        case "lock":
            ctx.setStrokeColor(color("#b0bec5").cgColor); ctx.setLineWidth(1.5)
            ctx.addArc(center: CGPoint(x: 8, y: 8.5), radius: 2.8, startAngle: 0, endAngle: .pi, clockwise: false)
            ctx.strokePath()
            ctx.setFillColor(color("#ffca28").cgColor)
            ctx.addPath(CGPath(roundedRect: CGRect(x: 3.4, y: 1.6, width: 9.2, height: 7.4), cornerWidth: 1.4, cornerHeight: 1.4, transform: nil))
            ctx.fillPath()
        case "git":
            filledCircle(ctx, cx: 4.7, cy: 12.4, r: 1.8, "#e84e31")
            filledCircle(ctx, cx: 4.7, cy: 3.6, r: 1.8, "#e84e31")
            filledCircle(ctx, cx: 11.6, cy: 10.6, r: 1.8, "#e84e31")
            ctx.setStrokeColor(color("#e84e31").cgColor); ctx.setLineWidth(1.4)
            ctx.move(to: CGPoint(x: 4.7, y: 5.4)); ctx.addLine(to: CGPoint(x: 4.7, y: 10.6)); ctx.strokePath()
        case "docker":   badge(ctx, bg: "#2396ed", label: "🐳", fs: 8)
        case "npm":      badge(ctx, bg: "#cb3837", label: "npm", fs: 5.5)
        case "tsconfig": badge(ctx, bg: "#3178c6", label: "TS", fs: 6)
        case "readme":
            filledCircle(ctx, cx: 8, cy: 8, r: 6.6, "#29b6f6")
            glyph(ctx, "i", color: "#ffffff", size: 8)
        case "license":  badge(ctx, bg: "#ffca28", label: "§", fg: "#5d4037", fs: 9)
        case "env":      glyph(ctx, "≡", color: "#fdd835", size: 12)
        default:
            // generic file glyph (follows the row's foreground)
            ctx.setFillColor(color("#9a9aa3").cgColor)
            let p = CGMutablePath()
            p.move(to: CGPoint(x: 3.5, y: 1)); p.addLine(to: CGPoint(x: 9.5, y: 1))
            p.addLine(to: CGPoint(x: 12.5, y: 4)); p.addLine(to: CGPoint(x: 12.5, y: 15))
            p.addLine(to: CGPoint(x: 3.5, y: 15)); p.closeSubpath()
            ctx.addPath(p); ctx.fillPath()
        }
    }

    // ---- name → icon id (mirrors riven's NAMES / EXTS tables) ----
    private static let names: [String: String] = [
        "package.json": "npm", "tsconfig.json": "tsconfig", "jsconfig.json": "tsconfig",
        "package-lock.json": "lock", "yarn.lock": "lock", "pnpm-lock.yaml": "lock", "cargo.lock": "lock",
        "readme.md": "readme", "readme": "readme", "license": "license", "licence": "license",
        "license.md": "license", "license.txt": "license", "dockerfile": "docker",
        ".gitignore": "git", ".gitattributes": "git", ".gitmodules": "git", ".env": "env"
    ]
    private static let exts: [String: String] = [
        "ts": "ts", "mts": "ts", "cts": "ts", "tsx": "tsx", "js": "js", "mjs": "js", "cjs": "js",
        "jsx": "jsx", "json": "json", "jsonc": "json", "json5": "json", "css": "css", "scss": "scss",
        "sass": "scss", "less": "less", "html": "html", "htm": "html", "xml": "xml", "md": "md",
        "markdown": "md", "mdx": "md", "py": "py", "pyw": "py", "rs": "rs", "go": "go", "swift": "swift",
        "java": "java", "c": "c", "cpp": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "hh": "cpp",
        "h": "h", "sh": "sh", "bash": "sh", "zsh": "sh", "fish": "sh", "yml": "yaml", "yaml": "yaml",
        "toml": "toml", "sql": "sql", "svg": "svg", "png": "image", "jpg": "image", "jpeg": "image",
        "gif": "image", "webp": "image", "ico": "image", "bmp": "image", "avif": "image",
        "lock": "lock", "env": "env"
    ]
    private static func iconId(for name: String) -> String {
        let n = name.lowercased()
        if let k = names[n] { return k }
        if n.hasPrefix("tsconfig") && n.hasSuffix(".json") { return "tsconfig" }
        if n == "dockerfile" || n.hasPrefix("dockerfile.") || n.hasPrefix("docker-compose") { return "docker" }
        if n.hasPrefix(".git") { return "git" }
        if n.hasPrefix(".env.") { return "env" }
        if n.hasPrefix("readme.") { return "readme" }
        if n.hasSuffix(".lock") { return "lock" }
        if let dot = n.lastIndex(of: "."), dot != n.startIndex {
            let ext = String(n[n.index(after: dot)...])
            if let byExt = exts[ext] { return byExt }
        }
        return "file"
    }
}
