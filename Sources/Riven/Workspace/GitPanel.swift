import AppKit

// Source-control sidebar panel — a native port of riven's GitPanel.tsx. Branch
// header with ahead/behind + pull/push/refresh, a commit box, and staged/changed
// sections whose rows stage/unstage/discard. Click a file to open it with its
// changed lines highlighted. Lives in the sidebar (native has no dockview grid).
final class GitPanel: NSView, Themable, NSTextViewDelegate {
    private let branchLabel = NSTextField(labelWithString: "")
    private let branchIcon = NSImageView()
    private let commitMsg = NSTextView()
    private let commitPlaceholder = NSTextField(labelWithString: "")
    private let commitBtn = NSButton(title: "커밋", target: nil, action: nil)
    private let pullBtn = NSButton(title: "", target: nil, action: nil)
    private let pushBtn = NSButton(title: "", target: nil, action: nil)
    private let refreshBtn = NSButton(title: "", target: nil, action: nil)
    private let headActions = NSStackView()
    private let rowsStack = FlippedStack()
    private let scroll = NSScrollView()
    private let commitScroll = NSScrollView()
    private var root: URL?
    private var status = Git.GitStatus(branch: nil, isRepo: true, ahead: 0, behind: 0, hasUpstream: false, files: [])

    // (relPath) — open the file and show its diff against HEAD.
    var onOpenDiff: ((String) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = Theme.bg2.cgColor

        branchLabel.font = .systemFont(ofSize: 11, weight: .medium)
        branchLabel.textColor = Theme.fg
        branchLabel.lineBreakMode = .byTruncatingTail
        branchLabel.translatesAutoresizingMaskIntoConstraints = false

        for (b, sym, tip, sel) in [(pullBtn, "arrow.down", t("git.pull"), #selector(pull)), (pushBtn, "arrow.up", t("git.push"), #selector(push)), (refreshBtn, "arrow.clockwise", t("common.refresh"), #selector(refresh))] {
            b.image = NSImage(systemSymbolName: sym, accessibilityDescription: nil)
            b.image?.isTemplate = true
            b.imagePosition = .imageOnly
            b.symbolConfiguration = .init(pointSize: 12, weight: .regular)
            b.toolTip = tip
            b.target = self; b.action = sel
            b.isBordered = false
            b.contentTintColor = Theme.fgDim
            b.translatesAutoresizingMaskIntoConstraints = false
            b.widthAnchor.constraint(equalToConstant: 22).isActive = true
        }
        [pullBtn, pushBtn, refreshBtn].forEach { headActions.addArrangedSubview($0) }
        headActions.orientation = .horizontal; headActions.spacing = 2
        headActions.translatesAutoresizingMaskIntoConstraints = false

        // Commit message box (a small scrollable text view) with a placeholder overlay.
        commitMsg.font = .systemFont(ofSize: 12)
        commitMsg.isRichText = false
        commitMsg.drawsBackground = true
        commitMsg.textContainerInset = NSSize(width: 4, height: 4)
        commitMsg.delegate = self
        commitScroll.documentView = commitMsg
        commitScroll.hasVerticalScroller = true
        commitScroll.translatesAutoresizingMaskIntoConstraints = false
        commitScroll.borderType = .noBorder
        commitScroll.wantsLayer = true
        commitScroll.layer?.cornerRadius = 6
        commitScroll.layer?.borderWidth = 1
        commitPlaceholder.stringValue = t("git.commitMessage")
        commitPlaceholder.font = .systemFont(ofSize: 12)
        commitPlaceholder.textColor = Theme.fgDim
        commitPlaceholder.translatesAutoresizingMaskIntoConstraints = false

        commitBtn.target = self; commitBtn.action = #selector(commit)
        commitBtn.bezelStyle = .roundRect; commitBtn.controlSize = .small
        commitBtn.font = .systemFont(ofSize: 11, weight: .semibold)
        commitBtn.wantsLayer = true
        commitBtn.isBordered = false
        commitBtn.translatesAutoresizingMaskIntoConstraints = false

        rowsStack.orientation = .vertical; rowsStack.spacing = 0; rowsStack.alignment = .leading
        rowsStack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = rowsStack
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        branchIcon.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)
        branchIcon.symbolConfiguration = .init(pointSize: 12, weight: .regular)
        branchIcon.contentTintColor = Theme.fgDim
        branchIcon.translatesAutoresizingMaskIntoConstraints = false

        addSubview(branchIcon); addSubview(branchLabel); addSubview(headActions); addSubview(commitScroll)
        addSubview(commitPlaceholder); addSubview(commitBtn); addSubview(scroll)
        NSLayoutConstraint.activate([
            branchIcon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            branchIcon.centerYAnchor.constraint(equalTo: branchLabel.centerYAnchor),
            branchLabel.leadingAnchor.constraint(equalTo: branchIcon.trailingAnchor, constant: 5),
            branchLabel.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            branchLabel.trailingAnchor.constraint(lessThanOrEqualTo: headActions.leadingAnchor, constant: -6),
            commitPlaceholder.leadingAnchor.constraint(equalTo: commitScroll.leadingAnchor, constant: 6),
            commitPlaceholder.topAnchor.constraint(equalTo: commitScroll.topAnchor, constant: 5),
            headActions.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            headActions.centerYAnchor.constraint(equalTo: branchLabel.centerYAnchor),
            commitScroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            commitScroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            commitScroll.topAnchor.constraint(equalTo: branchLabel.bottomAnchor, constant: 8),
            commitScroll.heightAnchor.constraint(equalToConstant: 48),
            commitBtn.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            commitBtn.topAnchor.constraint(equalTo: commitScroll.bottomAnchor, constant: 6),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: commitBtn.bottomAnchor, constant: 6),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            rowsStack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            rowsStack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            rowsStack.widthAnchor.constraint(equalTo: scroll.widthAnchor)
        ])
        applyTheme()
        Theme.register(self)
        NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.commitPlaceholder.stringValue = t("git.commitMessage"); self?.render()
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    func setRoot(_ url: URL) { root = url; refresh() }

    func applyTheme() {
        layer?.backgroundColor = Theme.bg2.cgColor
        branchLabel.textColor = Theme.fg
        branchIcon.contentTintColor = Theme.fgDim
        commitMsg.backgroundColor = Theme.bg3
        commitMsg.textColor = Theme.fg
        commitMsg.insertionPointColor = Theme.fg
        commitScroll.layer?.borderColor = Theme.edge.cgColor
        commitPlaceholder.textColor = Theme.fgDim
        pullBtn.contentTintColor = Theme.fgDim
        pushBtn.contentTintColor = Theme.fgDim
        refreshBtn.contentTintColor = Theme.fgDim
        render()
    }

    // ---- git ops (background, then refresh on main) ----
    private func async(_ work: @escaping () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { work(); DispatchQueue.main.async { self.refresh() } }
    }
    @objc func refresh() {
        guard let root else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let s = Git.detailedStatus(cwd: root.path)
            DispatchQueue.main.async { self.status = s; self.render() }
        }
    }
    @objc private func push() { guard let r = root else { return }; async { _ = Git.push(cwd: r.path) } }
    @objc private func pull() { guard let r = root else { return }; async { _ = Git.pull(cwd: r.path) } }
    @objc private func commit() {
        guard let r = root else { return }
        let msg = commitMsg.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if msg.isEmpty { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let res = Git.commit(cwd: r.path, message: msg)
            DispatchQueue.main.async {
                if res.ok { self.commitMsg.string = "" } else { self.alert("커밋 실패", res.error) }
                self.refresh()
            }
        }
    }
    private func stage(_ rel: String) { guard let r = root else { return }; async { _ = Git.stage(cwd: r.path, rel: rel) } }
    private func unstage(_ rel: String) { guard let r = root else { return }; async { _ = Git.unstage(cwd: r.path, rel: rel) } }
    private func stageAll() { guard let r = root else { return }; async { _ = Git.stageAll(cwd: r.path) } }
    private func discard(_ f: Git.GitFile) {
        guard let r = root else { return }
        let name = (f.path as NSString).lastPathComponent
        let a = NSAlert(); a.messageText = "\(name)의 변경을 버릴까요?"
        a.informativeText = "되돌릴 수 없습니다."; a.addButton(withTitle: "버리기"); a.addButton(withTitle: "취소")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        async { _ = Git.discard(cwd: r.path, rel: f.path, untracked: f.untracked) }
    }
    private func alert(_ title: String, _ msg: String) {
        let a = NSAlert(); a.messageText = title; a.informativeText = msg; a.runModal()
    }

    // ---- render ----
    private func render() {
        rowsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        // Not a git repo → the WHOLE panel is a centered hint (riven's empty-hint.center),
        // no header / commit box.
        let repo = status.isRepo
        branchIcon.isHidden = !repo; branchLabel.isHidden = !repo; headActions.isHidden = !repo
        commitScroll.isHidden = !repo; commitPlaceholder.isHidden = !repo || !commitMsg.string.isEmpty
        commitBtn.isHidden = !repo
        if !repo {
            let hint = NSTextField(labelWithString: t("git.notRepo"))
            hint.font = .systemFont(ofSize: 12); hint.textColor = Theme.fgDim; hint.alignment = .center
            hint.translatesAutoresizingMaskIntoConstraints = false
            let box = NSView(); box.addSubview(hint)
            NSLayoutConstraint.activate([
                hint.centerXAnchor.constraint(equalTo: box.centerXAnchor),
                hint.topAnchor.constraint(equalTo: box.topAnchor, constant: 40),
                hint.leadingAnchor.constraint(greaterThanOrEqualTo: box.leadingAnchor, constant: 12),
                hint.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -12),
            ])
            rowsStack.addArrangedSubview(box)
            return
        }
        branchLabel.stringValue = status.branch ?? "?"
        // Ahead/behind as a dim trailing chip on the branch line.
        if status.hasUpstream && (status.ahead > 0 || status.behind > 0) {
            var s = status.branch ?? "?"
            if status.ahead > 0 { s += "  ↑\(status.ahead)" }
            if status.behind > 0 { s += "  ↓\(status.behind)" }
            branchLabel.stringValue = s
        }
        pullBtn.isHidden = !status.hasUpstream; pushBtn.isHidden = !status.hasUpstream

        let staged = status.files.filter { $0.staged }
        let changed = status.files.filter { $0.unstaged }
        commitBtn.title = staged.isEmpty ? t("git.commit") : "\(t("git.commit")) (\(staged.count))"
        // Enabled only with staged files AND a non-empty message (riven parity).
        commitBtn.isEnabled = !staged.isEmpty && !commitMsg.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        styleCommitButton()

        if !staged.isEmpty {
            rowsStack.addArrangedSubview(section("\(t("git.staged")) (\(staged.count))", action: nil))
            for f in staged { rowsStack.addArrangedSubview(fileRow(f, staged: true)) }
        }
        rowsStack.addArrangedSubview(section("\(t("git.changed")) (\(changed.count))", action: changed.isEmpty ? nil : (t("git.stageAllShort"), #selector(stageAllAction))))
        for f in changed { rowsStack.addArrangedSubview(fileRow(f, staged: false)) }
        if staged.isEmpty && changed.isEmpty {
            let hint = NSTextField(labelWithString: t("git.noChanges"))
            hint.font = .systemFont(ofSize: 12); hint.textColor = Theme.fgDim
            rowsStack.addArrangedSubview(pad(hint))
        }
    }
    private func styleCommitButton() {
        commitBtn.layer?.cornerRadius = 6
        commitBtn.contentTintColor = commitBtn.isEnabled ? Theme.bg : Theme.fgDim
        commitBtn.layer?.backgroundColor = (commitBtn.isEnabled ? Theme.accent : Theme.bg3).cgColor
        commitBtn.alphaValue = commitBtn.isEnabled ? 1 : 0.5
    }
    // Placeholder visibility + live commit-button enablement.
    func textDidChange(_ notification: Notification) {
        commitPlaceholder.isHidden = !commitMsg.string.isEmpty
        let staged = status.files.filter { $0.staged }
        commitBtn.isEnabled = !staged.isEmpty && !commitMsg.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        styleCommitButton()
    }
    @objc private func stageAllAction() { stageAll() }

    private func pad(_ v: NSView) -> NSView {
        let c = NSView(); v.translatesAutoresizingMaskIntoConstraints = false; c.addSubview(v)
        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
            v.topAnchor.constraint(equalTo: c.topAnchor, constant: 6),
            v.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -6),
            v.trailingAnchor.constraint(lessThanOrEqualTo: c.trailingAnchor, constant: -6)
        ])
        return c
    }

    private func section(_ title: String, action: (String, Selector)?) -> NSView {
        let l = NSTextField(labelWithString: title)
        l.font = .systemFont(ofSize: 11, weight: .medium); l.textColor = Theme.fgDim
        l.translatesAutoresizingMaskIntoConstraints = false
        let c = NSView(); c.addSubview(l)
        NSLayoutConstraint.activate([
            l.leadingAnchor.constraint(equalTo: c.leadingAnchor, constant: 12),
            l.topAnchor.constraint(equalTo: c.topAnchor, constant: 8),
            l.bottomAnchor.constraint(equalTo: c.bottomAnchor, constant: -2)
        ])
        if let (t, sel) = action {
            let b = NSButton(title: t, target: self, action: sel)
            b.isBordered = false; b.font = .systemFont(ofSize: 10); b.contentTintColor = Theme.accent
            b.translatesAutoresizingMaskIntoConstraints = false
            c.addSubview(b)
            NSLayoutConstraint.activate([
                b.trailingAnchor.constraint(equalTo: c.trailingAnchor, constant: -8),
                b.centerYAnchor.constraint(equalTo: l.centerYAnchor)
            ])
        }
        return c
    }

    private func fileRow(_ f: Git.GitFile, staged: Bool) -> NSView {
        let ch = staged ? f.x : f.y
        let info = gitInfo(ch)
        let name = (f.path as NSString).lastPathComponent
        let dir = f.path.contains("/") ? " · " + (f.path as NSString).deletingLastPathComponent : ""

        let badge = pill(info.word, info.color)

        let nameL = NSTextField(labelWithString: name)
        nameL.font = .systemFont(ofSize: 12); nameL.textColor = Theme.fg
        nameL.lineBreakMode = .byTruncatingMiddle; nameL.toolTip = f.path
        nameL.translatesAutoresizingMaskIntoConstraints = false
        let dirL = NSTextField(labelWithString: dir)
        dirL.font = .systemFont(ofSize: 11); dirL.textColor = Theme.fgDim
        dirL.lineBreakMode = .byTruncatingMiddle
        dirL.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        dirL.translatesAutoresizingMaskIntoConstraints = false

        let row = GitRowView()
        row.onClick = { [weak self] in self?.onOpenDiff?(f.path) }
        row.addSubview(badge); row.addSubview(nameL); row.addSubview(dirL)

        // Action buttons: stage / unstage / discard (SF Symbols, riven iconography).
        var trailing = row.trailingAnchor
        func actBtn(_ sym: String, _ tip: String, _ color: NSColor, _ handler: @escaping () -> Void) {
            let b = HoverButton(handler: handler)
            b.image = NSImage(systemSymbolName: sym, accessibilityDescription: nil)
            b.image?.isTemplate = true; b.imagePosition = .imageOnly
            b.symbolConfiguration = .init(pointSize: 11, weight: .regular)
            b.contentTintColor = color; b.toolTip = tip
            b.isBordered = false; b.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(b)
            b.trailingAnchor.constraint(equalTo: trailing, constant: -6).isActive = true
            b.centerYAnchor.constraint(equalTo: row.centerYAnchor).isActive = true
            b.widthAnchor.constraint(equalToConstant: 18).isActive = true
            trailing = b.leadingAnchor
        }
        if staged {
            actBtn("minus", t("git.unstage"), Theme.fgDim) { [weak self] in self?.unstage(f.path) }
        } else {
            actBtn("plus", t("git.stage"), Theme.fgDim) { [weak self] in self?.stage(f.path) }
            actBtn("trash", t("git.discard"), Theme.danger) { [weak self] in self?.discard(f) }
        }
        NSLayoutConstraint.activate([
            badge.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 10),
            badge.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            nameL.leadingAnchor.constraint(equalTo: badge.trailingAnchor, constant: 6),
            nameL.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            dirL.leadingAnchor.constraint(equalTo: nameL.trailingAnchor, constant: 0),
            dirL.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            dirL.trailingAnchor.constraint(lessThanOrEqualTo: trailing, constant: -6),
            row.heightAnchor.constraint(equalToConstant: 24)
        ])
        return row
    }

    // A rounded tinted status pill (riven .git-badge): localized word on a 12% wash.
    private func pill(_ word: String, _ color: NSColor) -> NSView {
        let v = NSView(); v.wantsLayer = true
        v.layer?.cornerRadius = 4
        v.layer?.backgroundColor = color.withAlphaComponent(0.12).cgColor
        v.translatesAutoresizingMaskIntoConstraints = false
        v.setContentHuggingPriority(.required, for: .horizontal)
        v.setContentCompressionResistancePriority(.required, for: .horizontal)
        let l = NSTextField(labelWithString: word)
        l.font = .monospacedSystemFont(ofSize: 9, weight: .bold)
        l.textColor = color
        l.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(l)
        NSLayoutConstraint.activate([
            l.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 5),
            l.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -5),
            l.topAnchor.constraint(equalTo: v.topAnchor, constant: 1),
            l.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -1),
        ])
        return v
    }

    // riven's git.status.* word + category colour (M=amber, A=green, ?=blue untracked,
    // R=violet renamed, D=red, C/U=neutral).
    private func gitInfo(_ ch: Character) -> (word: String, color: NSColor) {
        switch ch {
        case "M": return (t("git.status.M"), Theme.warning)
        case "A": return (t("git.status.A"), Theme.success)
        case "D": return (t("git.status.D"), Theme.danger)
        case "R": return (t("git.status.R"), Theme.accent2)
        case "?": return (t("git.status.Q"), Theme.info)
        case "C": return (t("git.status.C"), Theme.fgDim)
        case "U": return (t("git.status.U"), Theme.fgDim)
        default:  return (String(ch), Theme.fgDim)
        }
    }
}

// A clickable git row with hover highlight.
private final class GitRowView: NSView {
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

// A borderless button backed by a Swift closure (AppKit needs a target/action).
private final class HoverButton: NSButton {
    private let handler: () -> Void
    init(handler: @escaping () -> Void) {
        self.handler = handler
        super.init(frame: .zero)
        self.target = self; self.action = #selector(fire)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc private func fire() { handler() }
}
