import AppKit

// The Changes timeline — a native port of riven's ChangesPanel.tsx. Lists files
// an agent edited this session with +added/−removed counts; accept (keep) or
// revert (restore pre-edit content) per file or in bulk. Click a row to open the
// file with its changed lines highlighted. Driven by [[AgentEdits]].
final class ChangesPanel: NSView, Themable {
    private let titleLabel = NSTextField(labelWithString: t("title.changes"))
    private let acceptAllBtn = NSButton(title: t("changes.acceptAll"), target: nil, action: nil)
    private let revertAllBtn = NSButton(title: t("changes.revertAll"), target: nil, action: nil)
    private let rowsStack = FlippedStack()
    private let scroll = NSScrollView()
    private var workspace: URL?

    // (path) — open the file and highlight its agent-changed lines.
    var onOpen: ((String) -> Void)?
    // (path) — a file was reverted; reload it if open in the editor.
    var onReverted: ((String) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        titleLabel.font = .systemFont(ofSize: 11, weight: .medium)
        titleLabel.textColor = Theme.fg
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        for (b, sel) in [(acceptAllBtn, #selector(acceptAll)), (revertAllBtn, #selector(revertAll))] {
            b.target = self; b.action = sel
            b.isBordered = false; b.font = .systemFont(ofSize: 10)
            b.translatesAutoresizingMaskIntoConstraints = false
        }
        acceptAllBtn.contentTintColor = Theme.success
        revertAllBtn.contentTintColor = Theme.fgDim
        let headActions = NSStackView(views: [acceptAllBtn, revertAllBtn])
        headActions.orientation = .horizontal; headActions.spacing = 8
        headActions.translatesAutoresizingMaskIntoConstraints = false

        rowsStack.orientation = .vertical; rowsStack.spacing = 0; rowsStack.alignment = .leading
        rowsStack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = rowsStack
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        addSubview(titleLabel); addSubview(headActions); addSubview(scroll)
        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            titleLabel.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            headActions.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            headActions.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 8),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            rowsStack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            rowsStack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            rowsStack.widthAnchor.constraint(equalTo: scroll.widthAnchor)
        ])
        editsToken = AgentEdits.shared.observe { [weak self] in DispatchQueue.main.async { self?.refresh() } }
        Theme.register(self)
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.acceptAllBtn.title = t("changes.acceptAll")
            self?.revertAllBtn.title = t("changes.revertAll")
            self?.refresh()
        }
        render()
    }
    required init?(coder: NSCoder) { fatalError() }

    // Without teardown these observers leaked one token per panel creation, and the
    // NotificationCenter token kept firing (self nil) after the panel went away (#64).
    private var langObserver: NSObjectProtocol?
    private var editsToken: Int?
    deinit {
        if let o = langObserver { NotificationCenter.default.removeObserver(o) }
        if let t = editsToken { AgentEdits.shared.removeObserver(t) }
    }

    private var entries: [AgentEdits.Entry] = []

    func setWorkspace(_ url: URL) { workspace = url; refresh() }

    // The Changes panel shows what the AGENT edited this session (before/after from the
    // session baseline) — riven's agentEdits.timeline, NOT git working-tree status.
    func refresh() {
        guard let ws = workspace else { entries = []; render(); return }
        entries = AgentEdits.shared.timeline.filter { $0.workspace == ws.path }.reversed()  // newest first
        render()
    }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        titleLabel.textColor = Theme.fg
        acceptAllBtn.contentTintColor = Theme.success
        revertAllBtn.contentTintColor = Theme.fgDim
        render()
    }

    // 모두 수락: keep the agent's files, clear the list. 모두 되돌리기: restore every
    // file's pre-edit content.
    @objc private func acceptAll() { AgentEdits.shared.acceptAll(); refresh() }
    @objc private func revertAll() {
        let a = NSAlert()
        a.messageText = "에이전트 변경을 모두 되돌리시겠습니까?"
        a.informativeText = "이 세션에서 에이전트가 편집한 내용이 편집 전 상태로 복원됩니다."
        a.addButton(withTitle: "되돌리기"); a.addButton(withTitle: "취소"); a.alertStyle = .warning
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let reverted = AgentEdits.shared.revertAll()
        reverted.forEach { onReverted?($0) }
        refresh()
    }

    private func render() {
        titleLabel.stringValue = t("title.changes") + (entries.isEmpty ? "" : " (\(entries.count))")
        acceptAllBtn.isHidden = entries.isEmpty
        revertAllBtn.isHidden = entries.isEmpty
        rowsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if entries.isEmpty {
            let hint = NSTextField(labelWithString: t("changes.empty2"))
            hint.font = .systemFont(ofSize: 11); hint.textColor = Theme.fgDim
            let c = NSView(); hint.translatesAutoresizingMaskIntoConstraints = false; c.addSubview(hint)
            NSLayoutConstraint.activate([
                hint.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
                hint.topAnchor.constraint(equalTo: c.topAnchor, constant: 10),
                hint.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -10)])
            rowsStack.addArrangedSubview(c)
            return
        }
        for e in entries { rowsStack.addArrangedSubview(editRow(e)) }
    }

    private func ago(_ date: Date) -> String {
        let s = Int(-date.timeIntervalSinceNow)
        if s < 5 { return "now" }
        if s < 60 { return "\(s)초" }
        if s < 3600 { return "\(s/60)분" }
        if s < 86400 { return "\(s/3600)시간" }
        return "\(s/86400)일"
    }

    private func editRow(_ e: AgentEdits.Entry) -> NSView {
        let name = (e.path as NSString).lastPathComponent
        let rel = e.path.hasPrefix(e.workspace + "/") ? String(e.path.dropFirst(e.workspace.count + 1)) : e.path
        let dir = (rel as NSString).deletingLastPathComponent

        let ico = NSTextField(labelWithString: e.isNew ? "✚" : "✎")
        ico.font = .systemFont(ofSize: 11); ico.textColor = e.isNew ? Theme.gitAdded : Theme.gitModified
        ico.translatesAutoresizingMaskIntoConstraints = false

        let nameL = NSTextField(labelWithString: name)
        nameL.font = .systemFont(ofSize: 11); nameL.textColor = Theme.fg
        nameL.lineBreakMode = .byTruncatingMiddle; nameL.toolTip = e.path
        nameL.translatesAutoresizingMaskIntoConstraints = false
        let dirL = NSTextField(labelWithString: dir)
        dirL.font = .systemFont(ofSize: 10); dirL.textColor = Theme.fgDim
        dirL.lineBreakMode = .byTruncatingMiddle
        dirL.translatesAutoresizingMaskIntoConstraints = false

        let statsStr = NSMutableAttributedString()
        if e.added > 0 { statsStr.append(NSAttributedString(string: "+\(e.added) ", attributes: [.foregroundColor: Theme.gitAdded, .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)])) }
        if e.removed > 0 { statsStr.append(NSAttributedString(string: "−\(e.removed)", attributes: [.foregroundColor: Theme.gitDeleted, .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular)])) }
        let stats = NSTextField(labelWithString: ""); stats.attributedStringValue = statsStr
        stats.translatesAutoresizingMaskIntoConstraints = false
        let time = NSTextField(labelWithString: ago(e.at))
        time.font = .systemFont(ofSize: 10); time.textColor = Theme.fgDim
        time.translatesAutoresizingMaskIntoConstraints = false

        let row = ChangesRowView()
        row.onClick = { [weak self] in self?.onOpen?(e.path) }   // open with before/after diff
        row.addSubview(ico); row.addSubview(nameL); row.addSubview(dirL); row.addSubview(stats); row.addSubview(time)

        let revert = ChangesButton(title: "↺") { [weak self] in
            if AgentEdits.shared.revert(path: e.path) { self?.onReverted?(e.path) }
            self?.refresh()
        }
        revert.font = .systemFont(ofSize: 12); revert.contentTintColor = Theme.warning
        revert.isBordered = false; revert.translatesAutoresizingMaskIntoConstraints = false
        let accept = ChangesButton(title: "✓") { [weak self] in AgentEdits.shared.resolve(path: e.path); self?.refresh() }
        accept.font = .systemFont(ofSize: 12); accept.contentTintColor = Theme.success
        accept.isBordered = false; accept.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(revert); row.addSubview(accept)

        NSLayoutConstraint.activate([
            ico.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
            ico.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            nameL.leadingAnchor.constraint(equalTo: ico.trailingAnchor, constant: 6),
            nameL.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            dirL.leadingAnchor.constraint(equalTo: nameL.trailingAnchor, constant: 6),
            dirL.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            accept.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -8),
            accept.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            accept.widthAnchor.constraint(equalToConstant: 16),
            revert.trailingAnchor.constraint(equalTo: accept.leadingAnchor, constant: -6),
            revert.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            revert.widthAnchor.constraint(equalToConstant: 16),
            time.trailingAnchor.constraint(equalTo: revert.leadingAnchor, constant: -8),
            time.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            stats.trailingAnchor.constraint(equalTo: time.leadingAnchor, constant: -8),
            stats.leadingAnchor.constraint(greaterThanOrEqualTo: dirL.trailingAnchor, constant: 6),
            stats.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            row.heightAnchor.constraint(equalToConstant: 26)
        ])
        return row
    }
}

// A stage/unstage checkbox for a changed file.
private final class ChangesCheck: NSButton {
    private let handler: (Bool) -> Void
    init(staged: Bool, handler: @escaping (Bool) -> Void) {
        self.handler = handler
        super.init(frame: .zero)
        setButtonType(.switch); title = ""; state = staged ? .on : .off
        target = self; action = #selector(fire)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func fire() { handler(state == .on) }
}

private final class ChangesRowView: NSView {
    var onClick: (() -> Void)?
    private var tracking: NSTrackingArea?
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
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

private final class ChangesButton: NSButton {
    private let handler: () -> Void
    init(title: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(frame: .zero)
        self.title = title; self.target = self; self.action = #selector(fire)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func fire() { handler() }
}
