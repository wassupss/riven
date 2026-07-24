import AppKit

// Material-Icon-Theme-style file-type icons — a faithful native port of riven's
// components/FileIcon.tsx. The recognizable glyphs (React atom for tsx/jsx, the
// Python two-snake mark, the Docker whale, the git branch, npm, the SQL cylinder,
// etc.) are reproduced by re-using the *exact* SVG path/shape data from the TSX
// source and rendering it with CoreGraphics — no assets, no SVG runtime.
//
// Coordinates are authored in SVG space (viewBox 0 0 16 16, y-down). `drawVector`
// flips the CTM once so those numbers map straight onto the 16×16 NSImage. Plain
// text badges (TS/JS/GO/…) that were text in the original stay text.
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
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
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

    // Draw upright text. cx/cy are in device space (y-up, origin bottom-left);
    // for an SVG y coordinate pass `16 - y`.
    private static func text(_ ctx: CGContext, _ s: String, size: CGFloat, color hex: String,
                             weight: NSFont.Weight, cx: CGFloat, cy: CGFloat) {
        let font = NSFont.systemFont(ofSize: size, weight: weight)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color(hex)]
        let str = NSAttributedString(string: s, attributes: attrs)
        let sz = str.size()
        NSGraphicsContext.saveGraphicsState()
        str.draw(at: NSPoint(x: cx - sz.width / 2, y: cy - sz.height / 2))
        NSGraphicsContext.restoreGraphicsState()
        _ = ctx
    }

    private static func filledCircle(_ ctx: CGContext, cx: CGFloat, cy: CGFloat, r: CGFloat, _ hex: String) {
        ctx.setFillColor(color(hex).cgColor)
        ctx.fillEllipse(in: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
    }

    // ---- vector primitives (SVG y-down space) ----
    private enum Shape {
        case path(String)                                        // SVG `d`
        case rect(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)   // x, y, w, h, rx
        case circle(CGFloat, CGFloat, CGFloat)                   // cx, cy, r
        case ellipse(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat) // cx, cy, rx, ry, rotateDeg
    }
    private struct Prim {
        var shape: Shape
        var fill: String? = nil
        var stroke: String? = nil
        var width: CGFloat = 1
        var rotate: (CGFloat, CGFloat, CGFloat)? = nil          // deg, cx, cy (about a point)
    }
    private static func fill(_ s: Shape, _ hex: String) -> Prim { Prim(shape: s, fill: hex) }
    private static func stroke(_ s: Shape, _ hex: String, _ w: CGFloat) -> Prim { Prim(shape: s, stroke: hex, width: w) }
    private static func fillStroke(_ s: Shape, _ f: String, _ st: String, _ w: CGFloat) -> Prim {
        Prim(shape: s, fill: f, stroke: st, width: w)
    }
    private static func rotated(_ p: Prim, _ deg: CGFloat, _ cx: CGFloat, _ cy: CGFloat) -> Prim {
        var q = p; q.rotate = (deg, cx, cy); return q
    }

    private static func cgPath(_ shape: Shape) -> CGPath {
        switch shape {
        case .path(let d):
            return SVGPath.parse(d)
        case .rect(let x, let y, let w, let h, let r):
            return r > 0
                ? CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil)
                : CGPath(rect: CGRect(x: x, y: y, width: w, height: h), transform: nil)
        case .circle(let cx, let cy, let r):
            return CGPath(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2), transform: nil)
        case .ellipse(let cx, let cy, let rx, let ry, let rot):
            var t = CGAffineTransform(translationX: cx, y: cy).rotated(by: rot * .pi / 180)
            return CGPath(ellipseIn: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2), transform: &t)
        }
    }

    // Render a list of primitives, flipping SVG y-down onto the y-up image.
    private static func drawVector(_ ctx: CGContext, _ prims: [Prim]) {
        ctx.saveGState()
        ctx.translateBy(x: 0, y: 16)
        ctx.scaleBy(x: 1, y: -1)
        for p in prims {
            var path = cgPath(p.shape)
            if let (deg, cx, cy) = p.rotate {
                var t = CGAffineTransform(translationX: cx, y: cy)
                    .rotated(by: deg * .pi / 180)
                    .translatedBy(x: -cx, y: -cy)
                path = path.copy(using: &t) ?? path
            }
            if let f = p.fill {
                ctx.addPath(path); ctx.setFillColor(color(f).cgColor); ctx.fillPath()
            }
            if let s = p.stroke {
                ctx.addPath(path); ctx.setStrokeColor(color(s).cgColor)
                ctx.setLineWidth(p.width); ctx.setLineCap(.round); ctx.setLineJoin(.round)
                ctx.strokePath()
            }
        }
        ctx.restoreGState()
    }

    // React atom (tsx/jsx): three tilted orbits + a nucleus, in one color.
    private static func atom(_ ctx: CGContext, _ hex: String) {
        drawVector(ctx, [
            stroke(.ellipse(8, 8, 6.4, 2.5, 0), hex, 1),
            stroke(.ellipse(8, 8, 6.4, 2.5, 60), hex, 1),
            stroke(.ellipse(8, 8, 6.4, 2.5, 120), hex, 1),
            fill(.circle(8, 8, 1.6), hex),
        ])
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

        // ---- text badges (text in the original too) ----
        case "ts":   badge(ctx, bg: "#3178c6", label: "TS")
        case "js":   badge(ctx, bg: "#f5de19", label: "JS", fg: "#2b2b2b")
        case "json": glyph(ctx, "{ }", color: "#fbc02d", size: 8)
        case "css":  glyph(ctx, "#", color: "#42a5f5", size: 13)
        case "scss": glyph(ctx, "#", color: "#f06292", size: 13)
        case "less": glyph(ctx, "#", color: "#7986cb", size: 13)
        case "go":   badge(ctx, bg: "#00acd7", label: "GO", fs: 6.5)
        case "c":    badge(ctx, bg: "#0277bd", label: "C", fs: 8.5)
        case "cpp":  badge(ctx, bg: "#0288d1", label: "C++", fs: 6)
        case "h":    badge(ctx, bg: "#7e57c2", label: "H", fs: 8)
        case "toml": badge(ctx, bg: "#9c4221", label: "T", fs: 8.5)
        case "rs":
            filledCircle(ctx, cx: 8, cy: 8, r: 6.8, "#ef6c30")
            glyph(ctx, "R", color: "#ffffff", size: 8.5)

        // ---- faithful vector glyphs ----
        case "tsx": atom(ctx, "#3178c6")
        case "jsx": atom(ctx, "#61dafb")
        case "html":
            drawVector(ctx, [
                fill(.path("M5.3 4.2L1.6 8l3.7 3.8 1.1-1.1L3.8 8l2.6-2.7z"), "#e44d26"),
                fill(.path("M10.7 4.2L14.4 8l-3.7 3.8-1.1-1.1L12.2 8 9.6 5.3z"), "#e44d26"),
                fill(.path("M8.8 3.4h1.5L7.2 12.6H5.7z"), "#e44d26"),
            ])
        case "xml":
            drawVector(ctx, [
                fill(.path("M5.3 4.2L1.6 8l3.7 3.8 1.1-1.1L3.8 8l2.6-2.7z"), "#ffb300"),
                fill(.path("M10.7 4.2L14.4 8l-3.7 3.8-1.1-1.1L12.2 8 9.6 5.3z"), "#ffb300"),
            ])
        case "md":
            drawVector(ctx, [
                fill(.rect(0.5, 3.2, 15, 9.6, 1.6), "#42a5f5"),
                fill(.path("M2.5 10.4V5.6h1.6L6 8l1.9-2.4h1.6v4.8H7.8V8.1L6 10.3 4.2 8.1v2.3z"), "#ffffff"),
                fill(.path("M12.1 5.6h1.7v2.5h1.5L13 10.9l-2.4-2.8h1.5z"), "#ffffff"),
            ])
        case "py":
            let body = "M8 1.2c-2.1 0-3.3.9-3.3 2.4v1.2h3.4v.7H3.9c-1.6 0-2.8 1.1-2.8 2.8 0 1.6 1.1 2.7 2.6 2.7h1.4V9.3c0-1.5 1.2-2.7 2.7-2.7h2.6c1.2 0 2.2-1 2.2-2.2V3.6c0-1.4-1.5-2.4-3.5-2.4z"
            drawVector(ctx, [
                fill(.path(body), "#4584b6"),
                fill(.circle(6.2, 3, 0.8), "#ffffff"),
                rotated(fill(.path(body), "#ffd43b"), 180, 8, 8),
                rotated(fill(.circle(6.2, 3, 0.8), "#ffffff"), 180, 8, 8),
            ])
        case "java":
            drawVector(ctx, [
                fill(.path("M3.5 8h8v3.2A2.8 2.8 0 018.7 14H6.3a2.8 2.8 0 01-2.8-2.8z"), "#e76f00"),
                stroke(.path("M11.5 9h1.2a1.6 1.6 0 010 3.2h-1.4"), "#e76f00", 1.2),
                stroke(.path("M6.4 6.4c-1-1 1-1.7 0-3.2"), "#f89820", 1.1),
                stroke(.path("M9 6.4c-1-1 1-1.7 0-3.2"), "#f89820", 1.1),
            ])
        case "sh":
            drawVector(ctx, [
                fill(.rect(1, 2.5, 14, 11, 1.8), "#37474f"),
                stroke(.path("M3.6 6l2.3 2-2.3 2"), "#89e051", 1.4),
                stroke(.path("M7.4 10.6h3.8"), "#89e051", 1.4),
            ])
        case "yaml":
            drawVector(ctx, [
                fill(.rect(1.5, 3, 2.6, 1.6, 0.5), "#ff5252"),
                fill(.rect(5.3, 3, 9.2, 1.6, 0.5), "#ff5252"),
                fill(.rect(1.5, 7.2, 2.6, 1.6, 0.5), "#ff5252"),
                fill(.rect(5.3, 7.2, 9.2, 1.6, 0.5), "#ff5252"),
                fill(.rect(1.5, 11.4, 2.6, 1.6, 0.5), "#ff5252"),
                fill(.rect(5.3, 11.4, 6, 1.6, 0.5), "#ff5252"),
            ])
        case "sql":
            drawVector(ctx, [
                fill(.path("M2.5 3.6v8.8c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1V3.6"), "#ffca28"),
                fill(.ellipse(8, 3.6, 5.5, 2.1, 0), "#ffd54f"),
                stroke(.path("M2.5 6.9c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1"), "#c79100", 0.9),
                stroke(.path("M2.5 9.9c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1"), "#c79100", 0.9),
            ])
        case "svg":
            drawVector(ctx, [
                stroke(.path("M3 12.5C5.2 4.5 10.8 11.5 13 3.8"), "#ffb13b", 1.4),
                fill(.rect(1.6, 11.1, 2.8, 2.8, 0), "#ffb13b"),
                fill(.rect(11.6, 2.4, 2.8, 2.8, 0), "#ffb13b"),
            ])
        case "image":
            drawVector(ctx, [
                fill(.rect(1, 2.5, 14, 11, 1.5), "#26a69a"),
                fill(.circle(5.2, 6, 1.5), "#ffee58"),
                fill(.path("M3 13.5l3.6-4.5 2.4 2.6 2-2.2 3.5 4.1z"), "#00695c"),
            ])
        case "lock":
            drawVector(ctx, [
                stroke(.path("M5.2 7.2V5.4a2.8 2.8 0 015.6 0v1.8"), "#b0bec5", 1.5),
                fill(.rect(3.4, 7, 9.2, 7.4, 1.4), "#ffca28"),
                fill(.circle(8, 10, 1.2), "#795548"),
                fill(.rect(7.4, 10.6, 1.2, 2, 0.6), "#795548"),
            ])
        case "env":
            drawVector(ctx, [
                stroke(.path("M2 4.2h12"), "#fdd835", 1.3),
                stroke(.path("M2 8h12"), "#fdd835", 1.3),
                stroke(.path("M2 11.8h12"), "#fdd835", 1.3),
                fillStroke(.circle(10.5, 4.2, 1.9), "#fdd835", "#15161a", 1),
                fillStroke(.circle(5.5, 8, 1.9), "#fdd835", "#15161a", 1),
                fillStroke(.circle(11.5, 11.8, 1.9), "#fdd835", "#15161a", 1),
            ])
        case "git":
            drawVector(ctx, [
                stroke(.path("M4.7 5.4v5.6"), "#e84e31", 1.4),
                stroke(.path("M11.6 7.2c0 2.6-2.6 3.4-6 3.7"), "#e84e31", 1.4),
                fill(.circle(4.7, 3.6, 1.8), "#e84e31"),
                fill(.circle(4.7, 12.4, 1.8), "#e84e31"),
                fill(.circle(11.6, 5.4, 1.8), "#e84e31"),
            ])
        case "docker":
            drawVector(ctx, [
                fill(.rect(1.8, 6.2, 2.3, 2.1, 0), "#2396ed"),
                fill(.rect(4.5, 6.2, 2.3, 2.1, 0), "#2396ed"),
                fill(.rect(7.2, 6.2, 2.3, 2.1, 0), "#2396ed"),
                fill(.rect(4.5, 3.7, 2.3, 2.1, 0), "#2396ed"),
                fill(.path("M.7 9.2h14.6c-.6 2.9-3 4.6-6.7 4.6-3.9 0-6.7-1.7-7.9-4.6z"), "#2396ed"),
            ])
        case "npm":
            drawVector(ctx, [
                fill(.rect(1, 1, 14, 14, 3), "#cb3837"),
                fill(.path("M3.5 5h9v6H9.1V7.3H7.4V11H3.5z"), "#ffffff"),
            ])
        case "tsconfig":
            drawVector(ctx, [
                fill(.rect(1, 1, 14, 14, 3), "#3178c6"),
                fill(.circle(11.6, 11.6, 2.2), "#ffffff"),
                fill(.rect(11, 8.7, 1.2, 5.8, 0), "#ffffff"),
                fill(.rect(8.7, 11, 5.8, 1.2, 0), "#ffffff"),
                fill(.circle(11.6, 11.6, 1), "#3178c6"),
            ])
            text(ctx, "TS", size: 6.5, color: "#ffffff", weight: .bold, cx: 6.7, cy: 16 - 6.6)
        case "readme":
            drawVector(ctx, [
                fill(.circle(8, 8, 6.6), "#29b6f6"),
                fill(.circle(8, 4.9, 1.1), "#ffffff"),
                fill(.rect(7.1, 6.8, 1.8, 5, 0.9), "#ffffff"),
            ])
        case "license":
            drawVector(ctx, [
                fill(.path("M5.7 8.4l-1.3 5.2 2-.9.9 1.8 1.4-4.6z"), "#ef5350"),
                fill(.path("M10.3 8.4l1.3 5.2-2-.9-.9 1.8-1.4-4.6z"), "#ef5350"),
                fill(.circle(8, 5.6, 4.2), "#ffca28"),
                fill(.circle(8, 5.6, 2.3), "#f9a825"),
            ])
        default:
            // generic file glyph
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

// Minimal SVG path-data parser → CGPath. Supports M/L/H/V/C/S/Q/T/A (+ relative
// lowercase) and Z, with implicit command repetition and packed arc flags —
// enough to reproduce riven's inline icon glyphs verbatim.
private enum SVGPath {
    static func parse(_ d: String) -> CGPath {
        let path = CGMutablePath()
        let s = Array(d)
        var i = 0
        let n = s.count
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var cmd: Character = " "
        var prevCmd: Character = " "
        var prevCtrl: CGPoint? = nil

        func skipSep() {
            while i < n, s[i] == " " || s[i] == "," || s[i] == "\n" || s[i] == "\t" || s[i] == "\r" { i += 1 }
        }
        func readNum() -> CGFloat {
            skipSep()
            var str = ""
            var seenDot = false
            if i < n, s[i] == "+" || s[i] == "-" { str.append(s[i]); i += 1 }
            loop: while i < n {
                let c = s[i]
                switch c {
                case "0"..."9": str.append(c); i += 1
                case ".":
                    if seenDot { break loop }
                    seenDot = true; str.append(c); i += 1
                case "e", "E":
                    str.append(c); i += 1
                    if i < n, s[i] == "+" || s[i] == "-" { str.append(s[i]); i += 1 }
                default: break loop
                }
            }
            return CGFloat(Double(str) ?? 0)
        }
        func readFlag() -> Bool {
            skipSep()
            guard i < n else { return false }
            let c = s[i]; i += 1
            return c == "1"
        }
        func peekIsNum() -> Bool {
            skipSep()
            guard i < n else { return false }
            let c = s[i]
            return c.isNumber || c == "." || c == "-" || c == "+"
        }
        func abs(_ dx: CGFloat, _ dy: CGFloat, rel: Bool) -> CGPoint {
            rel ? CGPoint(x: cur.x + dx, y: cur.y + dy) : CGPoint(x: dx, y: dy)
        }

        while i < n {
            skipSep()
            guard i < n else { break }
            let c = s[i]
            if c.isLetter {
                cmd = c; i += 1
            } else {
                // implicit repeat of previous command (M/m degrade to L/l)
                if cmd == "M" { cmd = "L" } else if cmd == "m" { cmd = "l" }
                if !peekIsNum() { break }
            }
            let rel = cmd.isLowercase
            switch cmd {
            case "M", "m":
                cur = abs(readNum(), readNum(), rel: rel); path.move(to: cur); start = cur
            case "L", "l":
                cur = abs(readNum(), readNum(), rel: rel); path.addLine(to: cur)
            case "H", "h":
                let x = readNum(); cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur)
            case "V", "v":
                let y = readNum(); cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur)
            case "C", "c":
                let c1 = abs(readNum(), readNum(), rel: rel)
                let c2 = abs(readNum(), readNum(), rel: rel)
                cur = abs(readNum(), readNum(), rel: rel)
                path.addCurve(to: cur, control1: c1, control2: c2); prevCtrl = c2
            case "S", "s":
                let c1 = (prevCtrl != nil && "CcSs".contains(prevCmd))
                    ? CGPoint(x: 2 * cur.x - prevCtrl!.x, y: 2 * cur.y - prevCtrl!.y) : cur
                let c2 = abs(readNum(), readNum(), rel: rel)
                cur = abs(readNum(), readNum(), rel: rel)
                path.addCurve(to: cur, control1: c1, control2: c2); prevCtrl = c2
            case "Q", "q":
                let q = abs(readNum(), readNum(), rel: rel)
                cur = abs(readNum(), readNum(), rel: rel)
                path.addQuadCurve(to: cur, control: q); prevCtrl = q
            case "T", "t":
                let q = (prevCtrl != nil && "QqTt".contains(prevCmd))
                    ? CGPoint(x: 2 * cur.x - prevCtrl!.x, y: 2 * cur.y - prevCtrl!.y) : cur
                cur = abs(readNum(), readNum(), rel: rel)
                path.addQuadCurve(to: cur, control: q); prevCtrl = q
            case "A", "a":
                let rx = readNum(), ry = readNum(), rot = readNum()
                let large = readFlag(), sweep = readFlag()
                let end = abs(readNum(), readNum(), rel: rel)
                arc(path, from: cur, to: end, rx: rx, ry: ry, xRotDeg: rot, largeArc: large, sweep: sweep)
                cur = end; prevCtrl = nil
            case "Z", "z":
                path.closeSubpath(); cur = start
            default:
                _ = readNum()  // unknown: consume one number to make progress
            }
            prevCmd = cmd
        }
        return path
    }

    // SVG endpoint-parametrized elliptical arc → CGPath arc, via unit-circle transform.
    private static func arc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint,
                            rx rx0: CGFloat, ry ry0: CGFloat, xRotDeg: CGFloat,
                            largeArc: Bool, sweep: Bool) {
        if rx0 == 0 || ry0 == 0 { path.addLine(to: p1); return }
        var rx = Swift.abs(rx0), ry = Swift.abs(ry0)
        let phi = xRotDeg * .pi / 180
        let cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1p = cosP * dx + sinP * dy
        let y1p = -sinP * dx + cosP * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 { let sc = sqrt(lambda); rx *= sc; ry *= sc }
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        let co = (largeArc != sweep ? 1.0 : -1.0) * sqrt(Swift.max(0, num / den))
        let cxp = co * (rx * y1p / ry)
        let cyp = co * (-ry * x1p / rx)
        let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
        let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
            var a = acos(Swift.max(-1, Swift.min(1, len == 0 ? 1 : dot / len)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }
        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
        if sweep && dTheta < 0 { dTheta += 2 * .pi }

        let t = CGAffineTransform(translationX: cx, y: cy).rotated(by: phi).scaledBy(x: rx, y: ry)
        path.addArc(center: .zero, radius: 1, startAngle: theta1, endAngle: theta1 + dTheta,
                    clockwise: dTheta < 0, transform: t)
    }
}
