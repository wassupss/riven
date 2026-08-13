import AppKit

// A small text button that runs a closure - lets static factory views (code blocks) wire
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
    // Nearest ChatPanel ancestor - lets a deeply-nested control (a code-block button) call back to
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
    var onKey: ((Selector) -> Bool)?     // slash-popup nav / mode cycle - return true if consumed
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
    // A plain-text NSTextView refuses image pastes - worse, when the clipboard holds ONLY an image
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

// MARK: - tool line ("◇ Read  math.js") - a quiet, muted step row (like the CLI's dim
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
        // A single horizontal stack pinned to the row's edges - the row height always wraps its
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
    // as "생각 중"), stopped when it finishes. Masking the single text label - not the whole
    // row - makes it read as a directional sweep instead of the whole row blinking.
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
    private var streamRow: NSView?
    private var finalized = false
    // 이미 최종 서식으로 확정한 접두부. 스트리밍은 그 뒤 꼬리만 담당한다.
    private var committed = 0
    // 블록 경계 스캐너의 상태 (앞부분을 매 틱마다 다시 훑으면 O(n²)이 된다).
    private var scanIdx = 0
    private var fenceOpen = false
    private var boundary = 0

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

    // Reveal a slice toward the full text - steady enough to look typed, fast enough to catch bursts.
    @discardableResult func advance() -> Bool {
        guard !finalized, shownCount < chars.count else { return false }
        let remaining = chars.count - shownCount
        let step = max(3, remaining / 5)                 // ease-out: bigger jumps when behind
        shownCount = min(chars.count, shownCount + step)
        scanForBoundary()
        // 빈 줄로 끝난 완성 블록은 바로 최종 서식으로 굳힌다 → 제목·표·목록·코드블록이
        // 답변이 끝나기 전에 제 모습으로 나타난다.
        if boundary > committed { commit(upTo: boundary) }
        let tail = String(chars[committed..<shownCount])
        if tail.isEmpty { streamRow?.isHidden = true }
        else {
            streamRow?.isHidden = false
            // 꼬리도 인라인 마크다운을 입혀서 그린다 (**굵게**·`코드`가 타이핑 중에도 보인다).
            ensureLabel().attributedStringValue = ChatText.attributedMarkdown(tail)
        }
        return true
    }

    /// 새로 드러난 구간만 훑어 "코드펜스 밖의 빈 줄" 위치를 기록한다.
    private func scanForBoundary() {
        // 항상 2자를 앞서 볼 수 있는 구간까지만 훑는다. 예전엔 "\n\n"이나 "```"가 이번에
        // 드러난 마지막 글자에 걸치면 그 자리를 건너뛴 채 scanIdx가 지나가 버려서, 코드펜스가
        // 열린 상태로 굳거나 문단 경계를 영영 놓쳤다 (스트리밍 중 블록 확정이 멈추던 원인).
        var i = max(scanIdx, 0)
        while i + 2 < shownCount {
            if chars[i] == "`", chars[i + 1] == "`", chars[i + 2] == "`" {
                fenceOpen.toggle(); i += 3; continue
            }
            if !fenceOpen, chars[i] == "\n", chars[i + 1] == "\n" { boundary = i + 2 }
            i += 1
        }
        scanIdx = i
    }

    private func commit(upTo idx: Int) {
        let seg = String(chars[committed..<idx])
        committed = idx
        // 스트리밍 행을 잠시 걷어내고 확정 블록을 넣은 뒤, 다시 맨 아래에 붙인다.
        streamRow?.removeFromSuperview(); streamRow = nil; streaming = nil
        for v in ChatText.render(seg, bullet: content.arrangedSubviews.isEmpty) {
            content.addArrangedSubview(v)
            v.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        }
    }

    private func ensureLabel() -> NSTextField {
        if let s = streaming { return s }
        // Wrap the streaming label in the SAME bullet + gutter row the final render uses, so the
        // text is already at its final x-position/indent while typing - renderFinal then only adds
        // inline emphasis instead of visibly reflowing the whole answer.
        let l = ChatText.prose("")
        // ⏺ 는 답변의 첫 블록에만. 확정된 블록이 이미 있으면 같은 들여쓰기만 맞춘다 -
        // 안 그러면 문단이 확정될 때마다 꼬리에 점이 새로 붙었다 사라진다.
        let row = content.arrangedSubviews.isEmpty ? ChatText.bulletRow(l) : ChatText.indentedProse(l)
        row.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        streaming = l; streamRow = row; return l
    }

    func renderFinal() {
        guard !finalized else { return }
        finalized = true
        // 확정된 블록은 그대로 두고 남은 꼬리만 최종 서식으로 바꾼다 - 예전엔 전체를 지우고
        // 다시 그려서 긴 답변이 끝날 때 화면이 통째로 리플로우됐다.
        streamRow?.removeFromSuperview(); streamRow = nil; streaming = nil
        let rest = String(chars[min(committed, chars.count)...])
        guard !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        for v in ChatText.render(rest, bullet: content.arrangedSubviews.isEmpty) {
            content.addArrangedSubview(v)
            v.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        }
    }
}

// A button whose background is ALWAYS a perfect circle. Rather than rounding the button's own
// layer (which renders as a capsule the instant the frame isn't perfectly square), it draws a
// dedicated circular fill layer of diameter = min(width,height), centered - so it's a circle no
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
/// 자기가 담고 있는 코드를 기억하는 상자 - 승인 카드가 같은 내용을 다시 그릴 때 중복을 걷어낸다.
final class CodeCarrier: NSView {
    var carriedCode: String?
}

// MARK: - link-aware label (routes link clicks to the riven browser panel, not the OS browser)
final class LinkLabel: NSTextField {
    override func mouseDown(with e: NSEvent) {
        if let url = linkAt(convert(e.locationInWindow, from: nil)) {
            enclosingChatPanel?.handleLinkClick(url); return
        }
        super.mouseDown(with: e)
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    private func linkAt(_ point: NSPoint) -> String? {
        let attr = attributedStringValue
        guard attr.length > 0 else { return nil }
        let storage = NSTextStorage(attributedString: attr)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 2                       // NSTextField 기본 여백에 맞춤
        layout.addTextContainer(container); storage.addLayoutManager(layout)
        let flipped = NSPoint(x: point.x, y: bounds.height - point.y)   // 텍스트뷰는 top-left 원점
        let idx = layout.characterIndex(for: flipped, in: container, fractionOfDistanceBetweenInsertionPoints: nil)
        guard idx < attr.length else { return nil }
        let v = attr.attribute(.link, at: idx, effectiveRange: nil)
        if let u = v as? URL { return u.absoluteString }
        return v as? String
    }
}

enum ChatText {
    /// 코드/명령을 클립보드로 복사하는 작은 아이콘 버튼. 누르면 잠깐 체크로 바뀐다.
    /// bash·일반 코드조각처럼 "에디터에서 열" 이유가 없는 블록에 붙인다 (실제 변경은 '변경 보기').
    static func copyButton(_ code: String) -> NSButton {
        var ref: NSButton?
        let b = ClosureButton(title: "") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(code, forType: .string)
            guard let bb = ref else { return }
            bb.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
            bb.contentTintColor = Theme.success
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak bb] in
                bb?.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
                bb?.contentTintColor = Theme.fgDim
            }
        }
        ref = b
        b.imagePosition = .imageOnly
        b.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: t("chat.copy"))
        b.contentTintColor = Theme.fgDim
        b.toolTip = t("chat.copy")
        b.setContentHuggingPriority(.required, for: .horizontal)
        return b
    }

    /// 한 줄 명령: 상자 하나에 코드와 작은 버튼만. 짧은 명령까지 머리글 달린 카드로 그리면
    /// 대화가 상자 더미가 된다.
    static func compactCode(_ code: String, path: String?) -> NSView {
        let box = CodeCarrier()
        box.carriedCode = code
        box.wantsLayer = true
        box.layer?.backgroundColor = Theme.bg3.cgColor
        box.layer?.cornerRadius = 6
        box.translatesAutoresizingMaskIntoConstraints = false
        let l = NSTextField(labelWithString: code)
        l.font = UIScale.mono(UIScale.small)
        l.textColor = Theme.fg
        l.lineBreakMode = .byTruncatingTail
        l.translatesAutoresizingMaskIntoConstraints = false
        let btn = copyButton(code)   // 한 줄 명령/코드조각 → 복사 아이콘
        btn.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(l); box.addSubview(btn)
        NSLayoutConstraint.activate([
            l.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 10),
            l.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            l.trailingAnchor.constraint(lessThanOrEqualTo: btn.leadingAnchor, constant: -8),
            btn.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -8),
            btn.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            box.heightAnchor.constraint(equalToConstant: UIScale.pt(30)),
        ])
        return box
    }

    // Prose is the focus of the transcript. Base text is SOFTENED (not full-contrast) so that
    // **bold** - full-brightness + heavier - clearly stands out; before, base was so dark that
    // emphasis was indistinguishable.
    private static let proseSize: CGFloat = UIScale.prose   // single source: the app type scale
    static var proseColor: NSColor { Theme.fg.withAlphaComponent(0.80) }   // regular text (calmer)
    static var proseStrong: NSColor { Theme.fg }                           // emphasized text (brighter)
    static func prose(_ s: String) -> NSTextField {
        let l = LinkLabel(wrappingLabelWithString: s)   // 링크 클릭 → 리븐 브라우저 (외부 브라우저 대신)
        l.font = UIScale.font(proseSize); l.textColor = proseColor
        l.translatesAutoresizingMaskIntoConstraints = false; l.isSelectable = true
        // Without this, clicking a selectable label makes the field editor STRIP rich attributes
        // to plain (bold/code coloring vanish, width changes → reflow). Keep the formatting.
        l.allowsEditingTextAttributes = true
        return l
    }
    // Roomier line spacing - the default was too tight to read.
    static var para: NSParagraphStyle {
        let p = NSMutableParagraphStyle(); p.lineSpacing = 5; p.paragraphSpacing = 6; return p
    }
    static func attributedProse(_ s: String) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.foregroundColor: proseColor, .font: UIScale.font(proseSize), .paragraphStyle: para])
    }
    // A SINGLE tilde is strikethrough to the markdown parser, but in Korean prose "20~30행" is a
    // numeric range - the range marker was opening a strikethrough that swallowed the rest of the
    // sentence (and ate the "~" itself). Escape lone tildes so they stay literal; "~~real~~"
    // strikethrough still works.
    private static let loneTilde = try? NSRegularExpression(pattern: "(?<!~)~(?!~)")
    static func escapeLoneTildes(_ s: String) -> String {
        guard let re = loneTilde, s.contains("~") else { return s }
        // Escape ONLY outside inline-code spans: markdown doesn't interpret escapes inside
        // backticks, so escaping there leaked a literal backslash into the rendered text
        // (`ls ~/tmp` came out as `ls \~/tmp`). Split on backticks and skip the odd segments.
        return s.components(separatedBy: "`").enumerated().map { i, part in
            guard i % 2 == 0, part.contains("~") else { return part }
            return re.stringByReplacingMatches(in: part, range: NSRange(part.startIndex..., in: part),
                                               withTemplate: "\\\\~")
        }.joined(separator: "`")
    }
    static func proseMarkdown(_ s: String) -> NSTextField {
        let l = prose(s)
        l.attributedStringValue = attributedMarkdown(s)
        return l
    }
    /// 인라인 마크다운(**굵게**, `코드`, *기울임*)이 적용된 본문 속성 문자열.
    /// 스트리밍 중에도 이걸 쓴다 - 예전엔 타이핑 동안 순수 텍스트로 그리다가 턴이 끝나야
    /// 서식이 튀어나와서, 답변이 다 끝날 때까지 굵게·코드가 원문 그대로 보였다.
    /// 미완성 마크업(닫히지 않은 **)은 그냥 매치가 안 될 뿐이라 부분 문자열에도 안전하다.
    static func attributedMarkdown(_ s: String) -> NSAttributedString {
        if let attr = try? NSAttributedString(markdown: escapeLoneTildes(s),
              options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            let m = NSMutableAttributedString(attributedString: attr)
            let full = NSRange(location: 0, length: m.length)
            m.addAttributes([.foregroundColor: proseColor, .font: UIScale.font(proseSize), .paragraphStyle: para],
                            range: full)
            // Re-apply the inline emphasis the wholesale font pass just erased - **bold** is
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
            linkifyBareURLs(m)
            return m
        }
        return attributedProse(s)
    }
    // 맨 URL(http/https)에 .link + accent 밑줄을 입힌다. [md](링크) 는 이미 .link 라 건드리지 않는다.
    // LinkLabel 이 클릭을 리븐 브라우저로 보낸다.
    private static let urlRe = try? NSRegularExpression(pattern: "https?://[^\\s)\\]}\"'<>]+")
    static func linkifyBareURLs(_ m: NSMutableAttributedString) {
        guard let re = urlRe else { return }
        let s = m.string
        for match in re.matches(in: s, range: NSRange(s.startIndex..., in: s)).reversed() {
            if m.attribute(.link, at: match.range.location, effectiveRange: nil) != nil { continue }  // 이미 링크
            var url = (s as NSString).substring(with: match.range)
            while let last = url.last, ".,;:!?".contains(last) { url.removeLast() }   // 문장부호 제외
            let r = NSRange(location: match.range.location, length: url.utf16.count)
            m.addAttributes([.link: url, .foregroundColor: Theme.accent2,
                             .underlineStyle: NSUnderlineStyle.single.rawValue], range: r)
        }
    }
    // A prose paragraph with a CLI-style bullet marker in the left gutter.
    static func proseParagraph(_ text: String) -> NSView {
        bulletRow(proseMarkdown(text))
    }
    // The same bullet + gutter container, around an arbitrary label. Used for the STREAMING label
    // too, so the text sits at its final position from the first character - previously streaming
    // used a bare full-width label and the whole answer jumped/indented when renderFinal ran.
    static func bulletRow(_ label: NSTextField) -> NSView {
        // ⏺ 마커·들여쓰기 모두 제거: 왼쪽 타임라인 노드가 턴 마커. 어시스턴트 글은 들여쓰지 않고
        // 사용자 말풍선과 같은 왼쪽 선에 맞춘다.
        label
    }
    static func codeBlock(_ code: String, diff: Bool = false, path: String? = nil, lang: String? = nil) -> NSView {
        // 한 줄짜리 짧은 명령까지 머리글 달린 코드 카드로 그리면 대화가 상자 더미가 된다.
        // 그런 건 한 줄로 눕히고, 여러 줄·긴 코드만 카드로 세운다.
        let oneLiner = !code.contains("\n") && code.count <= 110 && !diff
        if oneLiner { return compactCode(code, path: path) }
        let box = CodeCarrier()
        box.carriedCode = code
        box.wantsLayer = true
        box.layer?.backgroundColor = Theme.bg3.cgColor          // distinct code surface (like the CLI)
        box.layer?.cornerRadius = 8; box.layer?.borderWidth = 1
        box.layer?.borderColor = Theme.edge.cgColor
        box.translatesAutoresizingMaskIntoConstraints = false

        // Header: language label (left) + action button (right), separated from the code.
        let header = NSView(); header.translatesAutoresizingMaskIntoConstraints = false
        let langL = NSTextField(labelWithString: lang?.isEmpty == false ? lang!.lowercased() : (diff ? "diff" : ""))
        langL.font = UIScale.mono(UIScale.caption, .semibold)
        langL.textColor = Theme.fgDim.withAlphaComponent(0.8)
        langL.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(langL)
        let isEdit = diff && path != nil
        do {
            // 실제 변경(Edit diff)만 '변경 보기'(에디터에서 diff 열기). bash·일반 코드조각은 복사 아이콘.
            let btn: NSButton
            if isEdit {
                let title = t("chat.viewDiff")
                let b = ClosureButton(title: title) { [weak box] in
                    guard let panel = box?.enclosingChatPanel, let path else { return }
                    panel.showEditFromDiff(code, path: path)
                }
                b.attributedTitle = NSAttributedString(string: title, attributes: [
                    .foregroundColor: Theme.accent2, .font: UIScale.font(UIScale.caption, .medium)])
                btn = b
            } else {
                btn = copyButton(code)
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
    // so code blocks read like the CLI's coloring - a regex pass, not a full grammar.
    private static let kwPattern = "\\b(func|let|var|const|if|else|elif|for|while|do|return|import|from|as|class|struct|enum|protocol|extension|interface|type|def|function|lambda|public|private|internal|fileprivate|static|final|override|guard|switch|case|default|break|continue|new|delete|async|await|try|catch|finally|throw|throws|typealias|package|self|this|super|true|false|nil|null|none|undefined|True|False|None|and|or|not|in|is|export|module|namespace|use|fn|impl|mut|pub|match|where|with|yield|assert|print|echo)\\b"
    static func highlight(_ code: String) -> NSAttributedString {
        let p = NSMutableParagraphStyle(); p.lineSpacing = 3
        let base: [NSAttributedString.Key: Any] = [.font: UIScale.mono(UIScale.body), .foregroundColor: Theme.fg, .paragraphStyle: p]
        let m = NSMutableAttributedString(string: code, attributes: base)
        // Skip regex highlighting for large blocks: the string/comment patterns can catastrophically
        // backtrack, and the per-match `protected` intersection is O(n²) - together they pegged the
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
    /// 코드펜스로 먼저 자르고, 산문 구간은 블록 단위(제목·표·목록·문단)로 파싱한다.
    /// 예전에는 산문 전체를 인라인 마크다운 라벨 하나로 그려서 "## 제목", "- 항목",
    /// "| a | b |" 가 전부 원문 그대로 보였다.
    static func render(_ text: String, bullet: Bool = true) -> [NSView] {
        // 코드펜스(```)는 "줄 시작"일 때만 연다/닫는다. 예전엔 텍스트 전체에서 ``` 를 세어
        // 짝을 맞췄는데, 표 셀 안의 인라인 ``` (마크다운 문법 예시 등)까지 펜스로 세어서
        // 짝이 어긋났고, 그 아래 인용구·제목이 통째로 코드블록으로 먹혀버렸다.
        var out: [NSView] = []
        var proseBuf: [String] = [], codeBuf: [String] = []
        var inCode = false, lang: String?
        func flushProse() { if !proseBuf.isEmpty { out += blocks(proseBuf.joined(separator: "\n")); proseBuf = [] } }
        func flushCode() {
            let code = codeBuf.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !code.isEmpty { out.append(codeBlock(code, lang: lang)) }
            codeBuf = []; lang = nil
        }
        for line in text.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {   // 펜스는 줄 시작만
                if inCode { flushCode(); inCode = false }
                else {
                    flushProse(); inCode = true
                    let l = line.trimmingCharacters(in: .whitespaces).dropFirst(3).trimmingCharacters(in: .whitespaces)
                    lang = l.isEmpty ? nil : String(l)
                }
            } else if inCode { codeBuf.append(line) }
            else { proseBuf.append(line) }
        }
        if inCode { flushCode() } else { flushProse() }   // 닫히지 않은 펜스도 코드로 마감
        return out
    }

    /// 스트리밍 꼬리용 (들여쓰기 없음).
    static func indentedProse(_ v: NSView) -> NSView { v }

    private static func indented(_ v: NSView, by x: CGFloat) -> NSView {
        let row = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(v)
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: x),
            v.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            v.topAnchor.constraint(equalTo: row.topAnchor),
            v.bottomAnchor.constraint(equalTo: row.bottomAnchor),
        ])
        return row
    }

    private static let headingRe = try? NSRegularExpression(pattern: "^(#{1,6})\\s+(.*)$")
    private static let listRe = try? NSRegularExpression(pattern: "^\\s*(?:[-*+]|\\d+[.)])\\s+(.*)$")
    private static func isTableRow(_ l: String) -> Bool {
        let t = l.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("|") && t.dropFirst().contains("|")
    }
    private static func isTableDivider(_ l: String) -> Bool {
        let t = l.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("|") else { return false }
        return t.allSatisfy { "|-: ".contains($0) } && t.contains("-")
    }
    private static func match(_ re: NSRegularExpression?, _ line: String) -> [String]? {
        guard let re, let m = re.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            Range(m.range(at: i), in: line).map { String(line[$0]) } ?? ""
        }
    }

    /// 산문 구간 → 블록 뷰들.
    private static func blocks(_ text: String) -> [NSView] {
        var out: [NSView] = []
        var para: [String] = []
        func flushPara() {
            let joined = para.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            para = []
            if !joined.isEmpty { out.append(proseMarkdown(joined)) }
        }
        let lines = text.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { flushPara(); i += 1; continue }
            // 표: 헤더 행 + 구분선(|---|)이 이어질 때만 표로 본다 (본문의 "|" 오인 방지).
            if isTableRow(line), i + 1 < lines.count, isTableDivider(lines[i + 1]) {
                flushPara()
                var rows: [[String]] = [tableCells(line)]
                i += 2
                while i < lines.count, isTableRow(lines[i]) { rows.append(tableCells(lines[i])); i += 1 }
                out.append(tableBlock(rows))
                continue
            }
            // 인용구: > 로 시작하는 연속 줄. accent 바 + 옅은 글자로 그린다 (예전엔 "> " 가
            // 원문 그대로 보였다).
            if line.trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                flushPara()
                var quote: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    var t = lines[i].trimmingCharacters(in: .whitespaces)
                    t.removeFirst()                          // ">"
                    if t.hasPrefix(" ") { t.removeFirst() }
                    quote.append(t); i += 1
                }
                out.append(blockquoteBlock(quote.joined(separator: "\n")))
                continue
            }
            if let m = match(headingRe, line) {
                flushPara()
                out.append(heading(m[2], level: m[1].count))
                i += 1; continue
            }
            if match(listRe, line) != nil {
                flushPara()
                var items: [String] = []
                var ordered = false
                while i < lines.count, let m = match(listRe, lines[i]) {
                    if lines[i].trimmingCharacters(in: .whitespaces).first?.isNumber == true { ordered = true }
                    items.append(m[1]); i += 1
                }
                out.append(listBlock(items, ordered: ordered))
                continue
            }
            para.append(line); i += 1
        }
        flushPara()
        return out
    }

    private static func tableCells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        // `\|`(이스케이프 파이프)와 백틱 코드 안의 `|` 는 셀 구분자가 아니다 - 예전엔 그대로 잘라
        // "| a | b |" 같은 셀이 여러 칸으로 쪼개져 열이 어긋났다.
        var cells: [String] = [], cur = "", inCode = false, esc = false
        for ch in t {
            if esc { cur.append(ch == "|" ? "|" : "\\\(ch)"); esc = false; continue }
            if ch == "\\" { esc = true; continue }
            if ch == "`" { inCode.toggle(); cur.append(ch); continue }
            if ch == "|" && !inCode { cells.append(cur.trimmingCharacters(in: .whitespaces)); cur = ""; continue }
            cur.append(ch)
        }
        if esc { cur.append("\\") }
        cells.append(cur.trimmingCharacters(in: .whitespaces))
        return cells
    }

    /// 인용구 블록: 왼쪽 accent 바 + 옅은(이탤릭 느낌) 본문.
    private static func blockquoteBlock(_ text: String) -> NSView {
        let row = NSView()
        let bar = NSView(); bar.wantsLayer = true
        bar.layer?.backgroundColor = Theme.accent2.withAlphaComponent(0.55).cgColor
        bar.layer?.cornerRadius = 1.5
        bar.translatesAutoresizingMaskIntoConstraints = false
        let l = prose(text)
        let m = NSMutableAttributedString(attributedString: attributedMarkdown(text))
        m.addAttribute(.foregroundColor, value: Theme.fgDim, range: NSRange(location: 0, length: m.length))
        l.attributedStringValue = m
        l.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(bar); row.addSubview(l)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: row.leadingAnchor),
            bar.topAnchor.constraint(equalTo: row.topAnchor, constant: 1),
            bar.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -1),
            bar.widthAnchor.constraint(equalToConstant: 3),
            l.leadingAnchor.constraint(equalTo: bar.trailingAnchor, constant: UIScale.pt(10)),
            l.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            l.topAnchor.constraint(equalTo: row.topAnchor, constant: 1),
            l.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -1),
        ])
        return row
    }

    private static func heading(_ text: String, level: Int) -> NSView {
        let l = prose(text)
        let size = proseSize + (level <= 1 ? 4 : level == 2 ? 2 : 1)
        l.attributedStringValue = NSAttributedString(string: text, attributes: [
            .font: UIScale.font(size, .bold), .foregroundColor: proseStrong])
        return l
    }

    private static func listBlock(_ items: [String], ordered: Bool) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical; stack.spacing = 4; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        for (i, item) in items.enumerated() {
            let marker = NSTextField(labelWithString: ordered ? "\(i + 1)." : "•")
            marker.font = UIScale.font(proseSize); marker.textColor = Theme.fgDim
            marker.translatesAutoresizingMaskIntoConstraints = false
            marker.setContentHuggingPriority(.required, for: .horizontal)
            let body = proseMarkdown(item)
            let row = NSView()
            row.addSubview(marker); row.addSubview(body)
            NSLayoutConstraint.activate([
                marker.leadingAnchor.constraint(equalTo: row.leadingAnchor),
                marker.firstBaselineAnchor.constraint(equalTo: body.firstBaselineAnchor),
                marker.widthAnchor.constraint(greaterThanOrEqualToConstant: UIScale.pt(16)),
                body.leadingAnchor.constraint(equalTo: marker.trailingAnchor, constant: UIScale.pt(6)),
                body.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                body.topAnchor.constraint(equalTo: row.topAnchor),
                body.bottomAnchor.constraint(equalTo: row.bottomAnchor),
            ])
            row.translatesAutoresizingMaskIntoConstraints = false
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return stack
    }

    /// 마크다운 표 → 실제 표. 헤더는 굵게 + 옅은 바탕, 행 사이에 hairline.
    private static func tableBlock(_ rows: [[String]]) -> NSView {
        let cols = rows.map { $0.count }.max() ?? 0
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = Theme.bg3.withAlphaComponent(0.5).cgColor
        box.layer?.cornerRadius = 8
        box.layer?.borderWidth = 1
        box.layer?.borderColor = Theme.edge.cgColor
        box.translatesAutoresizingMaskIntoConstraints = false
        let grid = NSGridView(numberOfColumns: max(1, cols), rows: 0)
        // 셀 자체의 여백을 넉넉히 (행/열 간격 = 칸 안쪽 여백). 표 바깥 여백(pad)은 오히려 줄인다.
        grid.rowSpacing = UIScale.pt(13); grid.columnSpacing = UIScale.pt(28)
        grid.translatesAutoresizingMaskIntoConstraints = false
        for (r, row) in rows.enumerated() {
            let cells: [NSView] = (0..<max(1, cols)).map { c in
                let text = c < row.count ? row[c] : ""
                let l = prose(text)
                if r == 0 {
                    l.attributedStringValue = NSAttributedString(string: text, attributes: [
                        .font: UIScale.font(proseSize, .semibold), .foregroundColor: proseStrong])
                } else {
                    l.attributedStringValue = attributedMarkdown(text)
                }
                l.maximumNumberOfLines = 0
                return l
            }
            grid.addRow(with: cells)
        }
        // 헤더 아래 구분선 (NSGridView는 셀 사이 선을 못 그리므로 얇은 뷰를 깐다).
        box.addSubview(grid)
        let pad = UIScale.pt(9)   // 표 바깥 여백은 담백하게 (셀 여백은 행/열 간격으로 준다)
        NSLayoutConstraint.activate([
            grid.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: pad),
            grid.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor, constant: -pad),
            grid.topAnchor.constraint(equalTo: box.topAnchor, constant: pad),
            grid.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -pad),
        ])
        // 열 사이 세로 구분선. 셀은 좌측정렬이라 각 열의 왼쪽 경계 = 그 열 셀의 leading.
        // 다음 열 leading 에서 열간격 절반만큼 왼쪽에 얇은 선을 둔다 (내용 폭과 무관하게 안정적).
        if cols > 1 {
            for c in 1..<cols {
                guard let next = grid.cell(atColumnIndex: c, rowIndex: 0).contentView else { continue }
                let v = NSView(); v.wantsLayer = true
                v.layer?.backgroundColor = Theme.edge.cgColor
                v.translatesAutoresizingMaskIntoConstraints = false
                box.addSubview(v)
                NSLayoutConstraint.activate([
                    v.widthAnchor.constraint(equalToConstant: 1),
                    v.centerXAnchor.constraint(equalTo: next.leadingAnchor, constant: -grid.columnSpacing / 2),
                    v.topAnchor.constraint(equalTo: grid.topAnchor),
                    v.bottomAnchor.constraint(equalTo: grid.bottomAnchor),
                ])
            }
        }
        if rows.count > 1 {
            let hair = NSView(); hair.wantsLayer = true
            hair.layer?.backgroundColor = Theme.edge.cgColor
            hair.translatesAutoresizingMaskIntoConstraints = false
            box.addSubview(hair)
            let headerRow = grid.row(at: 0)
            NSLayoutConstraint.activate([
                hair.leadingAnchor.constraint(equalTo: box.leadingAnchor),
                hair.trailingAnchor.constraint(equalTo: box.trailingAnchor),
                hair.heightAnchor.constraint(equalToConstant: 1),
                hair.topAnchor.constraint(equalTo: headerRow.cell(at: 0).contentView!.bottomAnchor,
                                          constant: UIScale.pt(4)),
            ])
        }
        // 데이터 행 사이 가로 구분선 - 헤더선과 완전히 동일하게 (해당 행 셀 bottom + 4, Theme.edge,
        // 같은 폭·두께). 예전엔 위치 기준이 달라(행 top - 간격절반) 헤더선과 어긋나 툭 튀어 보였다.
        if rows.count > 2 {
            for r in 1..<(rows.count - 1) {
                guard let cell = grid.cell(atColumnIndex: 0, rowIndex: r).contentView else { continue }
                let h = NSView(); h.wantsLayer = true
                h.layer?.backgroundColor = Theme.edge.cgColor
                h.translatesAutoresizingMaskIntoConstraints = false
                box.addSubview(h)
                NSLayoutConstraint.activate([
                    h.leadingAnchor.constraint(equalTo: box.leadingAnchor),
                    h.trailingAnchor.constraint(equalTo: box.trailingAnchor),
                    h.heightAnchor.constraint(equalToConstant: 1),
                    h.topAnchor.constraint(equalTo: cell.bottomAnchor, constant: UIScale.pt(4)),
                ])
            }
        }
        return box
    }

    // token formatting: 1234 → "1.2k"
    static func tokens(_ n: Int) -> String { n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)" }
    // 상대 시각: 방금 / N분 전 / N시간 전 / N일 전.
    static func relative(_ d: Date) -> String {
        let s = Int(max(0, Date().timeIntervalSince(d)))
        if s < 60 { return t("chat.time.now") }
        if s < 3600 { return t("chat.time.min", ["n": s / 60]) }
        if s < 86400 { return t("chat.time.hour", ["n": s / 3600]) }
        return t("chat.time.day", ["n": s / 86400])
    }
    // 실시간 출력 토큰 추정 (message_delta 는 턴 끝에 한 번만 오므로, 스트리밍 텍스트로 어림한다).
    // CJK 는 토큰 밀도가 높아 글자당 ~1.6, 그 외는 ~4글자당 1토큰으로 잡는다. 끝에 정확값으로 대체.
    static func estimateTokens(_ s: String) -> Int {
        var cjk = 0, other = 0
        for u in s.unicodeScalars {
            let v = u.value
            if (0xAC00...0xD7A3).contains(v) || (0x3040...0x30FF).contains(v) || (0x4E00...0x9FFF).contains(v) { cjk += 1 }
            else { other += 1 }
        }
        return Int(Double(cjk) * 1.6 + Double(other) / 4.0)
    }
    // elapsed: seconds → "45초" / "2분 5초" / "1시간 3분"
    static func duration(_ secs: Int) -> String {
        if secs < 60 { return t("chat.dur.sec", ["n": secs]) }
        if secs < 3600 { let m = secs / 60, s = secs % 60; return s == 0 ? t("chat.dur.min", ["n": m]) : t("chat.dur.minSec", ["m": m, "s": s]) }
        let h = secs / 3600, m = (secs % 3600) / 60; return m == 0 ? t("chat.dur.hour", ["n": h]) : t("chat.dur.hourMin", ["h": h, "m": m])
    }
}

// MARK: - user message (LEFT-aligned) - an accent bar + quiet tint, like the CLI's "> "
// prompt line: instantly reads as "you said this" without a loud bordered box.
/// 사용자가 보낸 말. 왼쪽 얇은 선 하나로는 어시스턴트 글과 구분되지 않아서, 옅은 배경과
/// 둥근 모서리를 준다 (읽는 사람은 "누가 한 말인지" 를 색·모양으로 먼저 읽는다).
final class UserBubble: NSView {
    private let card = NSView()
    private let queuedTag = NSTextField(labelWithString: t("chat.queuedTag"))
    /// 색을 입힐 토큰 정보 (실재하는 명령/스킬, 같은 그룹 동료). 입력창에서 보던 색이 보낸
    /// 뒤에도 그대로 남게 한다.
    struct Tokens { let commands: Set<String>; let peers: [String] }
    init(text: String, tokens: Tokens? = nil) {
        super.init(frame: .zero)
        wantsLayer = true
        card.wantsLayer = true
        // 왼쪽 accent 바 없이 테마 accent 를 옅게 깐 배경만으로 "내가 한 말" 을 나타낸다.
        card.layer?.backgroundColor = Theme.accent.withAlphaComponent(Theme.isLight ? 0.10 : 0.14).cgColor
        card.layer?.cornerRadius = 10
        card.layer?.masksToBounds = true
        card.translatesAutoresizingMaskIntoConstraints = false
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = UIScale.font(UIScale.prose); l.textColor = Theme.fg; l.isSelectable = true
        let p = NSMutableParagraphStyle(); p.lineSpacing = 4
        let base: [NSAttributedString.Key: Any] = [
            .foregroundColor: Theme.fg, .font: UIScale.font(UIScale.prose), .paragraphStyle: p]
        l.attributedStringValue = tokens.map {
            ChatTokens.attributed(text, base: base, commands: $0.commands, peers: $0.peers)
        } ?? NSAttributedString(string: text, attributes: base)
        l.translatesAutoresizingMaskIntoConstraints = false
        queuedTag.font = UIScale.font(UIScale.caption, .medium); queuedTag.textColor = Theme.warning
        queuedTag.isHidden = true
        queuedTag.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(l); card.addSubview(queuedTag); addSubview(card)
        // The tag sits on its OWN line BELOW the message (it used to be pinned top-right, overlapping
        // the text). Two card-bottom constraints toggle so the card only reserves the tag's row while
        // queued - otherwise it collapses to hug the text.
        bottomToText = card.bottomAnchor.constraint(equalTo: l.bottomAnchor, constant: 9)
        bottomToTag = card.bottomAnchor.constraint(equalTo: queuedTag.bottomAnchor, constant: 9)
        NSLayoutConstraint.activate([
            l.topAnchor.constraint(equalTo: card.topAnchor, constant: 9),
            l.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 13),
            l.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -13),
            queuedTag.topAnchor.constraint(equalTo: l.bottomAnchor, constant: 3),
            queuedTag.leadingAnchor.constraint(equalTo: l.leadingAnchor),
            queuedTag.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -13),
            bottomToText,
            card.topAnchor.constraint(equalTo: topAnchor),
            // 아래 여백 strip - hover 액션이 말풍선 위가 아니라 여기 뜬다.
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -40)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    private var bottomToText: NSLayoutConstraint!
    private var bottomToTag: NSLayoutConstraint!
    /// 동료에게 넘긴 메시지 - 이 팬의 에이전트가 아니라 누구에게 갔는지 버블에 붙인다.
    func setDelegated(_ who: String) {
        queuedTag.stringValue = "→ " + who
        queuedTag.textColor = Theme.accent
        queuedTag.isHidden = false
        bottomToText.isActive = false
        bottomToTag.isActive = true
    }
    // Mid-turn messages wait their turn: dim + a "대기 중" tag until they start (CLI-style ack).
    func setQueued(_ q: Bool) {
        queuedTag.isHidden = !q
        bottomToText.isActive = !q       // reserve the tag's row only while queued
        bottomToTag.isActive = q
        alphaValue = q ? 0.55 : 1
    }
}

// MARK: - inline choice card (permission / plan-proceed / any agent choice)
// N options, keyboard: ←→ (or ↑↓) select, Enter confirm. Mirrors the CLI's arrow-select prompt.
final class ApprovalCard: NSView {
    private var buttons: [NSButton] = []
    private let options: [(String, () -> Void)]
    private let statusLabel = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: t("chat.cardHintCancel"))
    private var sel = 0
    private var decided = false
    /// Esc / the 취소 button. Nil means the card can't be dismissed (a permission prompt must be
    /// answered), so only riven's own choice cards set it.
    var onCancel: (() -> Void)?
    /// "기타" 를 골라 직접 입력한 답 (선택지 대신). nil 이면 기타 옵션을 안 보인다.
    private let onCustom: ((String) -> Void)?
    private let hasCustom: Bool
    private let customField = NSTextField()
    private var itemCount: Int { options.count + (hasCustom ? 1 : 0) }

    init(title: String, detail: String, code: String?, path: String?,
         options: [(String, () -> Void)], custom: ((String) -> Void)? = nil) {
        self.options = options
        self.onCustom = custom
        self.hasCustom = custom != nil
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
        if hasCustom {                                   // "기타" 버튼 (직접 입력)
            let b = NSButton(); b.title = t("chat.other"); b.bezelStyle = .rounded
            b.wantsLayer = true; b.layer?.cornerRadius = 6
            b.tag = options.count; b.target = self; b.action = #selector(tap(_:))
            b.translatesAutoresizingMaskIntoConstraints = false
            buttons.append(b)
        }
        statusLabel.font = UIScale.font(UIScale.small, .semibold); statusLabel.textColor = Theme.fgDim
        statusLabel.translatesAutoresizingMaskIntoConstraints = false; statusLabel.isHidden = true
        hint.font = UIScale.font(UIScale.caption); hint.textColor = Theme.fgDim
        hint.translatesAutoresizingMaskIntoConstraints = false

        let col = NSStackView(); col.orientation = .vertical; col.alignment = .leading; col.spacing = 6
        col.translatesAutoresizingMaskIntoConstraints = false
        col.addArrangedSubview(titleL)
        // 설명이 코드와 같은 말이면 한 번만 보여 준다 (Bash 승인에서 명령이 두 줄로 겹쳤다).
        let codeText = (code ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let detailText = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        if !detailText.isEmpty, detailText != codeText { col.addArrangedSubview(sub) }
        if let code, !code.isEmpty {
            // 승인은 "이걸 실행할까요?" 를 묻는 자리다. 전문을 다 펼칠 필요가 없어서 한 줄로
            // 줄여 보여 주고(넘치면 …), 자세히 볼 사람은 에디터에서 연다. 예전에는 코드 상자가
            // 카드 높이의 절반을 먹었다.
            let oneLine = code.split(separator: "\n").first.map(String.init) ?? code
            let more = code.contains("\n")
            let cmd = NSTextField(labelWithString: oneLine + (more ? " …" : ""))
            cmd.font = UIScale.mono(UIScale.small)
            cmd.textColor = Theme.fg
            cmd.lineBreakMode = .byTruncatingTail
            cmd.translatesAutoresizingMaskIntoConstraints = false
            let box = NSView()
            box.wantsLayer = true
            box.layer?.cornerRadius = 6
            box.layer?.backgroundColor = Theme.bg.withAlphaComponent(0.55).cgColor
            box.translatesAutoresizingMaskIntoConstraints = false
            box.addSubview(cmd)
            NSLayoutConstraint.activate([
                cmd.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 8),
                cmd.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -8),
                cmd.topAnchor.constraint(equalTo: box.topAnchor, constant: 5),
                cmd.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -5),
            ])
            col.addArrangedSubview(box)
            box.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
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
        if hasCustom {                                   // 직접 입력 필드 (기타 선택 시 노출)
            customField.placeholderString = t("chat.otherPlaceholder")
            customField.font = UIScale.font(UIScale.body)
            customField.isHidden = true
            customField.target = self; customField.action = #selector(submitCustom)
            customField.translatesAutoresizingMaskIntoConstraints = false
            col.addArrangedSubview(customField)
            customField.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true
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
    // 카드를 클릭하면 키보드 포커스도 카드로 온다. 이게 없으면 카드를 눌러도 first responder 는
    // 입력창에 남아 ←→/Enter 가 카드를 움직이지 못한다.
    override func mouseDown(with e: NSEvent) {
        if acceptsFirstResponder { window?.makeFirstResponder(self) }
        super.mouseDown(with: e)
    }

    override func keyDown(with e: NSEvent) {
        let n = max(1, itemCount)
        switch e.keyCode {
        case 123, 126: sel = (sel - 1 + n) % n; restyleSel()   // ← / ↑
        case 124, 125: sel = (sel + 1) % n; restyleSel()        // → / ↓
        case 36, 76, 49: pick(sel)                              // return / enter / space
        case 53: onCancel?()                                    // esc - back out
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
        guard !decided else { return }
        if hasCustom, i == options.count { revealCustom(); return }   // "기타" → 입력 노출
        guard options.indices.contains(i) else { return }
        decided = true
        buttons.forEach { $0.isHidden = true }; hint.isHidden = true; customField.isHidden = true
        statusLabel.isHidden = false
        statusLabel.stringValue = "✓ " + options[i].0
        statusLabel.textColor = Theme.success
        layer?.borderColor = Theme.success.withAlphaComponent(0.4).cgColor
        options[i].1()
    }
    private func revealCustom() {
        customField.isHidden = false
        buttons.forEach { $0.isHidden = true }
        hint.stringValue = t("chat.otherHint")
        DispatchQueue.main.async { [weak self] in self?.window?.makeFirstResponder(self?.customField) }
    }
    @objc private func submitCustom() {
        let text = customField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !decided, !text.isEmpty else { return }
        decided = true
        customField.isHidden = true; hint.isHidden = true
        statusLabel.isHidden = false
        statusLabel.stringValue = "✓ " + (text.count > 40 ? String(text.prefix(40)) + "…" : text)
        statusLabel.textColor = Theme.success
        layer?.borderColor = Theme.success.withAlphaComponent(0.4).cgColor
        onCustom?(text)
    }
    func debugStatus() -> String {
        (statusLabel.isHidden ? "(표시 없음)" : statusLabel.stringValue)
            + " 버튼보임=\(buttons.contains { !$0.isHidden })"
    }
    /// 답을 받을 수 없게 됐다 (시간 초과·세션 종료). 버튼을 걷고 이유를 남긴다 -
    /// 예전에는 카드가 그대로 눌리는 것처럼 보였고, 눌러 봐야 실패를 알 수 있었다.
    func expire(_ reason: String) {
        guard !decided else { return }
        decided = true
        buttons.forEach { $0.isHidden = true }; hint.isHidden = true
        statusLabel.isHidden = false
        statusLabel.stringValue = "⏱ " + t("chat.expired.badge") + " · " + reason
        statusLabel.textColor = Theme.warning
        layer?.borderColor = Theme.warning.withAlphaComponent(0.35).cgColor
        alphaValue = 0.7
    }

    /// Close the card without running an option (Esc / 취소).
    func dismiss(_ label: String) {
        guard !decided else { return }
        decided = true
        buttons.forEach { $0.isHidden = true }; hint.isHidden = true
        statusLabel.isHidden = false
        statusLabel.stringValue = "· " + label
        statusLabel.textColor = Theme.fgDim
        layer?.borderColor = Theme.edge.cgColor
    }
}

// MARK: - one assistant turn: an OPEN column (prose sits directly on the chat background,
// like the CLI - no boxed card competing with the code blocks). A hairline rule + dim
// footer under the content delimit the turn: working indicator (spinner + 생각/작성 중) on
// the LEFT and the token/quota summary on the RIGHT.
final class TurnBlock: NSView {
    private let card = NSView()               // invisible layout container for the content
    private let content = NSStackView()
    // 상단 인라인 상태 행: [스피너/체크] + 라벨(생각 중→작성 중→완료·토큰·시각) + 복사. 답변은 그 아래.
    private let statusRow = NSStackView()
    private let spinner = NSProgressIndicator()
    private let statusIcon = NSImageView()     // 완료 체크 / 대기 아이콘 (스피너 대신)
    private let statusLabel = NSTextField(labelWithString: "")
    private let copyBtn = NSButton()
    private var openText: AssistantText?
    private var finished = false
    private var hasText = false
    private var lastSecs = 0
    private var thinkingSecs: Int?      // seconds until first token
    private var waiting = false         // paused on a permission/choice prompt
    private var finishedAt: Date?       // 완료 시각 (상대시간 표시용)
    private var doneBase = ""           // "완료 · 8초 · ↑10.8k ↓512" (시간 앞부분, refreshTime 이 시간만 갱신)

    override init(frame: NSRect) {
        super.init(frame: frame)
        card.translatesAutoresizingMaskIntoConstraints = false   // draws nothing - open column
        content.orientation = .vertical; content.spacing = 9; content.alignment = .leading
        content.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(content)

        spinner.style = .spinning; spinner.controlSize = .small; spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        statusIcon.isHidden = true; statusIcon.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = UIScale.font(UIScale.caption, .medium); statusLabel.textColor = Theme.accent2
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        copyBtn.bezelStyle = .inline; copyBtn.isBordered = false; copyBtn.imagePosition = .imageOnly
        copyBtn.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: t("chat.copy"))
        copyBtn.contentTintColor = Theme.fgDim; copyBtn.toolTip = t("chat.copy")
        copyBtn.target = self; copyBtn.action = #selector(copyAnswer); copyBtn.isHidden = true
        statusRow.orientation = .horizontal; statusRow.spacing = 6; statusRow.alignment = .centerY
        statusRow.translatesAutoresizingMaskIntoConstraints = false
        statusRow.addArrangedSubview(spinner); statusRow.addArrangedSubview(statusIcon)
        statusRow.addArrangedSubview(statusLabel); statusRow.addArrangedSubview(copyBtn)
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 12), spinner.heightAnchor.constraint(equalToConstant: 12),
            statusIcon.widthAnchor.constraint(equalToConstant: 13), statusIcon.heightAnchor.constraint(equalToConstant: 13),
        ])
        content.addArrangedSubview(statusRow)   // 항상 첫 줄 - 답변은 그 아래로 붙는다
        statusRow.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true

        addSubview(card)
        NSLayoutConstraint.activate([
            card.topAnchor.constraint(equalTo: topAnchor),
            card.leadingAnchor.constraint(equalTo: leadingAnchor),
            card.trailingAnchor.constraint(equalTo: trailingAnchor),
            card.bottomAnchor.constraint(equalTo: bottomAnchor),
            content.topAnchor.constraint(equalTo: card.topAnchor),
            content.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    private var phase = t("chat.thinking")
    var isWaiting: Bool { waiting }
    func startWorking() { phase = t("chat.thinking"); spinner.startAnimation(nil); statusLabel.stringValue = phase + "…" }
    func setPhase(_ p: String) { guard !finished, !waiting else { return }; phase = p }
    private var lastShown = ""
    func tick(_ secs: Int) {
        lastSecs = secs
        guard !finished, !waiting else { return }
        let est = ChatText.estimateTokens(plainText)
        var s = phase + "… " + ChatText.duration(secs)
        if est > 0 { s += " · ↓\(ChatText.tokens(est))" }   // CLI 처럼 출력 토큰이 올라가는 게 보인다
        guard s != lastShown else { return }
        lastShown = s; statusLabel.stringValue = s
    }
    // 승인/선택 대기: 진행 표시를 멈추고 대기 문구를 보인다.
    func setWaiting(_ w: Bool) {
        guard !finished else { return }
        waiting = w
        if w {
            spinner.stopAnimation(nil)
            statusIcon.isHidden = false; statusIcon.image = symbol("hand.raised.fill", Theme.warning)
            statusLabel.stringValue = t("chat.awaitingApproval"); statusLabel.textColor = Theme.warning
        } else {
            statusIcon.isHidden = true; statusLabel.textColor = Theme.accent2; lastShown = ""
            spinner.startAnimation(nil)
        }
    }
    private func symbol(_ name: String, _ color: NSColor) -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: UIScale.pt(12), weight: .semibold).applying(.init(paletteColors: [color]))
        return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
    }
    @objc private func copyAnswer() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(plainText, forType: .string)
        copyBtn.image = symbol("checkmark", Theme.success)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { [weak self] in
            self?.copyBtn.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
            self?.copyBtn.contentTintColor = Theme.fgDim
        }
    }
    /// 완료 footer 의 상대시간(방금/N분 전)을 갱신 (팬의 주기 타이머가 호출).
    func refreshTime() {
        guard finished, let at = finishedAt else { return }
        statusLabel.stringValue = doneBase + " · " + ChatText.relative(at)
    }

    private weak var activeTool: ToolLine?   // the tool line currently in progress (shimmering)
    private func stopActiveTool() { activeTool?.stopShimmer(); activeTool = nil }

    private(set) var plainText = ""          // 타임라인 노드 복사용 (이 턴의 어시스턴트 텍스트)
    func bufferText(_ t: String) {
        if !hasText { hasText = true; thinkingSecs = lastSecs }
        plainText += t
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
        // full gap - the CLI's rhythm.
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
                     options: [(String, () -> Void)], custom: ((String) -> Void)? = nil) -> ApprovalCard {
        closeText()
        // 바로 위에 같은 명령을 보여 준 도구 줄이 있으면 그걸 걷는다. 카드가 같은 내용을
        // 다시 담고 있어서, 화면에는 같은 명령이 두 번·"에디터에서 보기" 버튼도 두 번 나왔다.
        if let code, !code.isEmpty { dropDuplicateToolBlock(code) }
        let card = ApprovalCard(title: title, detail: detail, code: code, path: path, options: options, custom: custom)
        add(card)
        return card
    }
    /// 방금 그린 도구 줄이 같은 코드를 담고 있으면 지운다 (승인 카드가 그 자리를 대신한다).
    private func dropDuplicateToolBlock(_ code: String) {
        let tail = content.arrangedSubviews.suffix(3)
        for v in tail where (v as? CodeCarrier)?.carriedCode == code {
            v.removeFromSuperview()
            if let line = content.arrangedSubviews.last as? ToolLine { line.removeFromSuperview() }
            return
        }
    }
    func finish(secs: Int, cost: Double?, usage: ChatUsage?, model: String?) {
        guard !finished else { return }
        closeText(); finished = true
        stopActiveTool()
        spinner.stopAnimation(nil)
        statusIcon.isHidden = false; statusIcon.image = symbol("checkmark.circle.fill", Theme.success)
        statusLabel.textColor = Theme.fgDim
        var s = t("chat.done") + " · " + ChatText.duration(secs)
        if let u = usage {
            s += " · ↑\(ChatText.tokens(u.input + u.cacheWrite)) ↓\(ChatText.tokens(u.output))"
        }
        doneBase = s
        finishedAt = Date()
        statusLabel.stringValue = doneBase + " · " + ChatText.relative(finishedAt!)
        copyBtn.isHidden = false
    }
    func setQuota(_ entries: [(label: String, value: Int)]) {}   // 완료 줄에 플랜 사용량은 안 붙인다 (호환용 no-op)
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
        // The pane must NOT demand horizontal width from its content - let text wrap instead of
        // growing the column (which was shrinking the conversation area).
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.defaultLow, for: .horizontal)

        // Quiet header strip: no filled bar - just a hairline under it (matches the open
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
        bar.addSubview(spinner); bar.addSubview(header)   // no ✕ - the dock panel provides close
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
    /// 도구가 돌고 난 출력. 길면 앞부분만 - 서브 팬은 진행을 보는 곳이지 로그 뷰어가 아니다.
    func addToolResult(_ text: String, isError: Bool) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let shown = t.count > 1200 ? String(t.prefix(1200)) + "\n…" : t
        let label = NSTextField(labelWithString: shown)
        label.font = UIScale.mono(UIScale.caption)
        label.textColor = isError ? Theme.danger : Theme.fgDim
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 12
        label.translatesAutoresizingMaskIntoConstraints = false
        add(label)
    }
    func finish(_ result: String) {
        guard !done else { return }
        done = true; spinner.stopAnimation(nil)
        header.attributedStringValue = SubagentPane.headerText(type: type, desc: t("chat.done"), running: false)
        // Show the sub-agent's FINAL answer - it arrives in the Agent tool_result and was being
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
    /// 줄 앞에 붙는 글자: 명령·스킬은 "/", 동료 호출은 "@". set() 전에 정한다.
    var prefix = "/"

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
            stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        ])
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError() }

    var count: Int { items.count }
    /// 벤치용: 지금 떠 있는 줄 이름들.
    func debugItems() -> [String] { items.map { $0.name } }
    func current() -> SlashCommand? { items.indices.contains(selected) ? items[selected] : nil }
    func move(_ d: Int) { guard !items.isEmpty else { return }; selected = (selected + d + items.count) % items.count; restyle(); scrollToSelected() }

    func set(_ list: [SlashCommand]) {
        items = list; selected = 0
        rows.forEach { $0.removeFromSuperview() }; rows = []
        for cmd in items {
            let row = NSView(); row.wantsLayer = true; row.layer?.cornerRadius = 5
            let name = NSTextField(labelWithString: prefix + cmd.name)
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

// MARK: - plan badge
//
// Claude Code's plan mode writes the approved plan to ~/.claude/plans/<slug>.md and then keeps the
// plan's title pinned in the corner while it works through the tasks. riven mirrors that: a small
// bordered chip that overlaps the top-right of the conversation, naming the plan and opening the
// markdown file in the editor when clicked.
final class PlanBadge: NSView, Themable, Scalable {
    var onOpen: (() -> Void)?
    private let icon = NSTextField(labelWithString: "◳")
    private let label = NSTextField(labelWithString: "")
    private let file = NSTextField(labelWithString: "")
    private var hot = false
    private var track: NSTrackingArea?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        [icon, label, file].forEach { $0.translatesAutoresizingMaskIntoConstraints = false; addSubview($0) }
        let pad = UIScale.pt(9)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: pad),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: UIScale.pt(6)),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            file.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: UIScale.pt(8)),
            file.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -pad),
            file.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: UIScale.pt(26)),
        ])
        applyTheme(); applyScale()
        Theme.register(self); UIScale.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(title: String, file name: String) {
        label.stringValue = title
        file.stringValue = name
        toolTip = t("chat.plan.tip", ["f": name])
        isHidden = false
        applyTheme()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = track { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInKeyWindow], owner: self)
        addTrackingArea(t); track = t
    }
    override func hitTest(_ p: NSPoint) -> NSView? { bounds.contains(convert(p, from: superview)) ? self : nil }
    override func mouseEntered(with e: NSEvent) { hot = true; applyTheme(); NSCursor.pointingHand.set() }
    override func mouseExited(with e: NSEvent) { hot = false; applyTheme(); NSCursor.arrow.set() }
    override func mouseDown(with e: NSEvent) { onOpen?() }

    func applyTheme() {
        layer?.cornerRadius = UIScale.pt(13)
        layer?.borderWidth = 1
        layer?.borderColor = (hot ? Theme.accent : Theme.accent.withAlphaComponent(0.55)).cgColor
        // 대화 위에 겹쳐 뜨므로 불투명한 표면이어야 글이 비쳐 보이지 않는다.
        layer?.backgroundColor = Theme.bg2.cgColor
        icon.textColor = Theme.accent
        label.textColor = Theme.fg
        file.textColor = Theme.fgDim
    }
    func applyScale() {
        icon.font = UIScale.font(UIScale.caption, .semibold)
        label.font = UIScale.font(UIScale.caption, .semibold)
        file.font = UIScale.font(UIScale.caption)
    }
}
