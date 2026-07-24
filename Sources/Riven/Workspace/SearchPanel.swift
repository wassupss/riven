import AppKit

// Find-in-files sidebar panel — a native port of riven's SearchPanel.tsx.
// Query + replace fields, results grouped by file, click a match to open the
// file at that line. Lives in the sidebar's lower region (native has no
// dockview grid, so search swaps in where the explorer sits).
final class SearchPanel: NSView, Themable {
    private let titleLabel = NSTextField(labelWithString: "")
    private let replaceBtn = NSButton()
    private let queryField = NSTextField()
    private let replaceField = NSTextField()
    private let summary = NSTextField(labelWithString: "")
    private let resultsStack = FlippedStack()
    private let scroll = NSScrollView()
    private var root: URL?

    // (filePath, line, column) — 1-based, to open + reveal in the editor.
    var onOpen: ((String, Int, Int) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        let title = titleLabel
        title.stringValue = t("title.search")
        title.font = .systemFont(ofSize: 11, weight: .medium)
        title.textColor = Theme.fgDim
        title.translatesAutoresizingMaskIntoConstraints = false

        style(queryField, placeholder: t("search.placeholder"))
        queryField.target = self; queryField.action = #selector(runSearch)
        style(replaceField, placeholder: t("search.replacePlaceholder"))
        replaceField.target = self; replaceField.action = #selector(runReplace)

        replaceBtn.title = t("search.replaceAll")
        replaceBtn.target = self; replaceBtn.action = #selector(runReplace)
        replaceBtn.bezelStyle = .roundRect; replaceBtn.font = .systemFont(ofSize: 11)
        replaceBtn.controlSize = .small; replaceBtn.translatesAutoresizingMaskIntoConstraints = false

        summary.font = .systemFont(ofSize: 10); summary.textColor = Theme.fgDim
        summary.translatesAutoresizingMaskIntoConstraints = false

        resultsStack.orientation = .vertical
        resultsStack.spacing = 0
        resultsStack.alignment = .leading
        resultsStack.translatesAutoresizingMaskIntoConstraints = false

        scroll.documentView = resultsStack
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        addSubview(title); addSubview(queryField); addSubview(replaceField)
        addSubview(replaceBtn); addSubview(summary); addSubview(scroll)
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            title.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            queryField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            queryField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            queryField.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            replaceField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            replaceField.trailingAnchor.constraint(equalTo: replaceBtn.leadingAnchor, constant: -6),
            replaceField.topAnchor.constraint(equalTo: queryField.bottomAnchor, constant: 6),
            replaceBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            replaceBtn.centerYAnchor.constraint(equalTo: replaceField.centerYAnchor),
            summary.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            summary.topAnchor.constraint(equalTo: replaceField.bottomAnchor, constant: 6),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: summary.bottomAnchor, constant: 4),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            resultsStack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            resultsStack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            resultsStack.widthAnchor.constraint(equalTo: scroll.widthAnchor)
        ])
        Theme.register(self)
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.titleLabel.stringValue = t("title.search")
            self?.replaceBtn.title = t("search.replaceAll")
            self?.queryField.placeholderString = t("search.placeholder")
            self?.replaceField.placeholderString = t("search.replacePlaceholder")
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    // Store + remove the observer token so it doesn't leak per recreation (#64).
    private var langObserver: NSObjectProtocol?
    deinit { if let o = langObserver { NotificationCenter.default.removeObserver(o) } }

    func setRoot(_ url: URL) { root = url }
    func focusQuery() { window?.makeFirstResponder(queryField) }
    // DEBUG: run a query programmatically (RIVEN_QUERY) so results render for capture.
    func debugSearch(_ q: String) { queryField.stringValue = q; runSearch() }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        style(queryField, placeholder: t("search.placeholder"))
        style(replaceField, placeholder: t("search.replacePlaceholder"))
        summary.textColor = Theme.fgDim
        renderResults(lastResult)   // recolor existing rows
    }

    private func style(_ tf: NSTextField, placeholder: String) {
        tf.placeholderString = placeholder
        tf.font = .systemFont(ofSize: 12)
        tf.textColor = Theme.fg
        tf.backgroundColor = Theme.bg3
        tf.isBordered = false
        tf.bezelStyle = .roundedBezel
        tf.translatesAutoresizingMaskIntoConstraints = false
        tf.heightAnchor.constraint(equalToConstant: 24).isActive = true
    }

    private var lastResult: Search.Result?

    @objc private func runSearch() {
        guard let root else { return }
        let q = queryField.stringValue
        if q.trimmingCharacters(in: .whitespaces).isEmpty { lastResult = nil; renderResults(nil); summary.stringValue = ""; return }
        summary.stringValue = t("search.searching")
        DispatchQueue.global(qos: .userInitiated).async {
            let res = Search.inFiles(root: root, query: q)
            DispatchQueue.main.async {
                self.lastResult = res
                self.renderResults(res)
                let fileCount = Set(res.matches.map { $0.file }).count
                self.summary.stringValue = res.matches.isEmpty ? t("search.noResults")
                    : "\(res.matches.count)개\(res.truncated ? "+" : "") · \(fileCount)개 파일"
            }
        }
    }

    @objc private func runReplace() {
        guard let root, !replaceField.stringValue.isEmpty || replaceField.stringValue == "" else { return }
        let q = queryField.stringValue
        if q.isEmpty || (lastResult?.matches.isEmpty ?? true) { return }
        let fileCount = Set(lastResult?.matches.map { $0.file } ?? []).count
        let alert = NSAlert()
        alert.messageText = "\"\(q)\"을(를) \(fileCount)개 파일에서 바꿀까요?"
        alert.informativeText = "디스크에 즉시 기록되며 되돌리기 어렵습니다."
        alert.addButton(withTitle: "바꾸기"); alert.addButton(withTitle: "취소")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let repl = replaceField.stringValue
        summary.stringValue = "바꾸는 중…"
        DispatchQueue.global(qos: .userInitiated).async {
            let r = Search.replaceInFiles(root: root, query: q, replacement: repl)
            DispatchQueue.main.async {
                self.summary.stringValue = "\(r.replacements)곳 · \(r.files)개 파일 변경됨"
                self.runSearch()
            }
        }
    }

    private func renderResults(_ res: Search.Result?) {
        resultsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard let res, let root else { return }
        // Group matches by file, preserving encounter order.
        var order: [String] = []
        var groups: [String: [Search.Match]] = [:]
        for m in res.matches {
            if groups[m.file] == nil { order.append(m.file) }
            groups[m.file, default: []].append(m)
        }
        for file in order {
            resultsStack.addArrangedSubview(fileHeader(file, root: root))
            for m in groups[file]! { resultsStack.addArrangedSubview(matchRow(m)) }
        }
    }

    private func fileHeader(_ file: String, root: URL) -> NSView {
        let rel = file.hasPrefix(root.path) ? String(file.dropFirst(root.path.count + 1)) : file
        let l = NSTextField(labelWithString: rel)
        l.font = .systemFont(ofSize: 11, weight: .medium)
        l.textColor = Theme.fgDim
        l.lineBreakMode = .byTruncatingMiddle
        l.toolTip = file
        let pad = PaddedRow(l, left: 10, top: 6, bottom: 2)
        return pad
    }

    private func matchRow(_ m: Search.Match) -> NSView {
        let l = NSTextField(labelWithString: "")
        l.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        l.lineBreakMode = .byTruncatingTail
        let attr = NSMutableAttributedString()
        attr.append(NSAttributedString(string: "\(m.line)  ",
            attributes: [.foregroundColor: Theme.fgDim, .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)]))
        let text = m.text
        let chars = Array(text)
        let start = max(0, min(m.matchStart, chars.count))
        let end = max(start, min(m.matchStart + m.matchLength, chars.count))
        let pre = String(chars[0..<start]), hit = String(chars[start..<end]), post = String(chars[end...] as ArraySlice)
        attr.append(NSAttributedString(string: pre, attributes: [.foregroundColor: Theme.fg]))
        attr.append(NSAttributedString(string: hit, attributes: [.foregroundColor: Theme.accent,
            .backgroundColor: Theme.accent.withAlphaComponent(0.18)]))
        attr.append(NSAttributedString(string: post, attributes: [.foregroundColor: Theme.fg]))
        l.attributedStringValue = attr
        let row = MatchRowView(m, l)
        row.onClick = { [weak self] in self?.onOpen?(m.file, m.line, m.column) }
        return row
    }
}

// A left-padded single-view row.
private final class PaddedRow: NSView {
    init(_ view: NSView, left: CGFloat, top: CGFloat, bottom: CGFloat) {
        super.init(frame: .zero)
        view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: leadingAnchor, constant: left),
            view.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -6),
            view.topAnchor.constraint(equalTo: topAnchor, constant: top),
            view.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -bottom)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
}

// A clickable match row with hover highlight.
private final class MatchRowView: NSView {
    var onClick: (() -> Void)?
    private var tracking: NSTrackingArea?
    init(_ m: Search.Match, _ label: NSTextField) {
        super.init(frame: .zero)
        wantsLayer = true
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 22),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -6),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2)
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(t); tracking = t
    }
    override func mouseEntered(with e: NSEvent) { layer?.backgroundColor = Theme.bg3.cgColor }
    override func mouseExited(with e: NSEvent) { layer?.backgroundColor = NSColor.clear.cgColor }
    override func mouseDown(with e: NSEvent) { onClick?() }
}
