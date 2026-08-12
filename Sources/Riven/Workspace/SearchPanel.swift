import AppKit

// Find-in-files sidebar panel - a native port of riven's SearchPanel.tsx.
// Query + replace fields, results grouped by file, click a match to open the
// file at that line. Lives in the sidebar's lower region (native has no
// dockview grid, so search swaps in where the explorer sits).
final class SearchPanel: NSView, Themable, Scalable {
    private let titleLabel = NSTextField(labelWithString: "")
    private let replaceBtn = NSButton()
    private let queryField = NSTextField()
    private let replaceField = NSTextField()
    private let summary = NSTextField(labelWithString: "")
    private let resultsStack = FlippedStack()
    private let scroll = NSScrollView()
    private let caseBtn = NSButton()     // Aa  대소문자 구분
    private let wordBtn = NSButton()     // W   단어 단위
    private let regexBtn = NSButton()    // .*  정규식
    private weak var queryBox: NSView?   // 검색 입력 상자(둥근 테두리) - 테마 갱신용
    private weak var replaceBox: NSView?
    private var root: URL?

    private var searchOptions: Search.Options {
        .init(caseSensitive: caseBtn.state == .on, wholeWord: wordBtn.state == .on, regex: regexBtn.state == .on)
    }

    // (filePath, line, column) - 1-based, to open + reveal in the editor.
    var onOpen: ((String, Int, Int) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        let title = titleLabel
        title.stringValue = t("title.search")
        title.font = UIScale.font(UIScale.small, .medium)
        title.textColor = Theme.fgDim
        title.translatesAutoresizingMaskIntoConstraints = false

        styleField(queryField, placeholder: t("search.placeholder"))
        queryField.target = self; queryField.action = #selector(runSearch)
        styleField(replaceField, placeholder: t("search.replacePlaceholder"))
        replaceField.target = self; replaceField.action = #selector(runReplace)

        // 모두 교체: 치환 상자 안 오른쪽의 컴팩트 플랫 버튼.
        replaceBtn.target = self; replaceBtn.action = #selector(runReplace)
        replaceBtn.isBordered = false
        replaceBtn.translatesAutoresizingMaskIntoConstraints = false
        replaceBtn.setContentHuggingPriority(.required, for: .horizontal)
        styleReplaceBtn()

        // VSCode 처럼 검색 상자 오른쪽에 대소문자(Aa) · 단어 단위(W) · 정규식(.*) 플랫 토글.
        func toggle(_ b: NSButton, _ label: String, _ tip: String) {
            b.title = label
            b.setButtonType(.pushOnPushOff)
            b.isBordered = false
            b.toolTip = tip
            b.target = self; b.action = #selector(toggleChanged)
            b.translatesAutoresizingMaskIntoConstraints = false
            b.setContentHuggingPriority(.required, for: .horizontal)
            b.widthAnchor.constraint(equalToConstant: UIScale.pt(24)).isActive = true
            b.heightAnchor.constraint(equalToConstant: UIScale.pt(22)).isActive = true
            styleToggle(b)
        }
        toggle(caseBtn, "Aa", t("search.caseTip"))
        toggle(wordBtn, "W", t("search.wordTip"))
        toggle(regexBtn, ".*", t("search.regexTip"))
        let toggles = NSStackView(views: [caseBtn, wordBtn, regexBtn])
        toggles.orientation = .horizontal; toggles.spacing = 3; toggles.alignment = .centerY
        toggles.translatesAutoresizingMaskIntoConstraints = false

        // 입력 상자: 둥근 테두리 + 좌우 패딩. 오른쪽 액세서리(토글 / 모두 교체)를 상자 '안'에
        // 둬서 두 상자의 폭이 정확히 같다 (예전엔 토글·버튼이 상자 밖에 붙어 위아래 폭이 달랐다).
        let qBox = makeFieldBox(queryField, accessory: toggles)
        let rBox = makeFieldBox(replaceField, accessory: replaceBtn)
        queryBox = qBox; replaceBox = rBox

        summary.font = UIScale.font(UIScale.caption); summary.textColor = Theme.fgDim
        summary.translatesAutoresizingMaskIntoConstraints = false

        resultsStack.orientation = .vertical
        resultsStack.spacing = 0
        resultsStack.alignment = .leading
        resultsStack.translatesAutoresizingMaskIntoConstraints = false

        scroll.documentView = resultsStack
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        addSubview(title); addSubview(qBox); addSubview(rBox); addSubview(summary); addSubview(scroll)
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            title.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            // 두 상자: 같은 좌우 여백 = 같은 폭.
            qBox.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            qBox.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            qBox.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            rBox.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            rBox.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            rBox.topAnchor.constraint(equalTo: qBox.bottomAnchor, constant: 6),
            summary.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            summary.topAnchor.constraint(equalTo: rBox.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: summary.bottomAnchor, constant: 4),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            resultsStack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            resultsStack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            resultsStack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        ])
        Theme.register(self); UIScale.register(self)
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.titleLabel.stringValue = t("title.search")
            self?.styleReplaceBtn()
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
        styleField(queryField, placeholder: t("search.placeholder"))
        styleField(replaceField, placeholder: t("search.replacePlaceholder"))
        styleBox(queryBox); styleBox(replaceBox)
        styleReplaceBtn()
        [caseBtn, wordBtn, regexBtn].forEach { styleToggle($0) }
        summary.textColor = Theme.fgDim
        renderResults(lastResult)   // recolor existing rows
    }
    func applyScale() {
        titleLabel.font = UIScale.font(UIScale.small, .medium)
        queryField.font = UIScale.font(UIScale.body); replaceField.font = UIScale.font(UIScale.body)
        styleReplaceBtn(); summary.font = UIScale.font(UIScale.caption)
        renderResults(lastResult)   // rebuild result rows at the new scale
    }

    /// 필드 자체는 투명·테두리 없음 (둥근 테두리·배경은 감싸는 상자가 그린다). 텍스트가 상자
    /// 가장자리에 붙지 않게 상자 쪽에서 좌측 패딩을 준다. PaddedFieldCell 은 안 쓴다 - 레이아웃
    /// 전(0x0)에 focusQuery 로 포커스하면 그 셀의 select 가 지오메트리 검증에서 크래시했다.
    private func styleField(_ tf: NSTextField, placeholder: String) {
        tf.placeholderString = placeholder
        tf.font = UIScale.font(UIScale.body)
        tf.textColor = Theme.fg
        tf.drawsBackground = false
        tf.isBordered = false
        tf.focusRingType = .none
        tf.lineBreakMode = .byTruncatingTail
        tf.translatesAutoresizingMaskIntoConstraints = false
    }
    /// 입력 필드를 둥근 테두리 상자로 감싼다. 오른쪽 액세서리(토글/버튼)를 상자 안에 두고,
    /// 텍스트엔 좌측 패딩(9pt)을 준다. 상자를 쓰는 두 입력칸은 좌우 여백이 같아 폭이 딱 맞는다.
    private func makeFieldBox(_ field: NSTextField, accessory: NSView) -> NSView {
        let box = NSView()
        box.wantsLayer = true
        box.layer?.cornerRadius = 6
        box.layer?.borderWidth = 1
        box.translatesAutoresizingMaskIntoConstraints = false
        accessory.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(field); box.addSubview(accessory)
        NSLayoutConstraint.activate([
            box.heightAnchor.constraint(equalToConstant: UIScale.pt(30)),
            field.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 9),   // 좌측 패딩
            field.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            field.trailingAnchor.constraint(equalTo: accessory.leadingAnchor, constant: -6),
            accessory.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -6),
            accessory.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        ])
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        styleBox(box)
        return box
    }
    private func styleReplaceBtn() {
        replaceBtn.attributedTitle = NSAttributedString(string: t("search.replaceAll"), attributes: [
            .foregroundColor: Theme.accent, .font: UIScale.font(UIScale.caption, .medium)])
    }
    private func styleBox(_ box: NSView?) {
        box?.layer?.borderColor = Theme.edge.cgColor
        box?.layer?.backgroundColor = (Theme.isLight ? Theme.bg : Theme.bg3).cgColor
    }
    /// 플랫 토글(Aa/W/.*): 켜지면 액센트 배경+글자, 꺼지면 흐릿. 투박한 맥 버튼 대신.
    private func styleToggle(_ b: NSButton) {
        let on = b.state == .on
        b.wantsLayer = true
        b.layer?.cornerRadius = 5
        b.layer?.backgroundColor = (on ? Theme.accent.withAlphaComponent(0.22) : NSColor.clear).cgColor
        b.attributedTitle = NSAttributedString(string: b.title, attributes: [
            .foregroundColor: on ? Theme.accent : Theme.fgDim,
            .font: UIScale.mono(UIScale.caption, .semibold)])
    }

    private var lastResult: Search.Result?

    @objc private func toggleChanged() {
        [caseBtn, wordBtn, regexBtn].forEach { styleToggle($0) }
        runSearch()
    }

    @objc private func runSearch() {
        guard let root else { return }
        let q = queryField.stringValue
        if q.trimmingCharacters(in: .whitespaces).isEmpty { lastResult = nil; renderResults(nil); summary.stringValue = ""; return }
        summary.stringValue = t("search.searching")
        let opts = searchOptions
        DispatchQueue.global(qos: .userInitiated).async {
            let res = Search.inFiles(root: root, query: q, options: opts)
            DispatchQueue.main.async {
                self.lastResult = res
                self.renderResults(res)
                let fileCount = Set(res.matches.map { $0.file }).count
                self.summary.stringValue = res.matches.isEmpty ? t("search.noResults")
                    : t("search.summary", ["n": "\(res.matches.count)\(res.truncated ? "+" : "")", "files": fileCount])
            }
        }
    }

    @objc private func runReplace() {
        guard root != nil else { return }
        let q = queryField.stringValue
        if q.isEmpty || (lastResult?.matches.isEmpty ?? true) { return }
        let fileCount = Set(lastResult?.matches.map { $0.file } ?? []).count
        let alert = NSAlert()
        alert.messageText = t("search.replaceConfirm", ["q": q, "files": fileCount])
        alert.informativeText = t("search.replaceBody")
        alert.addButton(withTitle: t("search.replace")); alert.addButton(withTitle: t("common.cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let repl = replaceField.stringValue
        let opts = searchOptions
        // 검색으로 실제 매치된 파일에만 치환한다 - .build 같은 무시 대상은 절대 안 건드린다.
        let files = Array(Set(lastResult?.matches.map { $0.file } ?? []))
        summary.stringValue = t("search.replacing")
        DispatchQueue.global(qos: .userInitiated).async {
            let r = Search.replaceInFiles(files: files, query: q, replacement: repl, options: opts)
            DispatchQueue.main.async {
                self.summary.stringValue = t("search.replaceDone", ["n": r.replacements, "files": r.files])
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
        l.font = UIScale.font(UIScale.small, .medium)
        l.textColor = Theme.fgDim
        l.lineBreakMode = .byTruncatingMiddle
        l.toolTip = file
        let pad = PaddedRow(l, left: 10, top: 6, bottom: 2)
        return pad
    }

    private func matchRow(_ m: Search.Match) -> NSView {
        let l = NSTextField(labelWithString: "")
        l.font = UIScale.mono(UIScale.small, .regular)
        l.lineBreakMode = .byTruncatingTail
        let attr = NSMutableAttributedString()
        attr.append(NSAttributedString(string: "\(m.line)  ",
            attributes: [.foregroundColor: Theme.fgDim, .font: UIScale.mono(UIScale.caption, .regular)]))
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
