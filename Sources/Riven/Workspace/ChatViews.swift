import AppKit

// A small text button that runs a closure — lets static factory views (code blocks) wire
// actions without a target object.
final class ClosureButton: NSButton {
    private let onClick: () -> Void
    init(title: String, onClick: @escaping () -> Void) {
        self.onClick = onClick
        super.init(frame: .zero)
        self.title = title; bezelStyle = .inline; controlSize = .small
        font = UIScale.font(UIScale.caption); isBordered = true
        contentTintColor = Theme.fgDim
        target = self; action = #selector(fire)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func fire() { onClick() }
}

extension NSView {
    // Nearest ChatPanel ancestor — lets a deeply-nested control (a code-block button) call back to
    // the exact pane it lives in, instead of a shared static that races across panes.
    var enclosingChatPanel: ChatPanel? {
        var v: NSView? = self
        while let cur = v { if let p = cur as? ChatPanel { return p }; v = cur.superview }
        return nil
    }
}

// Multiline chat input: Enter sends, Shift+Enter inserts a newline; grows 1→6 lines. Replaces
// the single-line NSTextField so multi-line messages work like the CLI.
final class ChatInput: NSTextView {
    var onSubmit: (() -> Void)?
    var onKey: ((Selector) -> Bool)?     // slash-popup nav / mode cycle — return true if consumed
    var onTextChange: (() -> Void)?
    var onFocus: (() -> Void)?           // gained keyboard focus (click/tab) → pane is being looked at
    var placeholder = "" { didSet { needsDisplay = true } }
    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { onFocus?() }
        return ok
    }
    // Compatibility shim so call sites can keep using stringValue. Setting it programmatically must
    // also re-measure the enclosing InputScroll (that owns the 1–6 line capped height).
    var stringValue: String {
        get { string }
        set { string = newValue; enclosingScrollView?.invalidateIntrinsicContentSize(); needsDisplay = true }
    }

    // Bare text view; wrapped by InputScroll which handles sizing/scrolling. Configured as a growing
    // document there (isVerticallyResizable + widthTracksTextView), so it grows past 6 lines and the
    // scroll view scrolls to keep the cursor visible instead of hiding it.
    static let fontSize: CGFloat = UIScale.prose   // same as answers (app type scale)
    static func make() -> ChatInput {
        let tv = ChatInput(frame: .zero)
        tv.isRichText = false; tv.drawsBackground = false; tv.allowsUndo = true
        tv.font = UIScale.font(ChatInput.fontSize); tv.textColor = Theme.fg
        tv.textContainerInset = NSSize(width: 2, height: 6)
        return tv
    }
    override func didChangeText() {
        super.didChangeText()
        enclosingScrollView?.invalidateIntrinsicContentSize()   // regrow up to the 6-line cap
        scrollRangeToVisible(selectedRange())                   // keep the cursor on screen past the cap
        needsDisplay = true
        onTextChange?()
    }
    override func doCommand(by selector: Selector) {
        if let onKey, onKey(selector) { return }           // popup / mode-cycle first
        if selector == #selector(insertNewline(_:)) {
            if NSApp.currentEvent?.modifierFlags.contains(.shift) == true { super.insertNewline(nil) }  // Shift+Enter = newline
            else { onSubmit?() }                            // Enter = send
            return
        }
        super.doCommand(by: selector)
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        (placeholder as NSString).draw(at: NSPoint(x: textContainerInset.width + 4, y: textContainerInset.height),
            withAttributes: [.foregroundColor: Theme.fgDim, .font: font ?? UIScale.font(ChatInput.fontSize)])
    }

    // Paste an IMAGE (a Cmd-Shift-4 screenshot on the clipboard, or copied image files) like the
    // CLI does: save it to a temp PNG and insert the path so the agent can Read it.
    // A plain-text NSTextView refuses image pastes — worse, when the clipboard holds ONLY an image
    // (no text), Paste is disabled and paste(_:) never even fires. So we (1) advertise image/file
    // types as readable to keep Paste enabled, and (2) intercept the actual read here.
    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        super.readablePasteboardTypes + [.png, .tiff, .fileURL]
    }
    override func readSelection(from pboard: NSPasteboard) -> Bool {
        if let paths = ChatInput.clipboardImagePaths(pboard) {
            insertText(string.isEmpty ? paths : "\n" + paths, replacementRange: selectedRange())
            return true
        }
        return super.readSelection(from: pboard)
    }
    // Image file paths from the clipboard (copied files), or a temp PNG saved from raw screenshot
    // data. `quoted` wraps each path in single quotes (for pasting into a shell/terminal).
    static func clipboardImagePaths(_ pb: NSPasteboard, quoted: Bool = false) -> String? {
        let imgExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "bmp"]
        func fmt(_ p: String) -> String { quoted ? "'\(p)'" : p }
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
            let imgs = urls.filter { imgExts.contains($0.pathExtension.lowercased()) }
            if !imgs.isEmpty { return imgs.map { fmt($0.path) }.joined(separator: quoted ? " " : "\n") }
        }
        if pb.canReadItem(withDataConformingToTypes: [NSPasteboard.PasteboardType.png.rawValue,
                                                      NSPasteboard.PasteboardType.tiff.rawValue]),
           let img = NSImage(pasteboard: pb), let path = saveClipboardPNG(img) {
            return fmt(path)
        }
        return nil
    }
    static func saveClipboardPNG(_ img: NSImage) -> String? {
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("riven-paste", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("paste-\(UUID().uuidString.prefix(8)).png")
        do { try png.write(to: url); return url.path } catch { return nil }
    }
}

// Scroll container for ChatInput: grows the composer from 1 line up to a 6-line cap, then SCROLLS
// its content (so a long draft's cursor stays visible instead of running off the bottom). The
// capped height is this view's intrinsic size, so the composer hugs it.
final class InputScroll: NSScrollView {
    let tv: ChatInput
    init(_ tv: ChatInput) {
        self.tv = tv
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        drawsBackground = false; borderType = .noBorder
        hasVerticalScroller = false; hasHorizontalScroller = false
        verticalScrollElasticity = .none
        tv.translatesAutoresizingMaskIntoConstraints = true
        tv.isVerticallyResizable = true; tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        let big = CGFloat.greatestFiniteMagnitude
        tv.minSize = NSSize(width: 0, height: 0)
        tv.maxSize = NSSize(width: big, height: big)
        tv.textContainer?.widthTracksTextView = true
        tv.textContainer?.containerSize = NSSize(width: 0, height: big)
        documentView = tv
        setContentHuggingPriority(.defaultHigh, for: .vertical)
        setContentCompressionResistancePriority(.defaultHigh, for: .vertical)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var intrinsicContentSize: NSSize {
        guard let lm = tv.layoutManager, let tc = tv.textContainer else { return NSSize(width: NSView.noIntrinsicMetric, height: 24) }
        lm.ensureLayout(for: tc)
        let line = (tv.font?.boundingRectForFont.height ?? 16)
        let content = lm.usedRect(for: tc).height
        let pad = tv.textContainerInset.height * 2
        let minH = line + pad, maxH = line * 6 + pad
        return NSSize(width: NSView.noIntrinsicMetric, height: min(max(content + pad, minH), maxH))
    }
}

// Rich building blocks for the native chat panel (ChatPanel.swift): a working indicator,
// per-turn blocks with a thinking/writing/elapsed header + token usage, interleaved tool
// lines (edits render a diff), streaming assistant text with a smooth typewriter reveal and
// code blocks, a left-aligned user bubble, sub-agent lane cards, an inline permission
// approval card, and a scrollable slash-command autocomplete popup. All use Theme/UIScale.

// MARK: - working indicator (three pulsing dots)
final class WorkingDots: NSView {
    private let dots = [CALayer(), CALayer(), CALayer()]
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        for d in dots {
            d.backgroundColor = Theme.accent2.cgColor
            d.cornerRadius = 2; d.bounds = CGRect(x: 0, y: 0, width: 4, height: 4); d.opacity = 0.25
            layer?.addSublayer(d)
        }
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var intrinsicContentSize: NSSize { NSSize(width: 22, height: 8) }
    override func layout() {
        super.layout(); let cy = bounds.midY
        for (i, d) in dots.enumerated() { d.position = CGPoint(x: 3 + CGFloat(i) * 8, y: cy) }
    }
    func start() {
        isHidden = false
        for (i, d) in dots.enumerated() {
            d.backgroundColor = Theme.accent2.cgColor
            let a = CABasicAnimation(keyPath: "opacity")
            a.fromValue = 0.25; a.toValue = 1.0; a.duration = 0.6; a.autoreverses = true
            a.repeatCount = .infinity; a.beginTime = CACurrentMediaTime() + Double(i) * 0.2
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            d.add(a, forKey: "pulse")
        }
    }
    func stop() { dots.forEach { $0.removeAnimation(forKey: "pulse") }; isHidden = true }
}

// MARK: - tool line ("◇ Read  math.js") — a quiet, muted step row (like the CLI's dim
// tool lines): the whole row recedes so surrounding prose stays the visual focus.
final class ToolLine: NSView {
    private let nameLabel: NSTextField
    init(name: String, detail: String) {
        nameLabel = NSTextField(labelWithString: name)
        super.init(frame: .zero)
        wantsLayer = true
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: ToolLine.symbol(name), accessibilityDescription: nil)
        icon.contentTintColor = Theme.fgDim
        icon.symbolConfiguration = .init(pointSize: UIScale.pt(10), weight: .medium)
        icon.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.font = UIScale.font(UIScale.small, .medium); nameLabel.textColor = Theme.fg
        nameLabel.wantsLayer = true
        nameLabel.setContentHuggingPriority(.required, for: .horizontal)
        nameLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        let detailLabel = NSTextField(labelWithString: detail)
        detailLabel.font = UIScale.mono(UIScale.caption); detailLabel.textColor = Theme.fgDim
        detailLabel.lineBreakMode = .byTruncatingMiddle
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // A single horizontal stack pinned to the row's edges — the row height always wraps its
        // tallest child, so rows can never under-report height and overlap the next item.
        let row = NSStackView(views: [icon, nameLabel, detailLabel])
        row.orientation = .horizontal; row.alignment = .centerY; row.spacing = 7
        row.setCustomSpacing(8, after: nameLabel)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: UIScale.pt(14)),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 1),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    // A bright band glides left→right over the tool NAME while it runs (same shadcn-style flow
    // as "생각 중"), stopped when it finishes. Masking the single text label — not the whole
    // row — makes it read as a directional sweep instead of the whole row blinking.
    private let shimmer = CAGradientLayer()
    private var shimmerOn = false
    func startShimmer() {
        guard !shimmerOn else { return }
        shimmerOn = true
        shimmer.startPoint = CGPoint(x: 0, y: 0.5); shimmer.endPoint = CGPoint(x: 1, y: 0.5)
        let dim = NSColor.white.withAlphaComponent(0.35).cgColor
        shimmer.colors = [dim, NSColor.white.cgColor, dim]; shimmer.locations = [0, 0.5, 1]
        nameLabel.layer?.mask = shimmer
        needsLayout = true
        let sweep = CABasicAnimation(keyPath: "locations")
        sweep.fromValue = [-1.0, -0.5, 0.0]; sweep.toValue = [1.0, 1.5, 2.0]
        sweep.duration = 1.4; sweep.repeatCount = .infinity
        sweep.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        shimmer.add(sweep, forKey: "shimmer")
    }
    func stopShimmer() {
        guard shimmerOn else { return }
        shimmerOn = false; shimmer.removeAllAnimations(); nameLabel.layer?.mask = nil
    }
    override func layout() {
        super.layout()
        guard shimmerOn, let host = nameLabel.layer else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true); shimmer.frame = host.bounds; CATransaction.commit()
    }
    static func symbol(_ name: String) -> String {
        switch name {
        case "Read": return "doc.text"
        case "Edit", "Write", "MultiEdit", "NotebookEdit": return "pencil"
        case "Bash", "BashOutput": return "terminal"
        case "Grep": return "magnifyingglass"
        case "Glob": return "folder"
        case "LS": return "list.bullet"
        case "WebFetch", "WebSearch": return "globe"
        case "TodoWrite": return "checklist"
        default: return "wrench.and.screwdriver"
        }
    }
}

// MARK: - assistant text (typewriter reveal, then re-render markdown + code blocks)
final class AssistantText: NSView {
    private let content = NSStackView()
    // Backing store is [Character], not String: String.count / Array(full) are BOTH O(n) and were
    // being run every typewriter tick → O(n²) CPU over a long streamed answer. With an array,
    // count is O(1) and the prefix slice is O(shown).
    private var chars: [Character] = []
    private var shownCount = 0
    private var streaming: NSTextField?
    private var finalized = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        content.orientation = .vertical; content.spacing = 10; content.alignment = .leading
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor),
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    var isEmpty: Bool { chars.isEmpty }
    func receive(_ chunk: String) { chars.append(contentsOf: chunk) }

    // Reveal a slice toward the full text — steady enough to look typed, fast enough to catch bursts.
    @discardableResult func advance() -> Bool {
        guard !finalized, shownCount < chars.count else { return false }
        let remaining = chars.count - shownCount
        let step = max(3, remaining / 5)                 // ease-out: bigger jumps when behind
        shownCount = min(chars.count, shownCount + step)
        ensureLabel().attributedStringValue = ChatText.attributedProse(String(chars[0..<shownCount]))
        return true
    }
    private func ensureLabel() -> NSTextField {
        if let s = streaming { return s }
        // Wrap the streaming label in the SAME bullet + gutter row the final render uses, so the
        // text is already at its final x-position/indent while typing — renderFinal then only adds
        // inline emphasis instead of visibly reflowing the whole answer.
        let l = ChatText.prose("")
        let row = ChatText.bulletRow(l)
        row.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        streaming = l; return l
    }
    func renderFinal() {
        guard !finalized else { return }
        finalized = true
        content.arrangedSubviews.forEach { $0.removeFromSuperview() }
        streaming = nil
        for v in ChatText.render(String(chars)) {
            content.addArrangedSubview(v)
            v.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        }
    }
}

// A button whose background is ALWAYS a perfect circle. Rather than rounding the button's own
// layer (which renders as a capsule the instant the frame isn't perfectly square), it draws a
// dedicated circular fill layer of diameter = min(width,height), centered — so it's a circle no
// matter what the frame ends up being.
final class CircleButton: NSButton {
    private let fill = CALayer()
    var fillColor: NSColor = .clear { didSet { fill.backgroundColor = fillColor.cgColor } }
    var strokeColor: NSColor = .clear { didSet { fill.borderColor = strokeColor.cgColor } }
    var strokeWidth: CGFloat = 0 { didSet { fill.borderWidth = strokeWidth } }
    override func layout() {
        super.layout()
        wantsLayer = true
        if fill.superlayer == nil { layer?.insertSublayer(fill, at: 0) }
        let d = min(bounds.width, bounds.height)
        fill.frame = CGRect(x: (bounds.width - d) / 2, y: (bounds.height - d) / 2, width: d, height: d)
        fill.cornerRadius = d / 2
        fill.masksToBounds = true
    }
}

// MARK: - shared text rendering (markdown prose + ``` code blocks, diff coloring)
enum ChatText {
    // Prose is the focus of the transcript. Base text is SOFTENED (not full-contrast) so that
    // **bold** — full-brightness + heavier — clearly stands out; before, base was so dark that
    // emphasis was indistinguishable.
    private static let proseSize: CGFloat = UIScale.prose   // single source: the app type scale
    static var proseColor: NSColor { Theme.fg.withAlphaComponent(0.80) }   // regular text (calmer)
    static var proseStrong: NSColor { Theme.fg }                           // emphasized text (brighter)
    static func prose(_ s: String) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: s)
        l.font = UIScale.font(proseSize); l.textColor = proseColor
        l.translatesAutoresizingMaskIntoConstraints = false; l.isSelectable = true
        // Without this, clicking a selectable label makes the field editor STRIP rich attributes
        // to plain (bold/code coloring vanish, width changes → reflow). Keep the formatting.
        l.allowsEditingTextAttributes = true
        return l
    }
    // Roomier line spacing — the default was too tight to read.
    static var para: NSParagraphStyle {
        let p = NSMutableParagraphStyle(); p.lineSpacing = 5; p.paragraphSpacing = 6; return p
    }
    static func attributedProse(_ s: String) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.foregroundColor: proseColor, .font: UIScale.font(proseSize), .paragraphStyle: para])
    }
    static func proseMarkdown(_ s: String) -> NSTextField {
        let l = prose(s)
        if let attr = try? NSAttributedString(markdown: s,
              options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            let m = NSMutableAttributedString(attributedString: attr)
            let full = NSRange(location: 0, length: m.length)
            m.addAttributes([.foregroundColor: proseColor, .font: UIScale.font(proseSize), .paragraphStyle: para],
                            range: full)
            // Re-apply the inline emphasis the wholesale font pass just erased — **bold** is
            // bolder AND brighter than the softened base so it clearly pops; `code` spans mono+accent.
            m.enumerateAttribute(.inlinePresentationIntent, in: full) { v, r, _ in
                var intent = InlinePresentationIntent()
                if let i = v as? InlinePresentationIntent { intent = i }
                else if let n = v as? NSNumber { intent = InlinePresentationIntent(rawValue: n.uintValue) }
                if intent.contains(.stronglyEmphasized) {
                    m.addAttributes([.font: UIScale.font(proseSize, .bold), .foregroundColor: proseStrong], range: r)
                }
                if intent.contains(.code) {
                    m.addAttributes([.font: UIScale.mono(proseSize - 1),
                                     .foregroundColor: Theme.accent2], range: r)
                }
            }
            l.attributedStringValue = m
        }
        return l
    }
    // A prose paragraph with a CLI-style bullet marker in the left gutter.
    static func proseParagraph(_ text: String) -> NSView {
        bulletRow(proseMarkdown(text))
    }
    // The same bullet + gutter container, around an arbitrary label. Used for the STREAMING label
    // too, so the text sits at its final position from the first character — previously streaming
    // used a bare full-width label and the whole answer jumped/indented when renderFinal ran.
    static func bulletRow(_ label: NSTextField) -> NSView {
        let row = NSView()
        let bullet = NSTextField(labelWithString: "⏺")
        bullet.font = UIScale.font(8); bullet.textColor = Theme.accent2.withAlphaComponent(0.75)
        bullet.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(bullet); row.addSubview(label)
        NSLayoutConstraint.activate([
            bullet.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 1),
            bullet.firstBaselineAnchor.constraint(equalTo: label.firstBaselineAnchor),   // align to first text line
            label.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: UIScale.pt(16)),
            label.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            label.topAnchor.constraint(equalTo: row.topAnchor),
            label.bottomAnchor.constraint(equalTo: row.bottomAnchor)
        ])
        return row
    }
    static func codeBlock(_ code: String, diff: Bool = false, path: String? = nil, lang: String? = nil) -> NSView {
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = Theme.bg3.cgColor          // distinct code surface (like the CLI)
        box.layer?.cornerRadius = 8; box.layer?.borderWidth = 1
        box.layer?.borderColor = Theme.edge.cgColor
        box.translatesAutoresizingMaskIntoConstraints = false

        // Header: language label (left) + action button (right), separated from the code.
        let header = NSView(); header.translatesAutoresizingMaskIntoConstraints = false
        let langL = NSTextField(labelWithString: (lang?.isEmpty == false ? lang! : (diff ? "diff" : "code")).uppercased())
        langL.font = UIScale.mono(UIScale.caption, .semibold)
        langL.textColor = Theme.fgDim.withAlphaComponent(0.8)
        langL.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(langL)
        let isEdit = diff && path != nil
        do {
            let title = isEdit ? t("chat.viewDiff") : t("chat.openInEditor")
            // Resolve the owning ChatPanel from the clicked button's view tree (NOT a shared static,
            // which pointed at the last-created/now-dead pane once more than one chat existed).
            let btn = ClosureButton(title: title) { [weak box] in
                guard let panel = box?.enclosingChatPanel else { return }
                if isEdit, let path { panel.showEditFromDiff(code, path: path) }
                else { panel.openCodeInEditor(code, path: path) }
            }
            btn.translatesAutoresizingMaskIntoConstraints = false
            header.addSubview(btn)
            NSLayoutConstraint.activate([
                btn.trailingAnchor.constraint(equalTo: header.trailingAnchor),
                btn.centerYAnchor.constraint(equalTo: header.centerYAnchor)
            ])
        }
        let l = NSTextField(wrappingLabelWithString: code)
        l.font = UIScale.mono(UIScale.body); l.textColor = Theme.fg; l.isSelectable = true
        l.allowsEditingTextAttributes = true     // keep attributes when clicked (no revert-to-plain)
        l.lineBreakMode = .byCharWrapping        // long unbroken code lines wrap, not overflow
        l.translatesAutoresizingMaskIntoConstraints = false
        if diff { l.attributedStringValue = diffColored(code) }
        else { l.attributedStringValue = highlight(code) }
        [header, l].forEach { box.addSubview($0) }
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: box.topAnchor, constant: 8),
            header.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
            header.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -10),
            header.heightAnchor.constraint(equalToConstant: 16),
            langL.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            langL.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            l.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 6),
            l.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -10),
            l.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
            l.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -12)
        ])
        return box
    }
    // Lightweight, language-agnostic syntax highlighting (comments, strings, numbers, keywords)
    // so code blocks read like the CLI's coloring — a regex pass, not a full grammar.
    private static let kwPattern = "\\b(func|let|var|const|if|else|elif|for|while|do|return|import|from|as|class|struct|enum|protocol|extension|interface|type|def|function|lambda|public|private|internal|fileprivate|static|final|override|guard|switch|case|default|break|continue|new|delete|async|await|try|catch|finally|throw|throws|typealias|package|self|this|super|true|false|nil|null|none|undefined|True|False|None|and|or|not|in|is|export|module|namespace|use|fn|impl|mut|pub|match|where|with|yield|assert|print|echo)\\b"
    static func highlight(_ code: String) -> NSAttributedString {
        let p = NSMutableParagraphStyle(); p.lineSpacing = 3
        let base: [NSAttributedString.Key: Any] = [.font: UIScale.mono(UIScale.body), .foregroundColor: Theme.fg, .paragraphStyle: p]
        let m = NSMutableAttributedString(string: code, attributes: base)
        // Skip regex highlighting for large blocks: the string/comment patterns can catastrophically
        // backtrack, and the per-match `protected` intersection is O(n²) — together they pegged the
        // CPU and froze the app (e.g. a big SQL dump rendered on workspace switch). Plain mono instead.
        guard code.utf16.count <= 2500 else { return m }
        let full = NSRange(location: 0, length: (code as NSString).length)
        var protected = IndexSet()
        func paint(_ pattern: String, _ color: NSColor, options: NSRegularExpression.Options = [], protect: Bool) {
            guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return }
            re.enumerateMatches(in: code, range: full) { match, _, _ in
                guard let r = match?.range, r.length > 0 else { return }
                let span = r.location..<(r.location + r.length)
                if protected.intersection(IndexSet(integersIn: span)).isEmpty == false { return }
                m.addAttribute(.foregroundColor, value: color, range: r)
                if protect { protected.insert(integersIn: span) }
            }
        }
        // comments & strings first (and protect them from keyword/number recoloring)
        paint("(//[^\\n]*)|(#[^\\n]*)|(/\\*[\\s\\S]*?\\*/)", Theme.fgDim, protect: true)
        paint("\"(\\\\.|[^\"\\\\])*\"|'(\\\\.|[^'\\\\])*'|`[^`]*`", Theme.gitAdded, protect: true)
        paint("\\b\\d[\\d_.eExXa-fA-F]*\\b", Theme.warning, protect: false)
        paint(kwPattern, Theme.accent2, protect: false)
        return m
    }
    // Edits open the real file (see the applied change); snippets go to a temp file.
    private static func diffColored(_ code: String) -> NSAttributedString {
        let m = NSMutableAttributedString()
        let font = UIScale.mono(UIScale.body)
        let p = NSMutableParagraphStyle(); p.lineSpacing = 3
        for (i, line) in code.components(separatedBy: "\n").enumerated() {
            if i > 0 { m.append(NSAttributedString(string: "\n")) }
            let color: NSColor = line.hasPrefix("+") ? Theme.gitAdded
                               : line.hasPrefix("-") ? Theme.gitDeleted : Theme.fgDim
            m.append(NSAttributedString(string: line,
                attributes: [.foregroundColor: color, .font: font, .paragraphStyle: p]))
        }
        return m
    }
    static func render(_ text: String) -> [NSView] {
        let parts = text.components(separatedBy: "```")
        var out: [NSView] = []
        for (i, part) in parts.enumerated() {
            if i % 2 == 0 {
                let t = part.trimmingCharacters(in: .whitespacesAndNewlines)
                // ONE bullet per prose segment (like the CLI's ⏺), with the whole block indented
                // under it; internal paragraphs are spaced apart by the paragraph style.
                if !t.isEmpty { out.append(proseParagraph(t)) }
            } else {
                var code = part
                var lang: String?
                if let nl = code.firstIndex(of: "\n") {
                    let first = String(code[..<nl])
                    if !first.contains(" ") && first.count < 20 {
                        lang = first.isEmpty ? nil : first
                        code = String(code[code.index(after: nl)...])
                    }
                }
                let trimmed = code.trimmingCharacters(in: .newlines)
                if !trimmed.isEmpty { out.append(codeBlock(trimmed, lang: lang)) }
            }
        }
        if out.isEmpty { out.append(proseMarkdown(text)) }
        return out
    }
    // token formatting: 1234 → "1.2k"
    static func tokens(_ n: Int) -> String { n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)" }
    // elapsed: seconds → "45초" / "2분 5초" / "1시간 3분"
    static func duration(_ secs: Int) -> String {
        if secs < 60 { return t("chat.dur.sec", ["n": secs]) }
        if secs < 3600 { let m = secs / 60, s = secs % 60; return s == 0 ? t("chat.dur.min", ["n": m]) : t("chat.dur.minSec", ["m": m, "s": s]) }
        let h = secs / 3600, m = (secs % 3600) / 60; return m == 0 ? t("chat.dur.hour", ["n": h]) : t("chat.dur.hourMin", ["h": h, "m": m])
    }
}

// MARK: - user message (LEFT-aligned) — an accent bar + quiet tint, like the CLI's "> "
// prompt line: instantly reads as "you said this" without a loud bordered box.
final class UserBubble: NSView {
    private let bar = NSView()
    private let queuedTag = NSTextField(labelWithString: t("chat.queuedTag"))
    init(text: String) {
        super.init(frame: .zero)
        wantsLayer = true
        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = Theme.hover.cgColor
        card.layer?.cornerRadius = 8
        card.layer?.masksToBounds = true          // clip the accent bar to the rounded corners
        card.translatesAutoresizingMaskIntoConstraints = false
        bar.wantsLayer = true
        bar.layer?.backgroundColor = Theme.accent.withAlphaComponent(0.8).cgColor
        bar.layer?.cornerRadius = 1.5
        bar.translatesAutoresizingMaskIntoConstraints = false
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = UIScale.font(UIScale.prose); l.textColor = Theme.fg; l.isSelectable = true
        let p = NSMutableParagraphStyle(); p.lineSpacing = 4
        l.attributedStringValue = NSAttributedString(string: text,
            attributes: [.foregroundColor: Theme.fg, .font: UIScale.font(UIScale.prose), .paragraphStyle: p])
        l.translatesAutoresizingMaskIntoConstraints = false
        queuedTag.font = UIScale.font(UIScale.caption, .medium); queuedTag.textColor = Theme.warning
        queuedTag.isHidden = true
        queuedTag.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(bar); card.addSubview(l); card.addSubview(queuedTag); addSubview(card)
        // The tag sits on its OWN line BELOW the message (it used to be pinned top-right, overlapping
        // the text). Two card-bottom constraints toggle so the card only reserves the tag's row while
        // queued — otherwise it collapses to hug the text.
        bottomToText = card.bottomAnchor.constraint(equalTo: l.bottomAnchor, constant: 8)
        bottomToTag = card.bottomAnchor.constraint(equalTo: queuedTag.bottomAnchor, constant: 8)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            bar.topAnchor.constraint(equalTo: card.topAnchor),
            bar.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            bar.widthAnchor.constraint(equalToConstant: 3),
            l.topAnchor.constraint(equalTo: card.topAnchor, constant: 8),
            l.leadingAnchor.constraint(equalTo: bar.trailingAnchor, constant: 11),
            l.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -12),
            queuedTag.topAnchor.constraint(equalTo: l.bottomAnchor, constant: 3),
            queuedTag.leadingAnchor.constraint(equalTo: l.leadingAnchor),
            queuedTag.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -12),
            bottomToText,
            card.topAnchor.constraint(equalTo: topAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -40)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    private var bottomToText: NSLayoutConstraint!
    private var bottomToTag: NSLayoutConstraint!
    // Mid-turn messages wait their turn: dim + a "대기 중" tag until they start (CLI-style ack).
    func setQueued(_ q: Bool) {
        queuedTag.isHidden = !q
        bottomToText.isActive = !q       // reserve the tag's row only while queued
        bottomToTag.isActive = q
        alphaValue = q ? 0.55 : 1
        bar.layer?.backgroundColor = (q ? Theme.warning : Theme.accent.withAlphaComponent(0.8)).cgColor
    }
}

// MARK: - inline choice card (permission / plan-proceed / any agent choice)
// N options, keyboard: ←→ (or ↑↓) select, Enter confirm. Mirrors the CLI's arrow-select prompt.
final class ApprovalCard: NSView {
    private var buttons: [NSButton] = []
    private let options: [(String, () -> Void)]
    private let statusLabel = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: t("chat.cardHint"))
    private var sel = 0
    private var decided = false

    init(title: String, detail: String, code: String?, path: String?, options: [(String, () -> Void)]) {
        self.options = options
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = Theme.warning.withAlphaComponent(0.07).cgColor
        layer?.cornerRadius = 8; layer?.borderWidth = 1
        layer?.borderColor = Theme.warning.withAlphaComponent(0.32).cgColor

        let titleL = NSTextField(labelWithString: title)
        titleL.font = UIScale.font(UIScale.body, .semibold); titleL.textColor = Theme.fg
        titleL.translatesAutoresizingMaskIntoConstraints = false
        let sub = NSTextField(labelWithString: detail)
        sub.font = UIScale.mono(UIScale.caption); sub.textColor = Theme.fgDim; sub.lineBreakMode = .byTruncatingMiddle
        sub.translatesAutoresizingMaskIntoConstraints = false

        for (i, opt) in options.enumerated() {
            let b = NSButton(); b.title = opt.0; b.bezelStyle = .rounded
            b.wantsLayer = true; b.layer?.cornerRadius = 6
            b.tag = i; b.target = self; b.action = #selector(tap(_:))
            b.translatesAutoresizingMaskIntoConstraints = false
            buttons.append(b)
        }
        statusLabel.font = UIScale.font(UIScale.small, .semibold); statusLabel.textColor = Theme.fgDim
        statusLabel.translatesAutoresizingMaskIntoConstraints = false; statusLabel.isHidden = true
        hint.font = UIScale.font(UIScale.caption); hint.textColor = Theme.fgDim
        hint.translatesAutoresizingMaskIntoConstraints = false

        let col = NSStackView(); col.orientation = .vertical; col.alignment = .leading; col.spacing = 8
        col.translatesAutoresizingMaskIntoConstraints = false
        col.addArrangedSubview(titleL)
        if !detail.isEmpty { col.addArrangedSubview(sub) }
        if let code, !code.isEmpty {
            let cb = ChatText.codeBlock(code, diff: true, path: path)
            col.addArrangedSubview(cb)
            cb.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
        }
        // Long/many options stack vertically (like the CLI's list); few short ones sit in a row.
        let vert = options.count > 3 || options.contains { $0.0.count > 24 }
        let btnStack = NSStackView(views: buttons)
        btnStack.orientation = vert ? .vertical : .horizontal
        btnStack.alignment = vert ? .leading : .centerY
        btnStack.spacing = vert ? 4 : 8
        btnStack.translatesAutoresizingMaskIntoConstraints = false
        col.addArrangedSubview(btnStack)
        if vert {
            btnStack.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
            for b in buttons {
                b.widthAnchor.constraint(equalTo: btnStack.widthAnchor).isActive = true
                b.alignment = .left
            }
        }
        let metaRow = NSStackView(views: [hint, statusLabel]); metaRow.spacing = 8
        metaRow.translatesAutoresizingMaskIntoConstraints = false
        col.addArrangedSubview(metaRow)
        addSubview(col)
        NSLayoutConstraint.activate([
            col.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            col.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            col.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            col.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14)
        ])
        restyleSel()
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil, !decided { DispatchQueue.main.async { [weak self] in guard let self else { return }; self.window?.makeFirstResponder(self) } }
    }
    override var acceptsFirstResponder: Bool { !decided }
    override func becomeFirstResponder() -> Bool { restyleSel(); return true }

    override func keyDown(with e: NSEvent) {
        switch e.keyCode {
        case 123, 126: sel = (sel - 1 + options.count) % options.count; restyleSel()   // ← / ↑
        case 124, 125: sel = (sel + 1) % options.count; restyleSel()                    // → / ↓
        case 36, 76, 49: pick(sel)                                                       // return / enter / space
        default: super.keyDown(with: e)
        }
    }
    private func restyleSel() {
        for (i, b) in buttons.enumerated() {
            b.layer?.borderWidth = i == sel ? 2 : 0
            b.layer?.borderColor = (i == sel ? Theme.accent : NSColor.clear).cgColor
        }
    }
    @objc private func tap(_ b: NSButton) { pick(b.tag) }
    private func pick(_ i: Int) {
        guard !decided, options.indices.contains(i) else { return }
        decided = true
        buttons.forEach { $0.isHidden = true }; hint.isHidden = true
        statusLabel.isHidden = false
        statusLabel.stringValue = "✓ " + options[i].0
        statusLabel.textColor = Theme.success
        layer?.borderColor = Theme.success.withAlphaComponent(0.4).cgColor
        options[i].1()
    }
}

// MARK: - one assistant turn: an OPEN column (prose sits directly on the chat background,
// like the CLI — no boxed card competing with the code blocks). A hairline rule + dim
// footer under the content delimit the turn: working indicator (spinner + 생각/작성 중) on
// the LEFT and the token/quota summary on the RIGHT.
final class TurnBlock: NSView {
    private let card = NSView()               // invisible layout container for the content
    private let content = NSStackView()
    private let rule = NSView()               // hairline end-of-turn separator
    private let spinner = NSProgressIndicator()
    private let workLabel = NSTextField(labelWithString: "")     // left: 생각/작성 중 · times
    private let tokenLabel = NSTextField(labelWithString: "")    // right: tokens · context% · quota
    private var openText: AssistantText?
    private var finished = false
    private var hasText = false
    private var lastSecs = 0
    private var thinkingSecs: Int?      // seconds until first token
    private var tokenBase = ""          // token summary before quota is appended
    private var spinnerW: NSLayoutConstraint!
    private var waiting = false         // paused on a permission/choice prompt
    private let shimmer = CAGradientLayer()   // sweeping highlight masking workLabel while working
    private var shimmerOn = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        card.translatesAutoresizingMaskIntoConstraints = false   // draws nothing — open column
        content.orientation = .vertical; content.spacing = 9; content.alignment = .leading
        content.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(content)

        rule.wantsLayer = true
        rule.layer?.backgroundColor = Theme.hairline.cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false

        spinner.style = .spinning; spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        workLabel.font = UIScale.font(UIScale.caption, .medium); workLabel.textColor = Theme.accent2
        workLabel.translatesAutoresizingMaskIntoConstraints = false
        tokenLabel.font = UIScale.font(UIScale.caption); tokenLabel.textColor = Theme.fgDim; tokenLabel.alignment = .right
        tokenLabel.lineBreakMode = .byTruncatingTail
        tokenLabel.translatesAutoresizingMaskIntoConstraints = false

        [card, rule, spinner, workLabel, tokenLabel].forEach { addSubview($0) }
        spinnerW = spinner.widthAnchor.constraint(equalToConstant: 12)
        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: topAnchor),
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: card.topAnchor),
            content.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            // hairline rule closes the turn, then the dim footer: spinner + workLabel left,
            // tokenLabel right.
            rule.topAnchor.constraint(equalTo: card.bottomAnchor, constant: 12),
            rule.leadingAnchor.constraint(equalTo: leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: trailingAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
            spinner.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 1),
            spinner.topAnchor.constraint(equalTo: rule.bottomAnchor, constant: 7),
            spinnerW,
            spinner.heightAnchor.constraint(equalToConstant: 12),
            workLabel.leadingAnchor.constraint(equalTo: spinner.trailingAnchor, constant: 5),
            workLabel.centerYAnchor.constraint(equalTo: spinner.centerYAnchor),
            tokenLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -1),
            tokenLabel.centerYAnchor.constraint(equalTo: spinner.centerYAnchor),
            tokenLabel.leadingAnchor.constraint(greaterThanOrEqualTo: workLabel.trailingAnchor, constant: 8),
            bottomAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 2)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    private var phase = t("chat.thinking")          // current activity shown in the shimmer label
    func startWorking() { phase = t("chat.thinking"); spinner.startAnimation(nil); workLabel.stringValue = t("chat.thinking") + "…"; startShimmer() }
    // Set the current activity (a tool name etc.) — shown shimmering, like "생각 중".
    func setPhase(_ p: String) { guard !finished, !waiting else { return }; phase = p }
    private var lastRenderedSecs = -1
    private var lastRenderedPhase = ""
    func tick(_ secs: Int) {
        lastSecs = secs
        guard !finished, !waiting else { return }
        // The flush timer calls tick() ~20×/s, but the label only ever shows whole seconds. Skip the
        // relayout unless the second OR the phase actually changed — otherwise we forced a full
        // needsLayout pass (shimmer mask re-fit) 20×/s for identical text.
        guard secs != lastRenderedSecs || phase != lastRenderedPhase else { return }
        lastRenderedSecs = secs; lastRenderedPhase = phase
        workLabel.stringValue = phase + "… " + ChatText.duration(secs)
        needsLayout = true              // text width changed → re-fit the shimmer mask
    }
    // Pause the "thinking/writing" indicator while the user is being asked to approve/choose —
    // the agent is idle then, not working.
    func setWaiting(_ w: Bool) {
        guard !finished else { return }
        waiting = w
        if w { spinner.stopAnimation(nil); stopShimmer(); workLabel.stringValue = t("chat.awaitingApproval"); workLabel.textColor = Theme.warning }
        else { spinner.startAnimation(nil); workLabel.textColor = Theme.accent2; startShimmer() }
    }

    // Shimmer (shadcn-style "Thinking…"): a bright band glides left→right over the label,
    // repeating while the turn works. The gradient is an alpha-only MASK on workLabel's layer,
    // so only the glyphs shimmer — the text reads dim except where the band passes, and the
    // effect inherits the label's Theme color (accent2), working in dark AND light themes.
    private func startShimmer() {
        guard !shimmerOn else { return }
        shimmerOn = true
        workLabel.wantsLayer = true
        shimmer.startPoint = CGPoint(x: 0, y: 0.5)
        shimmer.endPoint = CGPoint(x: 1, y: 0.5)
        let dim = NSColor.white.withAlphaComponent(0.4).cgColor   // alpha mask: color irrelevant
        shimmer.colors = [dim, NSColor.white.cgColor, dim]
        shimmer.locations = [0, 0.5, 1]
        workLabel.layer?.mask = shimmer
        needsLayout = true                                        // size the mask to the label
        let sweep = CABasicAnimation(keyPath: "locations")
        sweep.fromValue = [-1.0, -0.5, 0.0]
        sweep.toValue = [1.0, 1.5, 2.0]
        sweep.duration = 1.4
        sweep.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        sweep.repeatCount = .infinity
        shimmer.add(sweep, forKey: "shimmer")
    }
    private func stopShimmer() {
        guard shimmerOn else { return }
        shimmerOn = false
        shimmer.removeAllAnimations()                             // no leaked repeating animation
        workLabel.layer?.mask = nil
    }
    override func layout() {
        super.layout()
        guard shimmerOn, let host = workLabel.layer else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        shimmer.frame = host.bounds
        CATransaction.commit()
    }

    private weak var activeTool: ToolLine?   // the tool line currently in progress (shimmering)
    private func stopActiveTool() { activeTool?.stopShimmer(); activeTool = nil }

    func bufferText(_ t: String) {
        if !hasText { hasText = true; thinkingSecs = lastSecs }
        phase = I18n.t("chat.writing")
        stopActiveTool()                     // text arriving ⇒ the previous tool finished
        if openText == nil { openText = newText() }
        openText?.receive(t)
    }
    @discardableResult func flush() -> Bool { openText?.advance() ?? false }
    private func newText() -> AssistantText {
        let seg = AssistantText(); seg.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(seg)
        seg.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        return seg
    }
    private func closeText() { openText?.renderFinal(); openText = nil }
    private func add(_ v: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = false
        // Consecutive tool lines cluster into a tight, quiet step list; prose keeps the
        // full gap — the CLI's rhythm.
        let prev = content.arrangedSubviews.last
        content.addArrangedSubview(v)
        if let prev, prev is ToolLine, v is ToolLine { content.setCustomSpacing(3, after: prev) }
        v.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
    }

    func addTool(_ name: String, _ detail: String, _ code: String?, _ path: String?) {
        closeText()
        setPhase(t("chat.running", ["name": name.replacingOccurrences(of: "mcp__riven__", with: "")]))   // shimmer shows the current tool
        stopActiveTool()                     // previous tool finished
        let line = ToolLine(name: name, detail: detail)
        add(line)
        line.startShimmer(); activeTool = line   // shimmer THIS tool while it runs
        if let code, !code.isEmpty {
            add(ChatText.codeBlock(code, diff: name == "Edit" || name == "MultiEdit", path: path))
            content.setCustomSpacing(5, after: line)   // the block belongs to its tool line
        }
    }
    @discardableResult
    func addApproval(_ title: String, _ detail: String, _ code: String?, _ path: String?,
                     options: [(String, () -> Void)]) -> ApprovalCard {
        closeText()
        let card = ApprovalCard(title: title, detail: detail, code: code, path: path, options: options)
        add(card)
        return card
    }
    func finish(secs: Int, cost: Double?, usage: ChatUsage?, model: String?) {
        guard !finished else { return }
        closeText(); finished = true
        stopShimmer(); stopActiveTool()
        spinner.stopAnimation(nil); spinnerW.constant = 0   // reclaim the hidden spinner's gap
        // left: thinking/writing times
        var times: [String] = []
        if let think = thinkingSecs { times.append(t("chat.thinkFor", ["d": ChatText.duration(think)])); if secs > think { times.append(t("chat.writeFor", ["d": ChatText.duration(secs - think)])) } }
        else { times.append(ChatText.duration(secs)) }
        workLabel.stringValue = "✓ " + times.joined(separator: " · ")
        workLabel.textColor = Theme.fgDim
        // right: tokens actually consumed THIS turn (new input incl. cache-write, + output).
        // cacheRead is excluded — it's context re-read, summed across tool iterations, not work.
        if let u = usage {
            tokenBase = t("chat.tokens", ["in": ChatText.tokens(u.input + u.cacheWrite), "out": ChatText.tokens(u.output)])
        }
        tokenLabel.stringValue = tokenBase
    }
    // Append the OVERALL plan-quota usage (fetched async) — this is the account's 5-hour /
    // weekly window utilization, not this turn's share (the API gives no absolute budget).
    func setQuota(sessionUsed: Int?, weeklyUsed: Int?) {
        var q: [String] = []
        if let s = sessionUsed { q.append(t("chat.quota.session", ["n": s])) }
        if let w = weeklyUsed { q.append(t("chat.quota.week", ["n": w])) }
        guard !q.isEmpty else { return }
        let quota = t("chat.plan") + q.joined(separator: " · ")
        tokenLabel.stringValue = tokenBase.isEmpty ? quota : tokenBase + "  ·  " + quota
    }
}

// MARK: - sub-agent lane card
final class SubagentCard: NSView {
    private let header = NSTextField(labelWithString: "")
    private let body = NSStackView()
    private let bar = NSView()
    private let type: String
    private var done = false

    init(type: String, desc: String) {
        self.type = type
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = Theme.hover.cgColor; layer?.cornerRadius = 8
        bar.wantsLayer = true; bar.layer?.backgroundColor = Theme.accent2.withAlphaComponent(0.8).cgColor; bar.layer?.cornerRadius = 1.5
        bar.translatesAutoresizingMaskIntoConstraints = false
        header.attributedStringValue = SubagentCard.headerText(type: type, desc: desc, running: true)
        header.lineBreakMode = .byTruncatingTail
        header.translatesAutoresizingMaskIntoConstraints = false
        body.orientation = .vertical; body.spacing = 4; body.alignment = .leading
        body.translatesAutoresizingMaskIntoConstraints = false
        [bar, header, body].forEach { addSubview($0) }
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            bar.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            bar.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            bar.widthAnchor.constraint(equalToConstant: 3),
            header.leadingAnchor.constraint(equalTo: bar.trailingAnchor, constant: 8),
            header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            header.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            body.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            body.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 6),
            body.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    func addTool(_ name: String, _ detail: String, _ code: String?, _ path: String?) {
        let line = ToolLine(name: name, detail: detail)
        line.translatesAutoresizingMaskIntoConstraints = false
        body.addArrangedSubview(line)
        line.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        if let code, !code.isEmpty {
            let cb = ChatText.codeBlock(code, diff: name == "Edit" || name == "MultiEdit", path: path)
            cb.translatesAutoresizingMaskIntoConstraints = false
            body.addArrangedSubview(cb)
            cb.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
        }
    }
    func addText(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let l = NSTextField(wrappingLabelWithString: t)
        l.font = UIScale.font(UIScale.small); l.textColor = Theme.fgDim; l.isSelectable = true
        l.translatesAutoresizingMaskIntoConstraints = false
        body.addArrangedSubview(l)
        l.widthAnchor.constraint(equalTo: body.widthAnchor).isActive = true
    }
    func finish(_ result: String) {
        guard !done else { return }
        done = true
        header.attributedStringValue = SubagentCard.headerText(type: type, desc: t("chat.done"), running: false)
    }
    private static func headerText(type: String, desc: String, running: Bool) -> NSAttributedString {
        let m = NSMutableAttributedString()
        m.append(NSAttributedString(string: running ? "⛓ " : "✓ ",
            attributes: [.foregroundColor: running ? Theme.accent2 : Theme.success, .font: UIScale.font(UIScale.small, .semibold)]))
        m.append(NSAttributedString(string: type,
            attributes: [.foregroundColor: Theme.fg, .font: UIScale.font(UIScale.small, .semibold)]))
        if !desc.isEmpty {
            m.append(NSAttributedString(string: "  ·  " + desc,
                attributes: [.foregroundColor: Theme.fgDim, .font: UIScale.font(UIScale.caption)]))
        }
        return m
    }
}

// MARK: - sub-agent PANE (its own scrolling column in the split, like a riven pane)
final class SubagentPane: NSView {
    private let header = NSTextField(labelWithString: "")
    private let spinner = NSProgressIndicator()
    private let scroll = NSScrollView()
    private let body = FlippedStack()
    private let type: String
    private var done = false
    var onClose: (() -> Void)?

    init(type: String, desc: String) {
        self.type = type
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg.cgColor
        layer?.borderWidth = 1; layer?.borderColor = Theme.hairline.cgColor
        // The pane must NOT demand horizontal width from its content — let text wrap instead of
        // growing the column (which was shrinking the conversation area).
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.defaultLow, for: .horizontal)

        // Quiet header strip: no filled bar — just a hairline under it (matches the open
        // transcript column, keeps the pane calm).
        let bar = NSView(); bar.translatesAutoresizingMaskIntoConstraints = false
        let sep = NSView(); sep.wantsLayer = true
        sep.layer?.backgroundColor = Theme.hairline.cgColor
        sep.translatesAutoresizingMaskIntoConstraints = false
        spinner.style = .spinning; spinner.controlSize = .small; spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        header.attributedStringValue = SubagentPane.headerText(type: type, desc: desc, running: true)
        header.lineBreakMode = .byTruncatingTail
        header.translatesAutoresizingMaskIntoConstraints = false

        body.orientation = .vertical; body.spacing = 8; body.alignment = .leading
        body.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        body.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = body
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        [bar, sep, scroll].forEach { addSubview($0) }
        bar.addSubview(spinner); bar.addSubview(header)   // no ✕ — the dock panel provides close
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: topAnchor),
            bar.leadingAnchor.constraint(equalTo: leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 30),
            sep.topAnchor.constraint(equalTo: bar.bottomAnchor),
            sep.leadingAnchor.constraint(equalTo: leadingAnchor),
            sep.trailingAnchor.constraint(equalTo: trailingAnchor),
            sep.heightAnchor.constraint(equalToConstant: 1),
            spinner.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 10),
            spinner.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            spinner.widthAnchor.constraint(equalToConstant: 12), spinner.heightAnchor.constraint(equalToConstant: 12),
            header.leadingAnchor.constraint(equalTo: spinner.trailingAnchor, constant: 6),
            header.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -10),
            header.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            scroll.topAnchor.constraint(equalTo: sep.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            body.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            body.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            body.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)   // clip width → wrap, no jitter
        ])
        scroll.hasHorizontalScroller = false
        spinner.startAnimation(nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    private func add(_ v: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = false
        body.addArrangedSubview(v)
        v.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -20).isActive = true
        scrollToBottom()
    }
    // Pin the sub-agent view to its newest line (flipped doc → bottom = max y). Skips the forced
    // layout when off-screen (window == nil) so a background pane's sub-agents don't peg the CPU.
    private func scrollToBottom() {
        guard window != nil else { return }
        layoutSubtreeIfNeeded()
        let clip = scroll.contentView
        clip.setBoundsOrigin(NSPoint(x: 0, y: max(0, body.frame.height - clip.bounds.height)))
        scroll.reflectScrolledClipView(clip)
    }
    override func viewDidMoveToWindow() {   // shown again → catch the scroll up to the latest
        super.viewDidMoveToWindow()
        if window != nil { scrollToBottom() }
    }
    func addTool(_ name: String, _ detail: String, _ code: String?, _ path: String?) {
        add(ToolLine(name: name, detail: detail))
        if let code, !code.isEmpty { add(ChatText.codeBlock(code, diff: name == "Edit" || name == "MultiEdit", path: path)) }
    }
    func addText(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        add(ChatText.proseMarkdown(t))
    }
    func finish(_ result: String) {
        guard !done else { return }
        done = true; spinner.stopAnimation(nil)
        header.attributedStringValue = SubagentPane.headerText(type: type, desc: t("chat.done"), running: false)
        // Show the sub-agent's FINAL answer — it arrives in the Agent tool_result and was being
        // dropped, which is why the sub-agent's analysis never appeared in its panel.
        let r = result.trimmingCharacters(in: .whitespacesAndNewlines)
        if !r.isEmpty { add(ChatText.proseMarkdown(r)) }
    }
    private static func headerText(type: String, desc: String, running: Bool) -> NSAttributedString {
        let m = NSMutableAttributedString()
        m.append(NSAttributedString(string: type,
            attributes: [.foregroundColor: Theme.fg, .font: UIScale.font(UIScale.small, .semibold)]))
        if !desc.isEmpty {
            m.append(NSAttributedString(string: "  ·  " + desc,
                attributes: [.foregroundColor: Theme.fgDim, .font: UIScale.font(UIScale.caption)]))
        }
        return m
    }
}

// MARK: - slash-command autocomplete popup (scrollable, shows all matches)
struct SlashCommand { let name: String; let desc: String }

final class SlashPopup: NSView {
    private let scroll = NSScrollView()
    private let stack = FlippedStack()
    private var items: [SlashCommand] = []
    private(set) var selected = 0
    private var rows: [NSView] = []
    static let rowH: CGFloat = 24

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg3.cgColor; layer?.cornerRadius = 8
        layer?.borderWidth = 1; layer?.borderColor = Theme.edge.cgColor
        layer?.shadowColor = NSColor.black.cgColor; layer?.shadowOpacity = 0.28
        layer?.shadowRadius = 12; layer?.shadowOffset = CGSize(width: 0, height: 4)
        stack.orientation = .vertical; stack.spacing = 0; stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 4, left: 4, bottom: 4, right: 4)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.widthAnchor)
        ])
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }

    var count: Int { items.count }
    func current() -> SlashCommand? { items.indices.contains(selected) ? items[selected] : nil }
    func move(_ d: Int) { guard !items.isEmpty else { return }; selected = (selected + d + items.count) % items.count; restyle(); scrollToSelected() }

    func set(_ list: [SlashCommand]) {
        items = list; selected = 0
        rows.forEach { $0.removeFromSuperview() }; rows = []
        for cmd in items {
            let row = NSView(); row.wantsLayer = true; row.layer?.cornerRadius = 5
            let name = NSTextField(labelWithString: "/" + cmd.name)
            name.font = UIScale.mono(UIScale.small, .semibold); name.textColor = Theme.fg
            name.translatesAutoresizingMaskIntoConstraints = false
            let desc = NSTextField(labelWithString: cmd.desc)
            desc.font = UIScale.font(UIScale.caption); desc.textColor = Theme.fgDim; desc.lineBreakMode = .byTruncatingTail
            desc.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(name); row.addSubview(desc)
            row.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                name.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 8),
                name.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                desc.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 10),
                desc.trailingAnchor.constraint(lessThanOrEqualTo: row.trailingAnchor, constant: -8),
                desc.centerYAnchor.constraint(equalTo: row.centerYAnchor),
                row.heightAnchor.constraint(equalToConstant: Self.rowH)
            ])
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -8).isActive = true
            rows.append(row)
        }
        restyle()
    }
    private func restyle() {
        for (i, row) in rows.enumerated() {
            row.layer?.backgroundColor = (i == selected ? Theme.accentMuted.cgColor : NSColor.clear.cgColor)
        }
    }
    private func scrollToSelected() {
        guard rows.indices.contains(selected) else { return }
        rows[selected].scrollToVisible(rows[selected].bounds)
    }
}
