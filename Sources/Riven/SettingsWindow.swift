import AppKit

// Settings modal — a native port of riven's SettingsModal. A 560-wide panel with a
// "설정" header, an underline-active tab bar (일반 / AI / 단축키 / 정보) and a single
// scrollable content pane padded 20px on each side. Theme selection is a wrapping
// row of swatch pills (colored dot + name) with an accent ring on the active one.
final class SettingsWindow: NSPanel {
    private var tabs: [String] { [t("settings.tab.general"), t("settings.tab.ai"), t("settings.tab.keys"), t("settings.tab.account"), t("settings.tab.about")] }
    private var tabButtons: [NSButton] = []
    private let underline = NSView()
    private let scroll = NSScrollView()
    private let content = FlippedStack()
    private var activeTab = 0
    private var authObserver: Any?          // .rivenAuthChanged → refresh the Account tab
    private var langObserver: NSObjectProtocol?   // .rivenLanguageChanged → relabel tabs
    // Remove both observer tokens on teardown so they don't leak per window open (#64).
    deinit {
        if let o = authObserver as? NSObjectProtocol { NotificationCenter.default.removeObserver(o) }
        if let o = langObserver { NotificationCenter.default.removeObserver(o) }
    }
    private var accountError: String?       // last sign-in error, shown on the Account tab

    // controls (kept as properties so save() can read them)
    private let aiEnable = NSButton(checkboxWithTitle: t("settings.aiEnable"), target: nil, action: nil)
    private let provider = NSPopUpButton()
    private let model = NSTextField()
    private let endpoint = NSTextField()
    private let apiKey = NSSecureTextField()
    private let editorSize = NSTextField()
    private let terminalSize = NSTextField()
    private let notify = NSButton(checkboxWithTitle: "데스크톱 알림 사용 (에이전트 완료 · 터미널 벨)", target: nil, action: nil)
    private let formatOnSave = NSButton(checkboxWithTitle: "저장 시 자동 포맷", target: nil, action: nil)
    private var swatches: [NSView] = []
    // 라이브 테마 전환에서 다시 칠해야 하는 창 자체의 크롬 (배경 · 제목 · 닫기 · 헤어라인).
    private var rootView: NSView!
    private var titleLabel: NSTextField!
    private var closeBtn: NSButton!
    private let hair = NSView()

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 560, height: 620),
                   styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        title = t("settings.title")
        backgroundColor = Theme.bg2
        isFloatingPanel = true
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        appearance = NSAppearance(named: Theme.isLight ? .aqua : .darkAqua)
        // riven's settings is an in-app overlay with NO traffic lights — hide them so
        // the "설정" title sits at the natural 16px left (a Close button replaces them).
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        let root = NSView(frame: contentView!.bounds)
        root.autoresizingMask = [.width, .height]
        root.wantsLayer = true
        root.layer?.backgroundColor = Theme.bg2.cgColor

        // Header: "설정" title (left) + Close (right) over the tab bar.
        let header = NSView(); header.translatesAutoresizingMaskIntoConstraints = false
        let titleLabel = NSTextField(labelWithString: t("settings.title"))
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = Theme.fg
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        self.titleLabel = titleLabel
        header.addSubview(titleLabel)
        let closeBtn = NSButton(title: t("common.close"), target: self, action: #selector(closeSettings))
        self.closeBtn = closeBtn
        closeBtn.isBordered = false; closeBtn.font = .systemFont(ofSize: 11)
        closeBtn.contentTintColor = Theme.fgDim
        closeBtn.wantsLayer = true; closeBtn.layer?.backgroundColor = Theme.hover.cgColor
        closeBtn.layer?.cornerRadius = 6
        closeBtn.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(closeBtn)
        NSLayoutConstraint.activate([
            closeBtn.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            closeBtn.topAnchor.constraint(equalTo: header.topAnchor, constant: 12),
            closeBtn.heightAnchor.constraint(equalToConstant: 22),
            closeBtn.widthAnchor.constraint(equalToConstant: 44)
        ])

        // Tab bar (underline-active), aligned with the content padding.
        let tabStack = NSStackView()
        tabStack.orientation = .horizontal; tabStack.spacing = 4
        tabStack.translatesAutoresizingMaskIntoConstraints = false
        for (i, label) in tabs.enumerated() {
            let b = makeTab(label, i)
            tabButtons.append(b); tabStack.addArrangedSubview(b)
        }
        hair.wantsLayer = true; hair.layer?.backgroundColor = Theme.hairline.cgColor
        hair.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(tabStack); header.addSubview(hair)

        // Scrollable content.
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 8
        // Reliable inner padding (the documentView leading constraint is ignored by
        // the scroll view, so pad via the stack's own insets instead).
        content.edgeInsets = NSEdgeInsets(top: 14, left: 20, bottom: 20, right: 20)
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = content
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

        root.addSubview(header); root.addSubview(scroll)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 78),
            titleLabel.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 16),  // no traffic lights now
            titleLabel.topAnchor.constraint(equalTo: header.topAnchor, constant: 14),
            tabStack.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 18),
            tabStack.bottomAnchor.constraint(equalTo: header.bottomAnchor),
            hair.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            hair.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            hair.bottomAnchor.constraint(equalTo: header.bottomAnchor),
            hair.heightAnchor.constraint(equalToConstant: 1),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            content.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            content.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            content.widthAnchor.constraint(equalTo: scroll.widthAnchor)
        ])
        contentView = root
        rootView = root
        installGlass(on: self, content: root, radius: 14)
        showTab(0)
        Theme.register(self)
        // Live language switch: relabel the tabs + re-render the active tab.
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            let labels = self.tabs
            for (i, b) in self.tabButtons.enumerated() where i < labels.count { b.title = labels[i] }
            self.showTab(self.activeTab)
        }
    }

    private func makeTab(_ t: String, _ i: Int) -> NSButton {
        let b = NSButton(title: t, target: self, action: #selector(tabClicked(_:)))
        b.tag = i; b.isBordered = false
        b.font = .systemFont(ofSize: 13, weight: .medium)
        b.contentTintColor = i == 0 ? Theme.fg : Theme.fgDim
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(equalToConstant: 34).isActive = true
        // Padding around the label so the whole tab is an easy click target (riven's
        // .kb-tab padding 9px 12px).
        b.widthAnchor.constraint(greaterThanOrEqualToConstant: 54).isActive = true
        (b.cell as? NSButtonCell)?.highlightsBy = []
        return b
    }

    @objc private func closeSettings() { performClose(nil) }
    func openTab(_ i: Int) { showTab(i) }   // debug/capture hook

    // ---- tabs ----
    @objc private func tabClicked(_ s: NSButton) { showTab(s.tag) }
    private func showTab(_ i: Int) {
        activeTab = i
        // Underline pinned to the active tab's own bottom (no fragile frame math), so
        // it's always exactly under the text and flush with the tab-bar hairline.
        for (j, b) in tabButtons.enumerated() {
            b.contentTintColor = j == i ? Theme.fg : Theme.fgDim
            b.subviews.filter { $0.identifier == tabUnderlineID }.forEach { $0.removeFromSuperview() }
            if j == i {
                let u = NSView(); u.identifier = tabUnderlineID; u.wantsLayer = true
                u.layer?.backgroundColor = Theme.accent.cgColor
                u.translatesAutoresizingMaskIntoConstraints = false
                b.addSubview(u)
                NSLayoutConstraint.activate([
                    u.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: 2),
                    u.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -2),
                    u.bottomAnchor.constraint(equalTo: b.bottomAnchor),
                    u.heightAnchor.constraint(equalToConstant: 2)
                ])
            }
        }
        content.arrangedSubviews.forEach { $0.removeFromSuperview() }
        switch i {
        case 0: buildGeneral()
        case 1: buildAI()
        case 2: buildKeybindings()
        case 3: buildAccount()
        default: buildAbout()
        }
    }
    private let tabUnderlineID = NSUserInterfaceItemIdentifier("tabUnderline")

    // ---- General tab ----
    private func buildGeneral() {
        let s = Settings.shared
        addSection("언어 / Language")
        let langSeg = NSSegmentedControl(labels: ["한국어", "English"], trackingMode: .selectOne,
                                         target: self, action: #selector(changeLanguage(_:)))
        langSeg.selectedSegment = (I18n.current == .en) ? 1 : 0
        content.addArrangedSubview(langSeg)
        content.addArrangedSubview(spacer(10))

        addSection(t("settings.colorTheme"))
        // Wrapping rows of theme swatch pills.
        swatches = []
        var rowStack = newWrapRow()
        content.addArrangedSubview(rowStack)
        var count = 0
        for def in Theme.all {
            if count == 3 { rowStack = newWrapRow(); content.addArrangedSubview(rowStack); count = 0 }
            let pill = themeSwatch(def)
            swatches.append(pill); rowStack.addArrangedSubview(pill); count += 1
        }

        addSection(t("settings.editor"))
        editorSize.stringValue = String(s.int("editorFontSize", 13))
        content.addArrangedSubview(setRow(t("settings.fontSize"), fontField(editorSize)))
        formatOnSave.title = t("settings.formatOnSave")
        formatOnSave.state = s.bool("formatOnSave", false) ? .on : .off
        formatOnSave.target = self; formatOnSave.action = #selector(saveFormatOnSave)
        formatOnSave.contentTintColor = Theme.fg
        formatOnSave.font = .systemFont(ofSize: 13)
        content.addArrangedSubview(formatOnSave)

        addSection(t("settings.terminal"))
        terminalSize.stringValue = String(s.int("terminalFontSize", 13))
        content.addArrangedSubview(setRow(t("settings.fontSize"), fontField(terminalSize)))

        addSection(t("settings.notifications"))
        notify.title = t("settings.notifyDesc")
        notify.state = s.bool("notifications", true) ? .on : .off
        notify.target = self; notify.action = #selector(saveNotify)
        notify.contentTintColor = Theme.fg
        notify.font = .systemFont(ofSize: 13)
        content.addArrangedSubview(notify)

        content.addArrangedSubview(spacer(10))
        let saveBtn = primaryButton(t("settings.saveFonts"), #selector(saveFonts))
        content.addArrangedSubview(saveBtn)
    }
    private func newWrapRow() -> NSStackView {
        let r = NSStackView(); r.orientation = .horizontal; r.spacing = 8; r.alignment = .centerY
        r.distribution = .fill
        return r
    }
    private func themeSwatch(_ def: ThemeDef) -> NSView {
        let active = def.id == Theme.current.id
        let b = PadButton(title: def.name, font: .systemFont(ofSize: 13), textColor: Theme.fg,
            bg: active ? Theme.accentMuted : Theme.hover, border: active ? Theme.accentBorder : Theme.edge,
            radius: 13, hPad: 11, height: 26, dotColor: Theme.hex(def.accent))
        b.identifierString = def.id
        b.onClick = { [weak self] in
            (NSApp.delegate as? AppDelegate)?.switchTheme(def.id)
            self?.showTab(0)   // re-render so the active pill updates
        }
        return b
    }
    @objc private func saveNotify() { Settings.shared.set("notifications", notify.state == .on) }
    @objc private func saveFormatOnSave() {
        Settings.shared.set("formatOnSave", formatOnSave.state == .on)
        NotificationCenter.default.post(name: .rivenFormatOnSaveChanged, object: nil)
    }
    @objc private func changeLanguage(_ seg: NSSegmentedControl) {
        I18n.setLanguage(seg.selectedSegment == 1 ? .en : .ko)
    }
    // 폰트 크기 입력칸 — 엔터를 치거나 포커스를 잃는 순간 바로 저장 + 적용된다.
    // (예전에는 "저장" 버튼을 눌러야 값이 들어갔고, 그마저도 읽는 쪽이 없어 재시작해도
    //  반영되지 않았다.)
    private func fontField(_ tf: NSTextField) -> NSTextField {
        let f = field(tf, width: 72)
        f.target = self; f.action = #selector(saveFonts)
        (f.cell as? NSTextFieldCell)?.sendsActionOnEndEditing = true
        return f
    }
    // 8–48pt로 클램프 (0이나 음수가 들어가면 에디터/터미널이 깨진다).
    private func clampFont(_ s: String, _ fallback: Int) -> Int {
        guard let v = Int(s.trimmingCharacters(in: .whitespaces)) else { return fallback }
        return max(8, min(48, v))
    }
    @objc private func saveFonts() {
        let ed = clampFont(editorSize.stringValue, Settings.shared.int("editorFontSize", 13))
        let tm = clampFont(terminalSize.stringValue, Settings.shared.int("terminalFontSize", 13))
        editorSize.stringValue = String(ed); terminalSize.stringValue = String(tm)
        Settings.shared.set("editorFontSize", ed)
        Settings.shared.set("terminalFontSize", tm)
        // 에디터(Monaco)와 터미널(ghostty)이 각자 구독해서 즉시 반영한다.
        NotificationCenter.default.post(name: .rivenFontSizeChanged, object: nil)
    }

    // ---- AI tab ----
    private func buildAI() {
        let s = Settings.shared
        addSection(t("settings.aiSection"))
        aiEnable.state = s.bool("aiComplete", false) ? .on : .off
        aiEnable.target = self; aiEnable.action = #selector(saveAI)
        aiEnable.contentTintColor = Theme.fg
        aiEnable.font = .systemFont(ofSize: 13)
        content.addArrangedSubview(aiEnable)

        provider.removeAllItems()
        let providers = ["ollama", "openai", "anthropic", "gemini", "deepseek", "mistral", "groq", "openrouter", "custom"]
        provider.addItems(withTitles: providers)
        provider.selectItem(withTitle: s.string("aiProvider", "ollama"))
        provider.target = self; provider.action = #selector(saveAI)
        provider.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(setRow("제공자", provider))

        model.stringValue = s.string("aiCompleteModel", "qwen2.5-coder:1.5b")
        content.addArrangedSubview(setRow("모델", field(model)))
        endpoint.stringValue = s.string("aiCompleteEndpoint", "http://localhost:11434")
        content.addArrangedSubview(setRow("엔드포인트", field(endpoint)))
        apiKey.stringValue = s.string("aiApiKey", "")
        content.addArrangedSubview(setRow("API 키", field(apiKey)))

        content.addArrangedSubview(spacer(10))
        content.addArrangedSubview(primaryButton(t("settings.saveAI"), #selector(saveAIAll)))

        // Snippets — prefix expands to body (${1} tab stops) via Monaco completion.
        addSection(t("settings.snippets"))
        let hint = NSTextField(labelWithString: t("settings.snippetsHint"))
        hint.font = .systemFont(ofSize: 11); hint.textColor = Theme.fgDim
        hint.lineBreakMode = .byWordWrapping; hint.preferredMaxLayoutWidth = 500
        content.addArrangedSubview(hint)
        let snips = (Settings.shared.object("snippets") as? [String: String]) ?? [:]
        for (prefix, body) in snips.sorted(by: { $0.key < $1.key }) {
            let l = NSTextField(labelWithString: "\(prefix)  →  \(body.replacingOccurrences(of: "\n", with: "⏎"))")
            l.font = .monospacedSystemFont(ofSize: 11, weight: .regular); l.textColor = Theme.fgDim
            l.lineBreakMode = .byTruncatingTail
            let del = PadButton(title: "삭제", font: .systemFont(ofSize: 11), textColor: Theme.danger,
                                bg: Theme.hover, border: Theme.edge, radius: 5, hPad: 8, height: 22)
            del.onClick = { [weak self] in self?.deleteSnippet(prefix) }
            let sp = NSView(); sp.setContentHuggingPriority(.defaultLow, for: .horizontal)
            let row = NSStackView(views: [l, sp, del]); row.orientation = .horizontal; row.alignment = .centerY
            row.widthAnchor.constraint(equalToConstant: 500).isActive = true
            content.addArrangedSubview(row)
        }
        content.addArrangedSubview(setRow(t("settings.snippetPrefix"), field(snippetPrefix, width: 120)))
        content.addArrangedSubview(setRow(t("settings.snippetBody"), field(snippetBody)))
        content.addArrangedSubview(primaryButton(t("settings.addSnippet"), #selector(addSnippet)))
    }
    private let snippetPrefix = NSTextField()
    private let snippetBody = NSTextField()
    @objc private func addSnippet() {
        let p = snippetPrefix.stringValue.trimmingCharacters(in: .whitespaces)
        guard !p.isEmpty else { return }
        var d = (Settings.shared.object("snippets") as? [String: String]) ?? [:]
        d[p] = snippetBody.stringValue
        Settings.shared.set("snippets", d)
        NotificationCenter.default.post(name: .rivenSnippetsChanged, object: nil)
        snippetPrefix.stringValue = ""; snippetBody.stringValue = ""
        showTab(1)
    }
    private func deleteSnippet(_ prefix: String) {
        var d = (Settings.shared.object("snippets") as? [String: String]) ?? [:]
        d[prefix] = nil
        Settings.shared.set("snippets", d)
        NotificationCenter.default.post(name: .rivenSnippetsChanged, object: nil)
        showTab(1)
    }
    @objc private func saveAI() {
        Settings.shared.set("aiComplete", aiEnable.state == .on)
        Settings.shared.set("aiProvider", provider.titleOfSelectedItem ?? "ollama")
    }
    @objc private func saveAIAll() {
        saveAI()
        Settings.shared.set("aiCompleteModel", model.stringValue)
        Settings.shared.set("aiCompleteEndpoint", endpoint.stringValue)
        Settings.shared.set("aiApiKey", apiKey.stringValue)
    }

    // ---- Keybindings tab — three sub-tabs (에디터 / 터미널 / 리븐 기본), matching riven's
    // KeybindingsSettings. The editor tab has preset chips (VS Code / JetBrains /
    // Sublime); the shown chords follow the selected preset. ----
    private var kbSubtab = 0   // 0 에디터, 1 터미널, 2 리븐 기본 (riven defaults to editor)
    private let editorPresets = ["vscode": "VS Code", "jetbrains": "JetBrains", "sublime": "Sublime Text"]

    private func buildKeybindings() {
        // Sub-tab chips.
        let names = ["에디터", "터미널", "리븐 기본"]
        let row = NSStackView(); row.orientation = .horizontal; row.spacing = 6
        for (i, n) in names.enumerated() {
            let on = i == kbSubtab
            let b = PadButton(title: n, font: .systemFont(ofSize: 12, weight: .medium),
                textColor: on ? Theme.accent : Theme.fgDim, bg: on ? Theme.accentMuted : Theme.hover,
                border: on ? Theme.accentBorder : Theme.edge, radius: 6, hPad: 12, height: 26)
            b.onClick = { [weak self] in self?.kbSubtab = i; self?.showTab(2) }
            row.addArrangedSubview(b)
        }
        content.addArrangedSubview(row)
        content.addArrangedSubview(spacer(6))

        let hint = NSTextField(labelWithString: "칩을 클릭하고 원하는 키를 누르세요. Esc로 취소.")
        hint.font = .systemFont(ofSize: 11); hint.textColor = Theme.fgDim
        content.addArrangedSubview(hint)
        content.addArrangedSubview(spacer(4))
        switch kbSubtab {
        case 0:                                                         // 에디터 (preset + per-command)
            buildEditorKeys()
            for a in Keys.byCat("editor") { content.addArrangedSubview(kbRecordRow(a)) }
        case 1: for a in Keys.byCat("terminal") { content.addArrangedSubview(kbRecordRow(a)) }  // 터미널
        default: for a in Keys.byCat("riven") { content.addArrangedSubview(kbRecordRow(a)) }    // 리븐 기본
        }
    }

    // A remappable row: label + a clickable chord chip that records the next keypress.
    private var kbMonitor: Any?
    private func kbRecordRow(_ action: Keys.Action) -> NSView {
        let l = NSTextField(labelWithString: action.label)
        l.font = .systemFont(ofSize: 13); l.textColor = Theme.fg
        l.translatesAutoresizingMaskIntoConstraints = false
        let chip = PadButton(title: Keys.display(Keys.effective(action.id)),
                             font: .monospacedSystemFont(ofSize: 11, weight: .medium),
                             textColor: Theme.fgDim, bg: Theme.bg3, border: Theme.edge,
                             radius: 5, hPad: 8, height: 24)
        chip.onClick = { [weak self, weak chip] in self?.beginRecording(action.id, action.cat, chip) }
        let spacerV = NSView(); spacerV.translatesAutoresizingMaskIntoConstraints = false
        spacerV.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let h = NSStackView(views: [l, spacerV, chip])
        h.orientation = .horizontal; h.alignment = .centerY
        h.translatesAutoresizingMaskIntoConstraints = false
        h.widthAnchor.constraint(equalToConstant: 500).isActive = true
        h.heightAnchor.constraint(equalToConstant: 28).isActive = true
        return h
    }
    private func beginRecording(_ id: String, _ cat: String, _ chip: PadButton?) {
        if let m = kbMonitor { NSEvent.removeMonitor(m); kbMonitor = nil }
        chip?.setTitle("키 입력…")
        kbMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self else { return e }
            if let m = self.kbMonitor { NSEvent.removeMonitor(m); self.kbMonitor = nil }
            if e.keyCode == 53 { self.showTab(2); return nil }   // esc → cancel
            if let chord = Keys.chord(from: e) {
                if let clash = Keys.conflict(chord, excluding: id, cat: cat) {
                    let a = NSAlert(); a.messageText = "단축키 충돌"
                    a.informativeText = "\(Keys.display(chord)) 은(는) 이미 \"\(clash.label)\"에 할당되어 있습니다. 그래도 변경할까요?"
                    a.addButton(withTitle: "변경"); a.addButton(withTitle: "취소")
                    if a.runModal() == .alertFirstButtonReturn { Keys.setOverride(id, chord) }
                } else {
                    Keys.setOverride(id, chord)
                }
            }
            self.showTab(2)   // rebuild the list with the new binding
            return nil
        }
    }

    private func buildEditorKeys() {
        let presetRow = NSStackView(); presetRow.orientation = .horizontal; presetRow.spacing = 6
        let cur = Settings.shared.string("editorKeymap", "vscode")
        for id in ["vscode", "jetbrains", "sublime"] {
            let on = id == cur
            let b = PadButton(title: editorPresets[id]!, font: .systemFont(ofSize: 12),
                textColor: on ? Theme.accent : Theme.fgDim, bg: on ? Theme.accentMuted : Theme.hover,
                border: on ? Theme.accentBorder : Theme.edge, radius: 6, hPad: 12, height: 26)
            b.onClick = { [weak self] in
                Settings.shared.set("editorKeymap", id)
                NotificationCenter.default.post(name: .rivenEditorKeymapChanged, object: nil)
                self?.showTab(2)
            }
            presetRow.addArrangedSubview(b)
        }
        content.addArrangedSubview(presetRow)
        content.addArrangedSubview(spacer(6))
        // The actual per-command rows are added by the caller as recordable rows
        // (Keys.byCat("editor")); the old static display list is gone (it left empty
        // chips for commands a preset didn't override).
    }

    // Correct riven bindings (from keybindings/actions.ts).
    private let rivenKeys: [(String, String)] = [
        ("워크스페이스 1–9번 전환", "⌘1–9"), ("에디터로 포커스", "⌘E"), ("활성 터미널로 포커스", "⌘J"),
        ("다음 패널", "⌘⌥→"), ("이전 패널", "⌘⌥←"),
        ("왼쪽 창으로 포커스", "⌃⌘←"), ("오른쪽 창으로 포커스", "⌃⌘→"),
        ("위쪽 창으로 포커스", "⌃⌘↑"), ("아래쪽 창으로 포커스", "⌃⌘↓"),
        ("탐색기 사이드바 토글", "⌘B"), ("검색 패널", "⌘⇧F"), ("Git 패널", "⌘⇧G"),
        ("프리뷰 패널", "⌘⇧V"), ("현재 패널 새 창으로", "⌘⇧O"),
        ("파일 빠른 열기", "⌘P"), ("명령 팔레트", "⌘⇧P"), ("패널 추가", "⌘O"),
        ("파일 저장", "⌘S"), ("설정 열기", "⌘,"), ("단축키 설정 열기", "⌘⌥K")
    ]
    private let terminalKeys: [(String, String)] = [
        ("새 터미널", "⌘T"), ("터미널 화면 지우기", "⌘K"), ("터미널 오른쪽 분할", "⌘D"),
        ("터미널 아래로 분할", "⌘⇧D"), ("다음 터미널 탭", "⌘⇧]"), ("이전 터미널 탭", "⌘⇧["),
        ("N번 터미널로", "⌃1–9")
    ]
    // (label, [vscode, jetbrains, sublime]) — from editorKeymaps.ts.
    private let editorKeys: [(String, [String])] = [
        ("찾기", ["⌘F", "⌘F", "⌘F"]), ("바꾸기", ["⌘⌥F", "⌘R", "⌘⌥F"]),
        ("다음 같은 항목 선택", ["⌘D", "⌃G", "⌘D"]), ("같은 항목 모두 선택", ["⌘F2", "⌘⌃G", "⌘⌃G"]),
        ("줄 복제", ["⇧⌥↓", "⌘D", "⌘⇧D"]), ("줄 삭제", ["⌘⇧K", "⌘⌫", "⌘⌃K"]),
        ("줄 위로 이동", ["⌥↑", "⌥⇧↑", "⌘⌃↑"]), ("줄 아래로 이동", ["⌥↓", "⌥⇧↓", "⌘⌃↓"]),
        ("한 줄 주석", ["⌘/", "⌘/", "⌘/"]), ("블록 주석", ["⇧⌥A", "⌘⇧/", "⌘⌥/"]),
        ("문서 정렬", ["⇧⌥F", "⌘⌥L", "⇧⌥F"]), ("이름 변경", ["F2", "⇧F6", "F2"]),
        ("빠른 수정", ["⌘.", "⌥⏎", "⌘."]), ("정의로 이동", ["F12", "F12", "F12"]),
        ("참조 찾기", ["⇧F12", "⇧F12", "⇧F12"]), ("자동완성", ["⌃Space", "⌃Space", "⌃Space"]),
        ("들여쓰기", ["⌘]", "⌘]", "⌘]"]), ("내어쓰기", ["⌘[", "⌘[", "⌘["]),
        ("선택 확장", ["⌃⇧→", "⌥↑", "⌃⇧↑"]), ("선택 축소", ["⌃⇧←", "⌥↓", "⌃⇧↓"]),
        ("모두 접기", ["⌘⌥[", "⌘⌥[", "⌘⌥["]), ("모두 펼치기", ["⌘⌥]", "⌘⌥]", "⌘⌥]"]),
        ("명령 팔레트", ["F1", "⌘⇧A", "F1"]), ("줄 번호로 이동", ["⌃G", "⌘⌥G", "⌃G"])
    ]
    private func kbRow(_ command: String, _ chord: String) -> NSView {
        let l = NSTextField(labelWithString: command)
        l.font = .systemFont(ofSize: 13); l.textColor = Theme.fg
        l.translatesAutoresizingMaskIntoConstraints = false
        let cap = NSTextField(labelWithString: chord)
        cap.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        cap.textColor = Theme.fgDim
        cap.alignment = .center
        cap.drawsBackground = false
        cap.translatesAutoresizingMaskIntoConstraints = false
        let chip = NSView(); chip.wantsLayer = true
        chip.layer?.backgroundColor = Theme.bg3.cgColor
        chip.layer?.cornerRadius = 5
        chip.layer?.borderWidth = 1
        chip.layer?.borderColor = Theme.edge.cgColor
        chip.translatesAutoresizingMaskIntoConstraints = false
        chip.addSubview(cap)
        NSLayoutConstraint.activate([
            cap.leadingAnchor.constraint(equalTo: chip.leadingAnchor, constant: 8),
            cap.trailingAnchor.constraint(equalTo: chip.trailingAnchor, constant: -8),
            cap.topAnchor.constraint(equalTo: chip.topAnchor, constant: 3),
            cap.bottomAnchor.constraint(equalTo: chip.bottomAnchor, constant: -3)
        ])
        let spacerV = NSView(); spacerV.translatesAutoresizingMaskIntoConstraints = false
        let h = NSStackView(views: [l, spacerV, chip])
        h.orientation = .horizontal; h.alignment = .centerY
        h.translatesAutoresizingMaskIntoConstraints = false
        spacerV.setContentHuggingPriority(.defaultLow, for: .horizontal)
        h.widthAnchor.constraint(equalToConstant: 500).isActive = true
        h.heightAnchor.constraint(equalToConstant: 26).isActive = true
        return h
    }

    // ---- Account tab — riven's Supabase account & settings sync. The native build
    // ships no Supabase project, so it shows riven's real "not configured" state
    // (the same UI riven renders when the env vars are absent). ----
    private func buildAccount() {
        // Refresh this tab live when auth state flips (sign-in / sign-out).
        if authObserver == nil {
            authObserver = NotificationCenter.default.addObserver(forName: .rivenAuthChanged, object: nil, queue: .main) { [weak self] _ in
                if self?.activeTab == 3 { self?.showTab(3) }
            }
        }
        addSection(t("account.title"))
        let note = NSTextField(labelWithString:
            "riven 계정에 로그인하면 테마·폰트·키맵 등 설정이 클라우드에 저장되어 기기 간에 동기화됩니다. (GitHub OAuth · Supabase)")
        note.font = .systemFont(ofSize: 12); note.textColor = Theme.fgDim
        note.lineBreakMode = .byWordWrapping; note.maximumNumberOfLines = 4
        note.preferredMaxLayoutWidth = 500
        note.translatesAutoresizingMaskIntoConstraints = false
        note.widthAnchor.constraint(equalToConstant: 500).isActive = true
        content.addArrangedSubview(note)
        content.addArrangedSubview(spacer(6))

        if !SupabaseConfig.isConfigured {
            addSection(t("settings.status"))
            let status = NSTextField(labelWithString:
                "Supabase 미구성 — 이 네이티브 빌드에는 riven 계정 백엔드가 아직 연결되어 있지 않습니다.")
            status.font = .systemFont(ofSize: 11); status.textColor = Theme.warning
            status.lineBreakMode = .byWordWrapping; status.maximumNumberOfLines = 3
            status.preferredMaxLayoutWidth = 500
            content.addArrangedSubview(status)
            let sync = NSTextField(labelWithString: "API 키 등 민감한 값은 동기화되지 않고 이 기기에만 저장됩니다.")
            sync.font = .systemFont(ofSize: 11); sync.textColor = Theme.fgDim
            content.addArrangedSubview(sync)
            return
        }

        if SupabaseAuth.shared.isSignedIn {
            let who = NSTextField(labelWithString: "✓ \(SupabaseAuth.shared.email ?? "로그인됨") — 설정이 이 계정에 동기화됩니다.")
            who.font = .systemFont(ofSize: 12); who.textColor = Theme.success
            who.lineBreakMode = .byTruncatingMiddle; who.preferredMaxLayoutWidth = 500
            content.addArrangedSubview(who)
            content.addArrangedSubview(spacer(6))
            let out = accountButton(icon: "rectangle.portrait.and.arrow.right", title: "로그아웃", tint: Theme.fgDim) {
                SupabaseAuth.shared.signOut()
            }
            content.addArrangedSubview(NSStackView(views: [out]))
        } else {
            let btn = accountButton(icon: "person.crop.circle.badge.checkmark",
                                    title: t("account.continueGithub"), tint: Theme.fg) { [weak self] in
                SupabaseAuth.shared.signInWithGitHub { result in
                    DispatchQueue.main.async {
                        if case .failure(let e) = result, self?.activeTab == 3 {
                            self?.accountError = e.localizedDescription; self?.showTab(3)
                        }
                        // success is handled by the .rivenAuthChanged observer
                    }
                }
            }
            content.addArrangedSubview(NSStackView(views: [btn]))
            if let msg = accountError {
                let e = NSTextField(labelWithString: "로그인 실패: \(msg)")
                e.font = .systemFont(ofSize: 11); e.textColor = Theme.danger
                e.lineBreakMode = .byWordWrapping; e.maximumNumberOfLines = 3; e.preferredMaxLayoutWidth = 500
                content.addArrangedSubview(e)
            }
        }
        let sync = NSTextField(labelWithString: "API 키 등 민감한 값은 동기화되지 않고 이 기기에만 저장됩니다.")
        sync.font = .systemFont(ofSize: 11); sync.textColor = Theme.fgDim
        content.addArrangedSubview(spacer(4)); content.addArrangedSubview(sync)
    }

    // A rounded icon+label button (NSButton's built-in image/title spacing overflowed).
    private func accountButton(icon: String, title: String, tint: NSColor, _ action: @escaping () -> Void) -> NSView {
        let iv = NSImageView()
        iv.image = NSImage(systemSymbolName: icon, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        iv.contentTintColor = tint; iv.translatesAutoresizingMaskIntoConstraints = false
        let lbl = NSTextField(labelWithString: title)
        lbl.font = .systemFont(ofSize: 13); lbl.textColor = tint
        lbl.translatesAutoresizingMaskIntoConstraints = false
        let box = ClickBox(action)
        box.wantsLayer = true
        box.layer?.backgroundColor = Theme.hover.cgColor; box.layer?.cornerRadius = 8
        box.layer?.borderWidth = 1; box.layer?.borderColor = Theme.edge.cgColor
        box.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(iv); box.addSubview(lbl)
        NSLayoutConstraint.activate([
            box.heightAnchor.constraint(equalToConstant: 34),
            iv.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
            iv.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            lbl.leadingAnchor.constraint(equalTo: iv.trailingAnchor, constant: 8),
            lbl.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            lbl.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
        ])
        return box
    }

    // ---- About tab — version + update check (riven's AboutTab/electron-updater) ----
    private func buildAbout() {
        content.addArrangedSubview(spacer(6))
        let name = NSTextField(labelWithString: "riven")
        name.font = .systemFont(ofSize: 22, weight: .semibold); name.textColor = Theme.fg
        content.addArrangedSubview(name)
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.1"
        let verL = NSTextField(labelWithString: "v\(ver)")
        verL.font = .monospacedSystemFont(ofSize: 12, weight: .regular); verL.textColor = Theme.fgDim
        content.addArrangedSubview(verL)
        let tag = NSTextField(labelWithString: t("about.tagline"))
        tag.font = .systemFont(ofSize: 12); tag.textColor = Theme.fgDim
        content.addArrangedSubview(tag)
        content.addArrangedSubview(spacer(8))

        addSection(t("about.update"))
        // 탭을 다시 그릴 때도 실제 진행 상태를 따른다 (창을 닫았다 열면 "확인 중…"이 남던 문제).
        updateStatusLabel = NSTextField(labelWithString: Updater.shared.isChecking ? t("about.checking") : t("about.checkHint"))
        updateStatusLabel.font = .systemFont(ofSize: 12); updateStatusLabel.textColor = Theme.fgDim
        content.addArrangedSubview(updateStatusLabel)
        content.addArrangedSubview(spacer(4))
        content.addArrangedSubview(primaryButton(t("about.check"), #selector(checkUpdate)))

        content.addArrangedSubview(spacer(8))
        addSection(t("about.links"))
        let landing = secondaryButton(t("about.landing"), symbol: "safari") {
            if let u = URL(string: "https://riven-sandy.vercel.app/") { NSWorkspace.shared.open(u) }
        }
        let gh = secondaryButton(t("about.github"), symbol: "chevron.left.forwardslash.chevron.right") {
            if let u = URL(string: "https://github.com/wassupss/riven") { NSWorkspace.shared.open(u) }
        }
        let row = NSStackView(views: [landing, gh]); row.orientation = .horizontal; row.spacing = 8
        content.addArrangedSubview(row)
    }
    // A dark, theme-aware secondary button (void state is NOT white).
    private func secondaryButton(_ title: String, symbol: String? = nil, _ handler: @escaping () -> Void) -> PadButton {
        let img = symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }
        let b = PadButton(title: title, font: .systemFont(ofSize: 12),
                          textColor: Theme.fg, bg: Theme.bg3, border: Theme.edge, radius: 7, hPad: 12, height: 28,
                          icon: img)
        b.onClick = handler
        return b
    }
    private var updateStatusLabel: NSTextField!
    // Sparkle이 자체 UI(최신 버전/다운로드-설치 흐름)를 보여주므로 결과 텍스트는 여기서 세팅하지 않는다.
    // 대신 확인이 끝나는 모든 경로(최신 · 업데이트 발견 · 실패 · 사용자가 창을 닫음)에서
    // Updater가 알려주면 라벨을 유휴 문구로 되돌린다 — "확인 중…"이 영영 남지 않도록.
    @objc private func checkUpdate() {
        updateStatusLabel.stringValue = t("about.checking"); updateStatusLabel.textColor = Theme.fgDim
        // Sparkle의 업데이트 창은 평범한 창이라, floating 패널인 설정 창에 가려 뒤에 뜬다.
        // 업데이트 흐름(확인 → 다운로드 → 설치) 동안에는 floating을 내려 두고, 설정 창을
        // 닫을 때 되돌린다. (확인이 끝나는 시점에 바로 되돌리면 다운로드 창이 다시 가려진다.)
        setFloating(false)
        Updater.shared.onCheckFinished = { [weak self] in self?.syncUpdateStatus() }
        Updater.shared.checkForUpdates(self)
    }

    // floating(항상 위) 토글 — 업데이트 창이 뒤로 숨지 않게 잠시 내렸다가 되돌린다.
    private func setFloating(_ on: Bool) {
        isFloatingPanel = on
        level = on ? .floating : .normal
    }
    override func close() { setFloating(true); super.close() }
    override func orderOut(_ sender: Any?) { setFloating(true); super.orderOut(sender) }
    private func syncUpdateStatus() {
        guard let l = updateStatusLabel else { return }
        l.stringValue = Updater.shared.isChecking ? t("about.checking") : t("about.checkHint")
        l.textColor = Theme.fgDim
    }
    // 설정 창을 닫았다 다시 열어도(창은 재사용된다) 라벨이 실제 상태를 따르게 한다.
    override func becomeKey() {
        super.becomeKey()
        if activeTab == 4 { syncUpdateStatus() }
    }

    // ---- shared builders ----
    private func addSection(_ t: String) {
        content.addArrangedSubview(spacer(8))
        content.addArrangedSubview(sectionLabel(t))
    }
    private func sectionLabel(_ t: String) -> NSView {
        let l = NSTextField(labelWithString: t)
        l.font = .systemFont(ofSize: 11, weight: .semibold); l.textColor = Theme.fgDim
        return l
    }
    private func spacer(_ h: CGFloat) -> NSView {
        let v = NSView(); v.translatesAutoresizingMaskIntoConstraints = false
        v.heightAnchor.constraint(equalToConstant: h).isActive = true
        return v
    }
    private func setRow(_ label: String, _ control: NSView) -> NSView {
        let l = NSTextField(labelWithString: label)
        l.font = .systemFont(ofSize: 13); l.textColor = Theme.fgDim
        l.translatesAutoresizingMaskIntoConstraints = false
        l.widthAnchor.constraint(equalToConstant: 76).isActive = true
        control.translatesAutoresizingMaskIntoConstraints = false
        let h = NSStackView(views: [l, control]); h.orientation = .horizontal; h.spacing = 10; h.alignment = .centerY
        h.translatesAutoresizingMaskIntoConstraints = false
        h.heightAnchor.constraint(equalToConstant: 26).isActive = true
        return h
    }
    private func field(_ tf: NSTextField, width: CGFloat = 300) -> NSTextField {
        // Vertically center the text (single-line inputs otherwise sit at the top).
        if !(tf is NSSecureTextField) {
            let val = tf.stringValue
            let cell = VCenterTextFieldCell(textCell: val)
            cell.isEditable = true; cell.isSelectable = true; cell.isScrollable = true
            cell.usesSingleLineMode = true; cell.wraps = false; cell.isBezeled = false
            tf.cell = cell; tf.stringValue = val
        }
        tf.font = .systemFont(ofSize: 12); tf.textColor = Theme.fg
        tf.backgroundColor = Theme.isLight ? Theme.bg : Theme.bg3
        tf.drawsBackground = true
        tf.isBordered = false
        tf.wantsLayer = true
        tf.layer?.cornerRadius = 5
        tf.layer?.borderWidth = 1
        tf.layer?.borderColor = Theme.edge.cgColor
        tf.focusRingType = .none
        tf.translatesAutoresizingMaskIntoConstraints = false
        tf.widthAnchor.constraint(equalToConstant: width).isActive = true
        tf.heightAnchor.constraint(equalToConstant: 22).isActive = true   // compact (riven .set-num)
        return tf
    }
    private func primaryButton(_ title: String, _ action: Selector) -> NSView {
        let b = PadButton(title: title, font: .systemFont(ofSize: 13, weight: .semibold),
            textColor: Theme.isLight ? .white : Theme.hex(Theme.current.bg),
            bg: Theme.accent, border: .clear, radius: 7, hPad: 16, height: 30)
        b.onClick = { [weak self] in _ = self?.perform(action) }
        // Left-align (a button row is a leading-aligned single control).
        let wrap = NSStackView(views: [b]); wrap.orientation = .horizontal
        return wrap
    }
}

// 설정 창도 라이브 테마 전환을 따라간다. 창 자체 크롬(배경 · 헤어라인 · 유리 테두리)은
// init에서 한 번만 칠해지므로 여기서 다시 넣어주고, 본문은 현재 탭을 다시 그려 갱신한다.
extension SettingsWindow: Themable {
    func applyTheme() {
        appearance = NSAppearance(named: Theme.isLight ? .aqua : .darkAqua)
        backgroundColor = .clear                     // installGlass가 투명 배경 + 블러를 쓴다
        rootView?.layer?.backgroundColor = Theme.bg2.withAlphaComponent(0.72).cgColor
        rootView?.layer?.borderColor = Theme.edge.cgColor
        titleLabel?.textColor = Theme.fg
        closeBtn?.contentTintColor = Theme.fgDim
        closeBtn?.layer?.backgroundColor = Theme.hover.cgColor
        hair.layer?.backgroundColor = Theme.hairline.cgColor
        showTab(activeTab)                           // 탭 라벨/밑줄 + 본문 컨트롤 색 재생성
    }
}

// A rounded container that fires an action when clicked (used for the account
// icon+label buttons, where NSButton's image/title spacing overflowed).
private final class ClickBox: NSView {
    private let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func mouseDown(with event: NSEvent) { action() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}
