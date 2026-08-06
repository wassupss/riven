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
    private var steppers: [String: NSStepper] = [:]
    private var fontPickers: [String: NSPopUpButton] = [:]
    private let editorPreview = NSTextField(labelWithString: "")
    private let terminalPreview = NSTextField(labelWithString: "")
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
    private let crashReports = NSButton(checkboxWithTitle: "크래시 리포트 전송 (익명)", target: nil, action: nil)
    private let formatOnSave = NSButton(checkboxWithTitle: "저장 시 자동 포맷", target: nil, action: nil)
    private let agentNative = NSButton(checkboxWithTitle: "AI 에이전트를 네이티브 UI로 열기 (⌘O, 끄면 CLI 터미널)", target: nil, action: nil)
    private var swatches: [NSView] = []
    // 라이브 테마 전환에서 다시 칠해야 하는 창 자체의 크롬 (배경 · 제목 · 닫기 · 헤어라인).
    private var rootView: NSView!
    private var titleLabel: NSTextField!
    private var closeBtn: NSButton!
    private let hair = NSView()

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 640, height: 720),
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
        titleLabel.font = UIScale.font(UIScale.title, .semibold)
        titleLabel.textColor = Theme.fg
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        self.titleLabel = titleLabel
        header.addSubview(titleLabel)
        let closeBtn = NSButton(title: t("common.close"), target: self, action: #selector(closeSettings))
        self.closeBtn = closeBtn
        closeBtn.isBordered = false; closeBtn.font = UIScale.font(UIScale.small)
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
        b.font = UIScale.font(UIScale.title, .medium)
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

        addSection(t("settings.appearance"))
        let langSeg = NSSegmentedControl(labels: ["한국어", "English"], trackingMode: .selectOne,
                                         target: self, action: #selector(changeLanguage(_:)))
        langSeg.selectedSegment = (I18n.current == .en) ? 1 : 0
        addRow("언어 / Language", desc: t("settings.languageDesc"), langSeg)

        // 전체 크기 (⌘+ / ⌘- / ⌘0 과 같은 것). 단축키를 모르면 조절할 방법이 없었다.
        let zoomSeg = NSSegmentedControl(labels: ["−", "\(Int(UIScale.factor * 100))%", "+"],
                                         trackingMode: .momentary,
                                         target: self, action: #selector(changeZoom(_:)))
        zoomSeg.setWidth(34, forSegment: 0)
        zoomSeg.setWidth(56, forSegment: 1)
        zoomSeg.setWidth(34, forSegment: 2)
        zoomSegment = zoomSeg
        addRow(t("settings.uiScale"), desc: t("settings.uiScaleDesc"), zoomSeg)

        // 테마는 이름만 늘어놓으면 뭘 고르는지 모른다 — 색 점이 붙은 격자로 보여 준다.
        swatches = []
        let grid = NSGridView()
        grid.rowSpacing = 6; grid.columnSpacing = 6
        grid.translatesAutoresizingMaskIntoConstraints = false
        var row: [NSView] = []
        for def in Theme.all {
            row.append(themeSwatch(def))
            if row.count == 3 { grid.addRow(with: row); row = [] }
        }
        if !row.isEmpty {
            while row.count < 3 { row.append(NSView()) }
            grid.addRow(with: row)
        }
        for c in 0..<3 { grid.column(at: c).xPlacement = .fill }
        addWideRow(grid)

        addSection(t("settings.editor"))
        editorSize.stringValue = String(s.int("editorFontSize", 13))
        addRow(t("settings.fontSize"), desc: nil, sizeControl(editorSize, key: "editorFontSize"))
        addRow(t("settings.fontFamily"), desc: t("settings.fontFamilyDesc"),
               fontMenu(key: "editorFontFamily", preview: editorPreview))
        addWideRow(editorPreview)
        formatOnSave.title = ""
        formatOnSave.state = s.bool("formatOnSave", false) ? .on : .off
        formatOnSave.target = self; formatOnSave.action = #selector(saveFormatOnSave)
        formatOnSave.contentTintColor = Theme.fg
        addRow(t("settings.formatOnSave"), desc: t("settings.formatOnSaveDesc"), formatOnSave)

        addSection(t("settings.terminal"))
        terminalSize.stringValue = String(s.int("terminalFontSize", 13))
        addRow(t("settings.fontSize"), desc: nil, sizeControl(terminalSize, key: "terminalFontSize"))
        addRow(t("settings.fontFamily"), desc: nil, fontMenu(key: "terminalFontFamily", preview: terminalPreview))
        addWideRow(terminalPreview)
        // 이미 ghostty 를 쓰던 사람은 글꼴·크기를 이미 맞춰 뒀다. 다시 고르게 하지 않는다.
        let (ghosttyBtn, ghosttyStatus) = ghosttyControls()
        addRow(t("settings.ghostty"), desc: ghosttyStatus.stringValue, ghosttyBtn)
        ghosttyStatusLabel = ghosttyStatus

        addSection(t("settings.notifications"))
        notify.title = ""
        notify.state = s.bool("notifications", true) ? .on : .off
        notify.target = self; notify.action = #selector(saveNotify)
        notify.contentTintColor = Theme.fg
        addRow(t("settings.notifyTitle"), desc: t("settings.notifyDesc"), notify)

        crashReports.title = ""
        crashReports.state = s.bool("crashReporting", true) ? .on : .off
        crashReports.target = self; crashReports.action = #selector(saveCrashReports)
        crashReports.contentTintColor = Theme.fg
        addRow(t("settings.crashTitle"), desc: t("settings.crashReports"), crashReports)

        content.addArrangedSubview(spacer(12))
    }
    private func newWrapRow() -> NSStackView {
        let r = NSStackView(); r.orientation = .horizontal; r.spacing = 8; r.alignment = .centerY
        r.distribution = .fill
        return r
    }
    private func themeSwatch(_ def: ThemeDef) -> NSView {
        let active = def.id == Theme.current.id
        let b = PadButton(title: def.name, font: UIScale.font(UIScale.title), textColor: Theme.fg,
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
    @objc private func saveCrashReports() { Settings.shared.set("crashReporting", crashReports.state == .on) }
    @objc private func saveFormatOnSave() {
        Settings.shared.set("formatOnSave", formatOnSave.state == .on)
        NotificationCenter.default.post(name: .rivenFormatOnSaveChanged, object: nil)
    }
    @objc private func saveAgentUI() { Settings.shared.set("agentUI", agentNative.state == .on ? "native" : "cli") }
    @objc private func changeLanguage(_ seg: NSSegmentedControl) {
        I18n.setLanguage(seg.selectedSegment == 1 ? .en : .ko)
    }
    // 폰트 크기 입력칸 — 엔터를 치거나 포커스를 잃는 순간 바로 저장 + 적용된다.
    // (예전에는 "저장" 버튼을 눌러야 값이 들어갔고, 그마저도 읽는 쪽이 없어 재시작해도
    //  반영되지 않았다.)
    // 크기: 숫자칸 + 스테퍼. 숫자만 있으면 몇까지 되는지도 모르고 한 칸씩 올리기도 번거롭다.
    private func sizeControl(_ tf: NSTextField, key: String) -> NSView {
        let f = fontField(tf)
        f.widthAnchor.constraint(equalToConstant: 56).isActive = true
        let stepper = NSStepper()
        stepper.minValue = 8; stepper.maxValue = 32; stepper.increment = 1
        stepper.integerValue = Settings.shared.int(key, 13)
        stepper.valueWraps = false
        stepper.target = self; stepper.action = #selector(stepperChanged(_:))
        stepper.identifier = NSUserInterfaceItemIdentifier(key)
        stepper.translatesAutoresizingMaskIntoConstraints = false
        steppers[key] = stepper
        let hint = NSTextField(labelWithString: "8–32")
        hint.font = UIScale.font(UIScale.caption); hint.textColor = Theme.fgDim
        let row = NSStackView(views: [f, stepper, hint])
        row.orientation = .horizontal; row.spacing = 6; row.alignment = .centerY
        return row
    }
    @objc private func stepperChanged(_ s: NSStepper) {
        guard let key = s.identifier?.rawValue else { return }
        let field = key == "editorFontSize" ? editorSize : terminalSize
        field.stringValue = String(s.integerValue)
        saveFonts()
    }

    /// 글꼴 고르기. 목록은 고정폭 글꼴만 — 에디터·터미널에 비고정폭을 고르면 칸이 어긋난다.
    private func fontMenu(key: String, preview: NSTextField) -> NSView {
        let pop = NSPopUpButton()
        pop.translatesAutoresizingMaskIntoConstraints = false
        pop.widthAnchor.constraint(equalToConstant: 220).isActive = true
        let current = Settings.shared.string(key, "")
        pop.addItem(withTitle: t("settings.fontDefault"))
        pop.menu?.addItem(.separator())
        for name in SettingsWindow.monoFonts { pop.addItem(withTitle: name) }
        pop.selectItem(withTitle: current.isEmpty ? t("settings.fontDefault") : current)
        pop.target = self; pop.action = #selector(fontPicked(_:))
        pop.identifier = NSUserInterfaceItemIdentifier(key)
        fontPickers[key] = pop
        updatePreview(preview, key: key)
        return pop
    }
    @objc private func fontPicked(_ p: NSPopUpButton) {
        guard let key = p.identifier?.rawValue else { return }
        let name = p.titleOfSelectedItem ?? ""
        Settings.shared.set(key, name == t("settings.fontDefault") ? "" : name)
        NotificationCenter.default.post(name: .rivenFontSizeChanged, object: nil)
        updatePreview(key == "editorFontSize" || key == "editorFontFamily" ? editorPreview : terminalPreview, key: key)
    }
    /// 고른 글꼴·크기가 실제로 어떻게 보이는지 그 자리에서 보여 준다.
    private func updatePreview(_ label: NSTextField, key: String) {
        let isEditor = key.hasPrefix("editor")
        let size = CGFloat(Settings.shared.int(isEditor ? "editorFontSize" : "terminalFontSize", 13))
        let family = Settings.shared.string(isEditor ? "editorFontFamily" : "terminalFontFamily", "")
        label.font = (family.isEmpty ? nil : NSFont(name: family, size: size))
            ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
        label.stringValue = "riven — let x = 1; 한글 0O l1 {}"
        label.textColor = Theme.fg
        label.lineBreakMode = .byTruncatingTail
    }
    /// 시스템에 깔린 고정폭 글꼴 (한 번만 훑는다 — 폰트 목록 조회는 느리다).
    static let monoFonts: [String] = {
        let all = NSFontManager.shared.availableFontFamilies
        return all.filter { fam in
            guard let f = NSFont(name: fam, size: 12) else { return false }
            return f.isFixedPitch
        }.sorted()
    }()

    private weak var zoomSegment: NSSegmentedControl?
    @objc private func changeZoom(_ seg: NSSegmentedControl) {
        let app = NSApp.delegate as? AppDelegate
        switch seg.selectedSegment {
        case 0: app?.zoomFromSettings(-1)
        case 2: app?.zoomFromSettings(+1)
        default: app?.zoomFromSettings(0)      // 가운데(현재 %)를 누르면 100% 로
        }
        seg.setLabel("\(Int(UIScale.factor * 100))%", forSegment: 1)
    }

    private var ghosttyStatusLabel: NSTextField?
    /// ghostty 설정 가져오기 (버튼 + 상태 문구).
    private func ghosttyControls() -> (NSView, NSTextField) {
        let found = GhosttyImport.read()
        let btn = PadButton(title: t("settings.ghosttyImport"), font: UIScale.font(UIScale.small, .medium),
                            textColor: found == nil ? Theme.fgDim : Theme.fg,
                            bg: Theme.hover, border: Theme.edge, radius: 6, hPad: 10, height: 24)
        let status = NSTextField(labelWithString: found.map { $0.summary } ?? t("settings.ghosttyNone"))
        btn.onClick = { [weak self] in
            guard let f = GhosttyImport.read() else { return }
            _ = GhosttyImport.apply(f)
            self?.showTab(0)
        }
        return (btn, status)
    }

    /// (예전 형태 — 더 쓰지 않는다)
    private func ghosttyRow() -> NSView {
        let found = GhosttyImport.read()
        let btn = PadButton(title: t("settings.ghosttyImport"), font: UIScale.font(UIScale.small, .medium),
                            textColor: found == nil ? Theme.fgDim : Theme.fg,
                            bg: Theme.hover, border: Theme.edge, radius: 6, hPad: 10, height: 24)
        let status = NSTextField(labelWithString: found.map { $0.summary } ?? t("settings.ghosttyNone"))
        status.font = UIScale.font(UIScale.caption); status.textColor = Theme.fgDim
        status.lineBreakMode = .byTruncatingMiddle
        btn.onClick = { [weak self, weak status] in
            guard let f = GhosttyImport.read() else { status?.stringValue = t("settings.ghosttyNone"); return }
            let msg = GhosttyImport.apply(f)
            status?.stringValue = msg
            self?.showTab(0)      // 미리보기·크기 칸을 새 값으로 다시 그린다
        }
        let row = NSStackView(views: [btn, status])
        row.orientation = NSUserInterfaceLayoutOrientation.horizontal
        row.spacing = 10; row.alignment = .centerY
        return row
    }

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
        steppers["editorFontSize"]?.integerValue = ed
        steppers["terminalFontSize"]?.integerValue = tm
        updatePreview(editorPreview, key: "editorFontFamily")
        updatePreview(terminalPreview, key: "terminalFontFamily")
        // 에디터(Monaco)와 터미널(ghostty)이 각자 구독해서 즉시 반영한다.
        NotificationCenter.default.post(name: .rivenFontSizeChanged, object: nil)
    }

    // ---- AI tab ----
    private func buildAI() {
        let s = Settings.shared
        addSection(t("settings.aiSection"))
        aiEnable.title = ""
        aiEnable.state = s.bool("aiComplete", false) ? .on : .off
        aiEnable.target = self; aiEnable.action = #selector(saveAI)
        aiEnable.contentTintColor = Theme.fg
        addRow(t("settings.aiComplete"), desc: t("settings.aiCompleteDesc"), aiEnable)

        agentNative.title = ""
        agentNative.state = s.string("agentUI", "native") == "native" ? .on : .off
        agentNative.target = self; agentNative.action = #selector(saveAgentUI)
        agentNative.contentTintColor = Theme.fg
        addRow(t("settings.agentNative"), desc: t("settings.agentNativeDesc"), agentNative)

        provider.removeAllItems()
        let providers = ["ollama", "openai", "anthropic", "gemini", "deepseek", "mistral", "groq", "openrouter", "custom"]
        provider.addItems(withTitles: providers)
        provider.selectItem(withTitle: s.string("aiProvider", "ollama"))
        provider.target = self; provider.action = #selector(saveAI)
        provider.translatesAutoresizingMaskIntoConstraints = false
        provider.widthAnchor.constraint(equalToConstant: 160).isActive = true
        addRow("제공자", desc: nil, provider)

        model.stringValue = s.string("aiCompleteModel", "qwen2.5-coder:1.5b")
        addRow("모델", desc: nil, field(model, width: 260))
        endpoint.stringValue = s.string("aiCompleteEndpoint", "http://localhost:11434")
        addRow("엔드포인트", desc: nil, field(endpoint, width: 260))
        apiKey.stringValue = s.string("aiApiKey", "")
        addRow("API 키", desc: t("settings.apiKeyDesc"), field(apiKey, width: 260))

        content.addArrangedSubview(spacer(10))
        content.addArrangedSubview(primaryButton(t("settings.saveAI"), #selector(saveAIAll)))

        // Snippets — prefix expands to body (${1} tab stops) via Monaco completion.
        addSection(t("settings.snippets"))
        let hint = NSTextField(labelWithString: t("settings.snippetsHint"))
        hint.font = UIScale.font(UIScale.small); hint.textColor = Theme.fgDim
        hint.lineBreakMode = .byWordWrapping; hint.preferredMaxLayoutWidth = 500
        content.addArrangedSubview(hint)
        let snips = (Settings.shared.object("snippets") as? [String: String]) ?? [:]
        for (prefix, body) in snips.sorted(by: { $0.key < $1.key }) {
            let l = NSTextField(labelWithString: "\(prefix)  →  \(body.replacingOccurrences(of: "\n", with: "⏎"))")
            l.font = UIScale.mono(UIScale.small, .regular); l.textColor = Theme.fgDim
            l.lineBreakMode = .byTruncatingTail
            let del = PadButton(title: "삭제", font: UIScale.font(UIScale.small), textColor: Theme.danger,
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
            let b = PadButton(title: n, font: UIScale.font(UIScale.body, .medium),
                textColor: on ? Theme.accent : Theme.fgDim, bg: on ? Theme.accentMuted : Theme.hover,
                border: on ? Theme.accentBorder : Theme.edge, radius: 6, hPad: 12, height: 26)
            b.onClick = { [weak self] in self?.kbSubtab = i; self?.showTab(2) }
            row.addArrangedSubview(b)
        }
        content.addArrangedSubview(row)
        content.addArrangedSubview(spacer(6))

        let hint = NSTextField(labelWithString: "칩을 클릭하고 원하는 키를 누르세요. Esc로 취소.")
        hint.font = UIScale.font(UIScale.small); hint.textColor = Theme.fgDim
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
        l.font = UIScale.font(UIScale.title); l.textColor = Theme.fg
        l.translatesAutoresizingMaskIntoConstraints = false
        let chip = PadButton(title: Keys.display(Keys.effective(action.id)),
                             font: UIScale.mono(UIScale.small, .medium),
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
            let b = PadButton(title: editorPresets[id]!, font: UIScale.font(UIScale.body),
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
        l.font = UIScale.font(UIScale.title); l.textColor = Theme.fg
        l.translatesAutoresizingMaskIntoConstraints = false
        let cap = NSTextField(labelWithString: chord)
        cap.font = UIScale.mono(UIScale.small, .medium)
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
        addNote("riven 계정에 로그인하면 테마·폰트·키맵 등 설정이 클라우드에 저장되어 기기 간에 동기화됩니다. (GitHub OAuth · Supabase)")

        if !SupabaseConfig.isConfigured {
            addNote("Supabase 미구성: 이 네이티브 빌드에는 riven 계정 백엔드가 아직 연결되어 있지 않습니다.",
                    color: Theme.warning)
            addNote("API 키 등 민감한 값은 동기화되지 않고 이 기기에만 저장됩니다.")
            return
        }

        if SupabaseAuth.shared.isSignedIn {
            let who = NSTextField(labelWithString: "✓ \(SupabaseAuth.shared.email ?? "로그인됨") · 설정이 이 계정에 동기화됩니다.")
            who.font = UIScale.font(UIScale.body); who.textColor = Theme.success
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
                e.font = UIScale.font(UIScale.small); e.textColor = Theme.danger
                e.lineBreakMode = .byWordWrapping; e.maximumNumberOfLines = 3; e.preferredMaxLayoutWidth = 500
                content.addArrangedSubview(e)
            }
        }
        let sync = NSTextField(labelWithString: "API 키 등 민감한 값은 동기화되지 않고 이 기기에만 저장됩니다.")
        sync.font = UIScale.font(UIScale.small); sync.textColor = Theme.fgDim
        content.addArrangedSubview(spacer(4)); content.addArrangedSubview(sync)
    }

    // A rounded icon+label button (NSButton's built-in image/title spacing overflowed).
    private func accountButton(icon: String, title: String, tint: NSColor, _ action: @escaping () -> Void) -> NSView {
        let iv = NSImageView()
        iv.image = NSImage(systemSymbolName: icon, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        iv.contentTintColor = tint; iv.translatesAutoresizingMaskIntoConstraints = false
        let lbl = NSTextField(labelWithString: title)
        lbl.font = UIScale.font(UIScale.title); lbl.textColor = tint
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
        name.font = UIScale.font(22, .semibold); name.textColor = Theme.fg
        content.addArrangedSubview(name)
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.1"
        let verL = NSTextField(labelWithString: "v\(ver)")
        verL.font = UIScale.mono(UIScale.body, .regular); verL.textColor = Theme.fgDim
        content.addArrangedSubview(verL)
        let tag = NSTextField(labelWithString: t("about.tagline"))
        tag.font = UIScale.font(UIScale.body); tag.textColor = Theme.fgDim
        content.addArrangedSubview(tag)
        content.addArrangedSubview(spacer(8))

        addSection(t("about.update"))
        // 탭을 다시 그릴 때도 실제 진행 상태를 따른다 (창을 닫았다 열면 "확인 중…"이 남던 문제).
        updateStatusLabel = NSTextField(labelWithString: Updater.shared.isChecking ? t("about.checking") : t("about.checkHint"))
        updateStatusLabel.font = UIScale.font(UIScale.small); updateStatusLabel.textColor = Theme.fgDim
        updateStatusLabel.lineBreakMode = .byWordWrapping
        updateStatusLabel.maximumNumberOfLines = 2
        // 줄 이름과 버튼 글자가 같으면("업데이트 확인" ×2) 읽는 사람이 두 번 읽게 된다.
        addRow(t("about.currentVersion", ["v": ver]), desc: nil,
               primaryButton(t("about.check"), #selector(checkUpdate)))
        addWideRow(updateStatusLabel)

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
        let b = PadButton(title: title, font: UIScale.font(UIScale.body),
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
    /// 섹션 = 제목 + 카드 하나. 카드에 줄을 담고 줄 사이에 옅은 구분선을 둔다.
    ///
    /// 예전에는 컨트롤들이 배경 위에 그냥 떠 있었다 — 어디까지가 한 묶음인지 눈으로 알 수
    /// 없으니 "동떨어져" 보인다. 묶음을 그려 주는 것만으로 절반은 해결된다.
    private var currentCard: SettingsCard?
    private func addSection(_ t: String) {
        content.addArrangedSubview(spacer(10))
        content.addArrangedSubview(sectionLabel(t))
        content.addArrangedSubview(spacer(2))
        let card = SettingsCard()
        currentCard = card
        content.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
    }
    /// 지금 카드에 줄 하나. 왼쪽에 이름(+ 한 줄 설명), 오른쪽 끝에 컨트롤.
    private func addRow(_ label: String, desc: String? = nil, _ control: NSView) {
        currentCard?.addRow(label: label, desc: desc, control: control)
    }
    /// 카드 안의 설명 문단 (문장이 주인인 섹션 — 계정·정보).
    private func addNote(_ text: String, color: NSColor? = nil) {
        let l = NSTextField(labelWithString: text)
        l.font = UIScale.font(UIScale.small)
        l.textColor = color ?? Theme.fgDim
        l.lineBreakMode = .byWordWrapping
        l.maximumNumberOfLines = 5
        l.preferredMaxLayoutWidth = 540
        l.translatesAutoresizingMaskIntoConstraints = false
        l.widthAnchor.constraint(lessThanOrEqualToConstant: 540).isActive = true
        addWideRow(l)
    }

    /// 카드 폭을 통째로 쓰는 줄 (테마 격자·미리보기처럼 이름/컨트롤로 나뉘지 않는 것).
    private func addWideRow(_ view: NSView) {
        currentCard?.addWide(view)
    }
    private func sectionLabel(_ t: String) -> NSView {
        let l = NSTextField(labelWithString: t)
        l.font = UIScale.font(UIScale.small, .semibold); l.textColor = Theme.fgDim
        return l
    }
    private func spacer(_ h: CGFloat) -> NSView {
        let v = NSView(); v.translatesAutoresizingMaskIntoConstraints = false
        v.heightAnchor.constraint(equalToConstant: h).isActive = true
        return v
    }
    private func setRow(_ label: String, _ control: NSView) -> NSView {
        let l = NSTextField(labelWithString: label)
        l.font = UIScale.font(UIScale.title); l.textColor = Theme.fgDim
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
        tf.font = UIScale.font(UIScale.body); tf.textColor = Theme.fg
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
        let b = PadButton(title: title, font: UIScale.font(UIScale.title, .semibold),
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

// 설정 카드: 둥근 배경 + 줄 사이 구분선. 설정 화면이 "묶음"으로 읽히게 하는 그릇이다.
final class SettingsCard: NSView, Themable {
    private let stack = NSStackView()
    private var rows: [NSView] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        stack.orientation = .vertical
        stack.spacing = 0
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        Theme.register(self)
        applyTheme()
    }
    required init?(coder: NSCoder) { fatalError() }

    func addRow(label: String, desc: String?, control: NSView) {
        if !rows.isEmpty { addSeparator() }
        let name = NSTextField(labelWithString: label)
        name.font = UIScale.font(UIScale.body)
        name.textColor = Theme.fg
        name.translatesAutoresizingMaskIntoConstraints = false
        let left = NSStackView(views: [name])
        left.orientation = .vertical; left.alignment = .leading; left.spacing = 1
        if let desc, !desc.isEmpty {
            let d = NSTextField(labelWithString: desc)
            d.font = UIScale.font(UIScale.caption)
            d.textColor = Theme.fgDim
            d.lineBreakMode = .byWordWrapping
            d.maximumNumberOfLines = 2
            left.addArrangedSubview(d)
        }
        left.translatesAutoresizingMaskIntoConstraints = false
        control.translatesAutoresizingMaskIntoConstraints = false
        let row = NSView()
        row.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(left); row.addSubview(control)
        NSLayoutConstraint.activate([
            left.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
            left.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            left.trailingAnchor.constraint(lessThanOrEqualTo: control.leadingAnchor, constant: -12),
            // 컨트롤은 오른쪽 끝에 맞춘다 — 줄마다 제각각이면 눈이 기댈 선이 없다.
            control.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -12),
            control.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: UIScale.pt(38)),
            left.topAnchor.constraint(greaterThanOrEqualTo: row.topAnchor, constant: 7),
            left.bottomAnchor.constraint(lessThanOrEqualTo: row.bottomAnchor, constant: -7),
        ])
        add(row)
    }

    func addWide(_ view: NSView) {
        if !rows.isEmpty { addSeparator() }
        view.translatesAutoresizingMaskIntoConstraints = false
        let row = NSView()
        row.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12),
            view.trailingAnchor.constraint(lessThanOrEqualTo: row.trailingAnchor, constant: -12),
            view.topAnchor.constraint(equalTo: row.topAnchor, constant: 10),
            view.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -10),
        ])
        add(row)
    }

    private func add(_ row: NSView) {
        stack.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        rows.append(row)
    }
    private func addSeparator() {
        let line = NSView()
        line.wantsLayer = true
        line.layer?.backgroundColor = Theme.hairline.cgColor
        line.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(line)
        NSLayoutConstraint.activate([
            line.heightAnchor.constraint(equalToConstant: 1),
            line.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    func applyTheme() {
        layer?.cornerRadius = UIScale.pt(8)
        layer?.backgroundColor = Theme.bg3.cgColor
        layer?.borderWidth = 1
        layer?.borderColor = Theme.hairline.cgColor
    }
}
