import AppKit

// Settings modal - a native port of riven's SettingsModal. A 560-wide panel with a
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
    private let fixedPromptView = HintTextView()   // 전역 고정 프롬프트 편집기 (AI 탭)
    private var authObserver: Any?
    private var settingObserver: Any?
    /// 사용자가 고른 것이 아니라 앱이 알아서 적는 키들 - 여기에 "저장됨" 을 띄우면 거짓말이다.
    private static let silentKeys: Set<String> = ["session", "sidebarWidth", "railHeight",
                                                  "railCollapsed", "browserTabs", "browserZooms",
                                                  "browserActiveTab", "lastSeenVersion", "installId",
                                                  "syncLocalStamp"]          // .rivenAuthChanged → refresh the Account tab
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
    private let autoUpdate = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private let tabSizeField = NSTextField()
    private let wordWrap = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private let minimap = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private let ligatures = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private let agentNative = NSButton(checkboxWithTitle: "AI 에이전트를 네이티브 UI로 열기 (⌘O, 끄면 CLI 터미널)", target: nil, action: nil)
    private var swatches: [NSView] = []
    // 라이브 테마 전환에서 다시 칠해야 하는 창 자체의 크롬 (배경 · 제목 · 닫기 · 헤어라인).
    private var rootView: NSView!
    private let savedLabel = NSTextField(labelWithString: "")
    private var savedTimer: Timer?
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
        // riven's settings is an in-app overlay with NO traffic lights - hide them so
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
        titleLabel.font = UIScale.font(UIScale.small, .semibold)
        titleLabel.textColor = Theme.fg
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        self.titleLabel = titleLabel
        header.addSubview(titleLabel)
        // 바뀌었다는 신호. 설정은 누르는 즉시 저장되는데 화면이 아무 말도 하지 않으면,
        // 정말 저장된 건지 확인할 방법이 없다 (되돌아가 다시 눌러 보게 된다).
        savedLabel.font = UIScale.font(UIScale.small, .medium)
        savedLabel.textColor = Theme.success
        savedLabel.alphaValue = 0
        savedLabel.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(savedLabel)
        let closeBtn = NSButton(title: t("common.close"), target: self, action: #selector(closeSettings))
        self.closeBtn = closeBtn
        closeBtn.isBordered = false; closeBtn.font = UIScale.font(UIScale.small)
        closeBtn.contentTintColor = Theme.fgDim
        closeBtn.wantsLayer = true; closeBtn.layer?.backgroundColor = Theme.hover.cgColor
        closeBtn.layer?.cornerRadius = 6
        closeBtn.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(closeBtn)
        NSLayoutConstraint.activate([
            savedLabel.leadingAnchor.constraint(equalTo: titleLabel.trailingAnchor, constant: 10),
            savedLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            savedLabel.trailingAnchor.constraint(lessThanOrEqualTo: closeBtn.leadingAnchor, constant: -10),
            closeBtn.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            closeBtn.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            closeBtn.heightAnchor.constraint(equalToConstant: 22),
            closeBtn.widthAnchor.constraint(equalToConstant: 44)
        ])

        // 왼쪽 목록 + 오른쪽 내용 (macOS 설정 방식). 위쪽 탭 줄은 항목이 늘어날수록 좁아지고,
        // 넓은 창에서 오른쪽이 통째로 비어 "동떨어져" 보였다. 목록을 왼쪽에 세우면 지금 어디에
        // 있는지가 늘 보이고, 오른쪽은 내용에 온전히 쓴다.
        let sidebar = NSView()
        sidebar.wantsLayer = true
        sidebar.layer?.backgroundColor = Theme.bg2.cgColor
        navSidebar = sidebar
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        let navStack = NSStackView()
        navStack.orientation = .vertical; navStack.alignment = .leading; navStack.spacing = 2
        navStack.translatesAutoresizingMaskIntoConstraints = false
        for (i, label) in tabs.enumerated() {
            let b = makeNavItem(label, symbol: SettingsWindow.tabSymbols[i], index: i)
            tabButtons.append(b)
            navStack.addArrangedSubview(b)
            b.widthAnchor.constraint(equalTo: navStack.widthAnchor).isActive = true
        }
        sidebar.addSubview(navStack)
        let sideHair = NSView()
        sideHair.wantsLayer = true; sideHair.layer?.backgroundColor = Theme.hairline.cgColor
        navSideHair = sideHair
        sideHair.translatesAutoresizingMaskIntoConstraints = false
        sidebar.addSubview(sideHair)

        // Scrollable content.
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 0
        content.edgeInsets = NSEdgeInsets(top: 12, left: 0, bottom: 24, right: 0)
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = content
        scroll.hasVerticalScroller = true
        // "스크롤 막대 항상 표시" 로 설정된 맥에서는 세로 스크롤러가 폭을 먹는데, 문서 폭을
        // 클립 뷰(scroll.contentView)에 묶어 두면 딱 맞아 가로 스크롤이 생기지 않는다. 가로
        // 스크롤러 자체도 꺼서 어떤 경우에도 x축 막대가 뜨지 않게 한다.
        scroll.hasHorizontalScroller = false
        scroll.horizontalScrollElasticity = .none
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.automaticallyAdjustsContentInsets = false

        root.addSubview(header); root.addSubview(sidebar); root.addSubview(scroll)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            // 제목 줄은 창을 끄는 버튼 자리만큼만. "설정" 이라는 글자 하나가 44pt 를 통째로
            // 먹고 있었다 - 그만큼 내용이 아래로 밀렸다.
            header.heightAnchor.constraint(equalToConstant: 34),
            titleLabel.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
            titleLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),

            sidebar.topAnchor.constraint(equalTo: header.bottomAnchor),
            sidebar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            sidebar.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            sidebar.widthAnchor.constraint(equalToConstant: 168),
            navStack.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 10),
            navStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 8),
            navStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -8),
            sideHair.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            sideHair.topAnchor.constraint(equalTo: sidebar.topAnchor),
            sideHair.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor),
            sideHair.widthAnchor.constraint(equalToConstant: 1),

            scroll.topAnchor.constraint(equalTo: header.bottomAnchor),
            // 카드가 사이드바·창 가장자리에 딱 붙지 않도록 스크롤 뷰 자체를 안쪽으로 넣는다.
            // 스택의 폭 제약이나 edgeInsets 를 건드리면 서로 싸워서 화면이 통째로 비어 버린다
            // (하얗게·까맣게 두 번 겪었다). 이 방법은 안쪽 레이아웃을 전혀 건드리지 않는다.
            scroll.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: 18),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            content.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            content.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            content.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        ])
        contentView = root
        rootView = root
        installGlass(on: self, content: root, radius: 14)
        showTab(0)
        Theme.register(self)
        settingObserver = NotificationCenter.default.addObserver(
            forName: .rivenSettingChanged, object: nil, queue: .main) { [weak self] n in
            // 설정 창이 떠 있을 때만. 그리고 창 자신이 저장을 유발한 경우만 - 클라우드
            // 동기화 같은 배경 쓰기까지 "저장됨" 으로 보이면 신호가 거짓말이 된다.
            guard let self, self.isVisible else { return }
            let key = (n.object as? String) ?? ""
            guard !SettingsWindow.silentKeys.contains(key) else { return }
            self.flashSaved(t("settings.saved"), ok: true)
        }
        // Live language switch: relabel the tabs + re-render the active tab.
        langObserver = NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            let labels = self.tabs
            for (i, b) in self.tabButtons.enumerated() where i < labels.count { b.title = labels[i] }
            self.showTab(self.activeTab)
        }
    }

    static let tabSymbols = ["gearshape", "sparkles", "keyboard", "person.crop.circle", "info.circle"]

    /// 왼쪽 목록 한 줄. 선택되면 알약 배경 - 지금 어디에 있는지가 늘 보인다.
    private func makeNavItem(_ title: String, symbol: String, index: Int) -> NSButton {
        // 버튼의 image+title 을 그대로 쓰면 아이콘 글리프 폭에 따라 글자 시작점이 달라진다
        // (keyboard 는 넓고 info.circle 은 좁아서 "단축키" 만 밀려 보였다).
        // 아이콘은 고정 폭 칸에 넣고, 글자는 늘 같은 x 에서 시작하게 한다.
        let b = NSButton(title: "", target: self, action: #selector(tabClicked(_:)))
        b.tag = index
        b.isBordered = false
        b.wantsLayer = true
        b.layer?.cornerRadius = 6
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(equalToConstant: UIScale.pt(30)).isActive = true

        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        icon.image?.isTemplate = true
        icon.symbolConfiguration = .init(pointSize: UIScale.small, weight: .regular)
        icon.imageScaling = .scaleProportionallyDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        let label = NSTextField(labelWithString: title)
        label.font = UIScale.font(UIScale.body)
        label.translatesAutoresizingMaskIntoConstraints = false
        b.addSubview(icon); b.addSubview(label)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: 10),
            icon.centerYAnchor.constraint(equalTo: b.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 18),      // 고정 칸
            icon.heightAnchor.constraint(equalToConstant: 16),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            label.centerYAnchor.constraint(equalTo: b.centerYAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: b.trailingAnchor, constant: -8),
        ])
        navIcons[index] = icon
        navLabels[index] = label
        return b
    }
    /// 왼쪽 목록. applyTheme 이 showTab 으로 본문만 다시 그려서, 이 칸은 만들 때 색 그대로
    /// 남아 있었다 - 밝은 테마에서 왼쪽만 어둡고 글자가 배경에 묻혔다.
    private var navSidebar: NSView?
    private var navSideHair: NSView?
    private var navIcons: [Int: NSImageView] = [:]
    private var navLabels: [Int: NSTextField] = [:]

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
    private func styleNav() {
        for (i, b) in tabButtons.enumerated() {
            let on = i == activeTab
            b.layer?.backgroundColor = (on ? Theme.accentMuted : NSColor.clear).cgColor
            navIcons[i]?.contentTintColor = on ? Theme.accent : Theme.fgDim
            navLabels[i]?.textColor = on ? Theme.fg : Theme.fgDim
            navLabels[i]?.font = UIScale.font(UIScale.body, on ? .semibold : .regular)
        }
    }
    private func showTab(_ i: Int) {
        activeTab = i
        styleNav()
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

        // 테마는 이름만 늘어놓으면 뭘 고르는지 모른다 - 색 점이 붙은 격자로 보여 준다.
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
        // 미리보기 줄에 이름이 없으면 "왜 여기 코드 한 줄이 있지" 로 읽힌다 (버그로 보인다).
        addRow(t("settings.fontPreview"), desc: nil, previewChip())
        addWideRow(editorPreview)
        formatOnSave.title = ""
        formatOnSave.state = s.bool("formatOnSave", false) ? .on : .off
        formatOnSave.target = self; formatOnSave.action = #selector(saveFormatOnSave)
        formatOnSave.contentTintColor = Theme.fg
        addRow(t("settings.formatOnSave"), desc: t("settings.formatOnSaveDesc"), formatOnSave)

        // 여기까지가 예전에 고를 수 있던 전부였다. 탭 크기·줄바꿈·미니맵·합자는 editor.html
        // 에 못 박혀 있어서, VS Code 에서 가장 자주 만지는 네 가지를 riven 에서는 아예
        // 바꿀 수 없었다.
        addRow(t("settings.tabSize"), desc: t("settings.tabSizeDesc"),
               stepperControl(tabSizeField, key: "editorTabSize", min: 1, max: 8, def: 2, hint: "1–8"))
        addRow(t("settings.wordWrap"), desc: t("settings.wordWrapDesc"),
               editorToggle(wordWrap, key: "editorWordWrap", def: false))
        addRow(t("settings.minimap"), desc: t("settings.minimapDesc"),
               editorToggle(minimap, key: "editorMinimap", def: true))
        addRow(t("settings.ligatures"), desc: t("settings.ligaturesDesc"),
               editorToggle(ligatures, key: "editorLigatures", def: false))

        addSection(t("settings.terminal"))
        terminalSize.stringValue = String(s.int("terminalFontSize", 13))
        addRow(t("settings.fontSize"), desc: nil, sizeControl(terminalSize, key: "terminalFontSize"))
        addRow(t("settings.fontFamily"), desc: nil, fontMenu(key: "terminalFontFamily", preview: terminalPreview))
        addRow(t("settings.fontPreview"), desc: nil, previewChip())
        addWideRow(terminalPreview)
        // 이미 ghostty 를 쓰던 사람은 글꼴·크기를 이미 맞춰 뒀다. 다시 고르게 하지 않는다.
        let (ghosttyBtn, ghosttyStatus) = ghosttyControls()
        addRow(t("settings.ghostty"), desc: ghosttyStatus.stringValue, ghosttyBtn)
        ghosttyStatusLabel = ghosttyStatus

        // 브라우저 기본 검색. BrowserStore 가 읽던 키인데 UI 가 없어서, 구글 말고 다른 걸
        // 쓰려면 settings.json 을 손으로 고쳐야 했다.
        // 사용량을 남은 쪽으로 읽을지 쓴 쪽으로 읽을지. 헤더 숫자를 눌러도 바뀐다.
        addSection(t("settings.usage"))
        addRow(t("settings.usageMode"), desc: t("settings.usageModeDesc"), usageModeSeg())

        addSection(t("settings.browser"))
        addRow(t("settings.searchEngine"), desc: t("settings.searchEngineDesc"), searchEngineMenu())

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
    // 폰트 크기 입력칸 - 엔터를 치거나 포커스를 잃는 순간 바로 저장 + 적용된다.
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

    /// 글꼴 고르기. 목록은 고정폭 글꼴만 - 에디터·터미널에 비고정폭을 고르면 칸이 어긋난다.
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
        label.stringValue = "riven - let x = 1; 한글 0O l1 {}"
        label.textColor = Theme.fg
        label.lineBreakMode = .byTruncatingTail
    }
    /// 시스템에 깔린 고정폭 글꼴 (한 번만 훑는다 - 폰트 목록 조회는 느리다).
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
        // 버튼은 늘 눌린다. 예전에는 가져올 게 없으면 onClick 을 아예 달지 않았는데,
        // 눌리지 않는 버튼과 고장난 버튼은 손끝에서 구분되지 않는다 - 눌러 보고 "왜 안
        // 되지" 로 끝난다. 지금은 눌리고, 왜 아무 일도 없었는지를 그 자리에서 말해 준다.
        let importable = found.map { !$0.hasNothing } ?? false
        let btn = PadButton(title: t("settings.ghosttyImport"), font: UIScale.font(UIScale.small, .medium),
                            textColor: importable ? Theme.fg : Theme.fgDim,
                            bg: Theme.hover, border: Theme.edge, radius: 6, hPad: 10, height: 24)
        let status = NSTextField(labelWithString: found.map { $0.summary } ?? t("settings.ghosttyNone"))
        btn.onClick = { [weak self, weak status] in
            guard let f = GhosttyImport.read() else {
                status?.stringValue = t("settings.ghosttyNone")
                self?.flashSaved(t("settings.ghosttyNothingShort"), ok: false)
                return
            }
            guard !f.hasNothing else {
                status?.stringValue = f.summary
                self?.flashSaved(t("settings.ghosttyNothingShort"), ok: false)
                return
            }
            let msg = GhosttyImport.apply(f)
            self?.flashSaved(msg, ok: true)
            self?.showTab(0)
        }
        return (btn, status)
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
        addSection(t("settings.agentSection"))
        agentNative.title = ""
        agentNative.state = s.string("agentUI", "native") == "native" ? .on : .off
        agentNative.target = self; agentNative.action = #selector(saveAgentUI)
        agentNative.contentTintColor = Theme.fg
        addRow(t("settings.agentNative"), desc: t("settings.agentNativeDesc"), agentNative)

        // 설치된 CLI 를 그대로 보여 준다. 예전에는 못 찾으면 채팅 안에 "CLI 없음" 한 줄이
        // 뜰 뿐이라, 어디를 고쳐야 하는지 알 수 없었다.
        addSection(t("settings.cliSection"))
        for a in AgentDiscovery.available() {
            let ver = a.name == "Claude Code" ? AgentDiscovery.claudeVersion() : nil
            addRow(a.name, desc: a.cmd, statusChip(ver.map { "v\($0)" } ?? t("settings.cliFound"), ok: true))
        }
        if AgentDiscovery.available().isEmpty {
            addNote(t("settings.cliNone"))
        }

        // Codex 는 처음 보는 훅을 실행하기 전에 자기 화면에서 한 번 물어본다. 그걸 모르면
        // "왜 Codex 만 상태가 안 뜨지" 가 되므로, 설정에서 미리 알려 준다.
        if AgentDiscovery.codexCmd() != nil {
            addNote(t("settings.codexHooksNote"))
        }

        // 새 대화가 어디서 시작하는지. 모델은 페인마다 ⌥메뉴로 고를 수 있었지만 저장되지
        // 않아서 새 대화는 늘 "기본" 이었고, 권한 모드는 채팅 패널 안에만 있어서 설정에서는
        // 보이지 않았다.
        addSection(t("settings.agentDefaults"))
        // CLI 마다 모델이 다르다. 한 칸에 Claude 모델만 늘어놓고 "기본 모델" 이라고 적으면,
        // Codex 대화를 여는 사람에게는 고를 수 없는 목록이다.
        if AgentDiscovery.claudeCmd() != nil {
            addRow(t("settings.defaultModelClaude"), desc: t("settings.defaultModelDesc"),
                   modelMenu(key: "defaultModel", models: ChatPanel.selectableModels))
        }
        if AgentDiscovery.codexCmd() != nil {
            let cx = CodexUsage.availableModels()
            addRow(t("settings.defaultModelCodex"), desc: t("settings.defaultModelDesc"),
                   modelMenu(key: "defaultModelCodex",
                             models: [(t("chat.model.default"), "default")] + cx.map { ($0.label, $0.id) }))
        }
        addRow(t("settings.defaultPermMode"), desc: t("settings.defaultPermModeDesc"), defaultModeMenu())

        // 전역 고정 프롬프트: 모든 에이전트(챗·터미널)에 덧붙는 기본 지침 - CLAUDE.md 처럼 쓰되
        // 프로젝트가 아니라 riven 전체에 걸린다.
        addSection(t("settings.promptSection"))
        addNote(t("settings.promptNote"))
        addWideRow(promptTemplatePicker())
        addWideRow(promptEditor(), fill: true)

        // 스니펫: 등록된 것 → 추가 줄. 예전에는 안내문·목록·입력칸·버튼이 폭 500 으로 못 박힌
        // 채 배경 위에 그냥 쌓여 있어서, 카드로 정리한 다른 섹션과 따로 놀았다.
        addSection(t("settings.snippets"))
        let snips = (Settings.shared.object("snippets") as? [String: String]) ?? [:]
        if snips.isEmpty {
            let empty = NSTextField(labelWithString: t("settings.snippetsEmpty"))
            empty.font = UIScale.font(UIScale.small); empty.textColor = Theme.fgDim
            addWideRow(empty)
        }
        for (prefix, body) in snips.sorted(by: { $0.key < $1.key }) {
            let del = PadButton(title: t("common.delete"), font: UIScale.font(UIScale.small),
                                textColor: Theme.fgDim, bg: Theme.hover, border: Theme.edge,
                                radius: 5, hPad: 8, height: 22)
            del.onClick = { [weak self] in self?.deleteSnippet(prefix) }
            addRow(prefix, desc: body.replacingOccurrences(of: "\n", with: " ⏎ "), del)
        }
        addRow(t("settings.snippetPrefix"), desc: t("settings.snippetsHint"), field(snippetPrefix, width: 140))
        addRow(t("settings.snippetBody"), desc: nil, field(snippetBody, width: 260))
        addWideRow(primaryButton(t("settings.addSnippet"), #selector(addSnippet)))
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
    }
    @objc private func saveAIAll() {
        saveAI()
    }

    // ---- Keybindings tab - three sub-tabs (에디터 / 터미널 / 리븐 기본), matching riven's
    // KeybindingsSettings. The editor tab has preset chips (VS Code / JetBrains /
    // Sublime); the shown chords follow the selected preset. ----
    /// 벤치용: 단축키 하위 탭을 미리 정한다.
    func debugSetKbSubtab(_ i: Int) { kbSubtab = i }
    private var kbSubtab = 0   // 0 에디터, 1 터미널, 2 리븐 기본 (riven defaults to editor)
    private let editorPresets = ["vscode": "VS Code", "jetbrains": "JetBrains", "sublime": "Sublime Text"]

    private func buildKeybindings() {
        // Sub-tab chips.
        let names = [t("keys.tab.editor"), t("keys.tab.terminal"), t("keys.tab.riven"), t("keys.tab.browser")]
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
        content.addArrangedSubview(spacer(8))

        // 브라우저 키는 패널이 직접 처리해서 여기서 바꿀 수 없다. 바꿀 수 있는 척하면
        // 눌러 보고 안 먹는 것으로 끝난다 - 안내를 갈라 준다.
        let hint = NSTextField(labelWithString: kbSubtab == 3 ? t("keys.browserFixed") : t("keys.hint"))
        hint.font = UIScale.font(UIScale.small); hint.textColor = Theme.fgDim
        content.addArrangedSubview(hint)
        content.addArrangedSubview(spacer(10))

        // 키 목록은 카드 안에. 예전에는 줄이 바로 이어 붙어 (28pt, 구분선 없음) 빽빽했다.
        if kbSubtab == 0 { buildEditorKeys() }
        addSection(t("settings.keysSection"))
        let actions: [Keys.Action] = kbSubtab == 0 ? Keys.byCat("editor")
                                   : kbSubtab == 1 ? Keys.byCat("terminal")
                                   : kbSubtab == 2 ? Keys.byCat("riven") : Keys.byCat("browser")
        for a in actions {
            let chip = PadButton(title: Keys.display(Keys.effective(a.id)),
                                 font: UIScale.mono(UIScale.small, .medium),
                                 textColor: Theme.fgDim, bg: Theme.bg3, border: Theme.edge,
                                 radius: 5, hPad: 8, height: 24)
            if kbSubtab != 3 {
                chip.onClick = { [weak self, weak chip] in self?.beginRecording(a.id, a.cat, chip) }
            }
            // 바꾼 키는 눈에 띄어야 되돌릴 생각도 든다. 기본값 그대로면 표시하지 않는다.
            let changed = Keys.overrides[a.id] != nil
            if changed { chip.identifierString = "changed" }
            addRow(a.label, desc: changed ? t("settings.keyChanged") : nil, chip)
        }
        // 바꾼 키가 하나라도 있을 때만 되돌리기를 보여 준다 - 누를 일이 없는 버튼은 잡음이다.
        if kbSubtab != 3, actions.contains(where: { Keys.overrides[$0.id] != nil }) {
            addWideRow(secondaryButton(t("settings.keysReset"), symbol: "arrow.counterclockwise") { [weak self] in
                for a in actions { Keys.reset(a.id) }
                self?.showTab(2)
            })
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
    // (label, [vscode, jetbrains, sublime]) - from editorKeymaps.ts.
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

    // ---- Account tab - riven's Supabase account & settings sync. The native build
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
        addNote(t("account.intro"))

        // RIVEN_ACCOUNTUI=1: 백엔드가 없는 빌드에서도 로그인 줄의 배치를 볼 수 있게 (검증용).
        // 이 탭이 카드 밖에 떠 있던 문제는 구성된 빌드에서만 보였기 때문에 오래 지나쳤다.
        let forceUI = ProcessInfo.processInfo.environment["RIVEN_ACCOUNTUI"] != nil
        if !SupabaseConfig.isConfigured && !forceUI {
            addNote(t("account.noBackend"), color: Theme.warning)
            addNote(t("account.secretsLocal"))
            return
        }

        // 로그인 상태·버튼은 다른 탭과 같은 카드 줄에 둔다. 예전에는 content 에 직접 쌓아서
        // 이 탭만 카드 밖에 맨몸으로 떠 있었다 - 정보 탭 버튼이 맨몸이라 지적받은 것과 같은
        // 문제인데, 디버그 빌드는 Supabase 미구성이라 위에서 return 해 눈에 띄지 않았다.
        if SupabaseAuth.shared.isSignedIn {
            let out = accountButton(icon: "rectangle.portrait.and.arrow.right",
                                    title: t("account.signOut"), tint: Theme.fgDim) {
                SupabaseAuth.shared.signOut()
            }
            addRow(SupabaseAuth.shared.email ?? t("account.signedIn"),
                   desc: t("account.syncing"), out)
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
            addRow(t("account.signIn"), desc: t("account.signInDesc"), btn)
            if let msg = accountError {
                addNote(t("account.signInFailed", ["msg": msg]), color: Theme.danger)
            }
        }
        addNote(t("account.secretsLocal"))
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

    // ---- About tab - version + update check (riven's AboutTab/electron-updater) ----
    private func buildAbout() {
        // 앱 정보는 아이콘 · 이름 · 버전이 한 덩어리로 보여야 한다. 예전에는 작은 글자 세 줄이
        // 왼쪽 위에 그냥 쌓여 있어서 만들다 만 화면처럼 보였다 (애플의 "이 Mac에 관하여" 처럼).
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.1"
        let hero = NSView()
        hero.translatesAutoresizingMaskIntoConstraints = false
        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        let name = NSTextField(labelWithString: "riven")
        name.font = UIScale.font(22, .semibold); name.textColor = Theme.fg
        name.translatesAutoresizingMaskIntoConstraints = false
        let verL = NSTextField(labelWithString: "버전 \(ver)")
        verL.font = UIScale.font(UIScale.small); verL.textColor = Theme.fgDim
        verL.translatesAutoresizingMaskIntoConstraints = false
        let tag = NSTextField(labelWithString: t("about.tagline"))
        tag.font = UIScale.font(UIScale.small); tag.textColor = Theme.fgDim
        tag.translatesAutoresizingMaskIntoConstraints = false
        hero.addSubview(icon); hero.addSubview(name); hero.addSubview(verL); hero.addSubview(tag)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: hero.leadingAnchor),
            icon.centerYAnchor.constraint(equalTo: hero.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 56),
            icon.heightAnchor.constraint(equalToConstant: 56),
            name.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 14),
            name.topAnchor.constraint(equalTo: hero.topAnchor, constant: 2),
            verL.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            verL.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 3),
            tag.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            tag.topAnchor.constraint(equalTo: verL.bottomAnchor, constant: 2),
            tag.bottomAnchor.constraint(lessThanOrEqualTo: hero.bottomAnchor),
            hero.heightAnchor.constraint(greaterThanOrEqualToConstant: 64),
        ])
        content.addArrangedSubview(hero)
        hero.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 2).isActive = true
        content.addArrangedSubview(spacer(6))

        addSection(t("about.update"))
        // 탭을 다시 그릴 때도 실제 진행 상태를 따른다 (창을 닫았다 열면 "확인 중…"이 남던 문제).
        updateStatusLabel = NSTextField(labelWithString: Updater.shared.isChecking ? t("about.checking") : t("about.checkHint"))
        updateStatusLabel.font = UIScale.font(UIScale.small); updateStatusLabel.textColor = Theme.fgDim
        updateStatusLabel.lineBreakMode = .byWordWrapping
        updateStatusLabel.maximumNumberOfLines = 2
        // 줄 이름과 버튼 글자가 같으면("업데이트 확인" ×2) 읽는 사람이 두 번 읽게 된다.
        addRow(t("about.checkTitle"), desc: t("about.checkHint"),
               primaryButton(t("about.check"), #selector(checkUpdate)))
        // 상태 문구는 확인을 누른 뒤에만 (평소엔 빈 줄이 하나 더 생길 뿐이다).
        updateStatusLabel.isHidden = updateStatusLabel.stringValue.isEmpty

        autoUpdate.title = ""
        autoUpdate.state = Settings.shared.bool("autoUpdate", true) ? .on : .off
        autoUpdate.contentTintColor = Theme.fg
        autoUpdate.target = self; autoUpdate.action = #selector(saveAutoUpdate)
        addRow(t("about.autoUpdate"), desc: t("about.autoUpdateDesc"), autoUpdate)

        // 설정이 꼬였을 때 손 쓸 방법이 없었다. 파일을 직접 열어 보는 길과, 되돌리는 길.
        addRow(t("about.whatsNew"), desc: t("about.whatsNewDesc"),
               secondaryButton(t("about.whatsNew"), symbol: "sparkles") { [weak self] in
                   ReleaseNotes.showNow(over: self)
               })

        addSection(t("settings.maintenance"))
        addRow(t("settings.openSettingsFile"), desc: AppPaths.support("settings.json").path,
               secondaryButton(t("settings.reveal"), symbol: "folder") {
                   NSWorkspace.shared.activateFileViewerSelecting([AppPaths.support("settings.json")])
               })
        addRow(t("settings.resetAll"), desc: t("settings.resetAllDesc"),
               secondaryButton(t("settings.reset"), symbol: "arrow.counterclockwise") { [weak self] in
                   self?.confirmResetAll()
               })

        addSection(t("about.links"))
        let landing = secondaryButton(t("about.landing"), symbol: "safari") {
            if let u = URL(string: "https://riven-sandy.vercel.app/") { NSWorkspace.shared.open(u) }
        }
        let gh = secondaryButton(t("about.github"), symbol: "chevron.left.forwardslash.chevron.right") {
            if let u = URL(string: "https://github.com/wassupss/riven") { NSWorkspace.shared.open(u) }
        }
        // 버튼만 덩그러니 놓여 있었다. 다른 탭과 같은 카드 줄로.
        addRow(t("about.homepage"), desc: "riven-sandy.vercel.app", landing)
        addRow(t("about.source"), desc: "github.com/wassupss/riven", gh)
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
    // Updater가 알려주면 라벨을 유휴 문구로 되돌린다 - "확인 중…"이 영영 남지 않도록.
    @objc private func checkUpdate() {
        updateStatusLabel.stringValue = t("about.checking"); updateStatusLabel.textColor = Theme.fgDim
        // Sparkle의 업데이트 창은 평범한 창이라, floating 패널인 설정 창에 가려 뒤에 뜬다.
        // 업데이트 흐름(확인 → 다운로드 → 설치) 동안에는 floating을 내려 두고, 설정 창을
        // 닫을 때 되돌린다. (확인이 끝나는 시점에 바로 되돌리면 다운로드 창이 다시 가려진다.)
        setFloating(false)
        Updater.shared.onCheckFinished = { [weak self] in self?.syncUpdateStatus() }
        Updater.shared.checkForUpdates(self)
    }

    // floating(항상 위) 토글 - 업데이트 창이 뒤로 숨지 않게 잠시 내렸다가 되돌린다.
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
    /// 예전에는 컨트롤들이 배경 위에 그냥 떠 있었다 - 어디까지가 한 묶음인지 눈으로 알 수
    /// 없으니 "동떨어져" 보인다. 묶음을 그려 주는 것만으로 절반은 해결된다.
    private var currentCard: SettingsCard?
    private func addSection(_ t: String) {
        content.addArrangedSubview(spacer(currentCard == nil ? 0 : 18))   // 섹션 사이
        content.addArrangedSubview(sectionLabel(t))
        content.addArrangedSubview(spacer(6))                             // 제목 ↔ 카드
        let card = SettingsCard()
        currentCard = card
        content.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
    }
    /// 지금 카드에 줄 하나. 왼쪽에 이름(+ 한 줄 설명), 오른쪽 끝에 컨트롤.
    private func addRow(_ label: String, desc: String? = nil, _ control: NSView) {
        currentCard?.addRow(label: label, desc: desc, control: control)
    }
    /// 카드 안의 설명 문단 (문장이 주인인 섹션 - 계정·정보).
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


    // ---- 새로 노출한 설정들 ---------------------------------------------------

    /// 남은 % / 쓴 % 고르기. 언어·전체 크기와 같은 세그먼트 모양이라 같은 열에서 튀지 않는다.
    private func usageModeSeg() -> NSView {
        let seg = NSSegmentedControl(labels: [t("settings.usageLeft"), t("settings.usageUsed")],
                                     trackingMode: .selectOne, target: self,
                                     action: #selector(usageModeChanged(_:)))
        seg.selectedSegment = Settings.shared.bool("usageShowUsed", false) ? 1 : 0
        seg.font = UIScale.font(UIScale.small)
        seg.translatesAutoresizingMaskIntoConstraints = false
        return seg
    }
    @objc private func usageModeChanged(_ sender: NSSegmentedControl) {
        Settings.shared.set("usageShowUsed", sender.selectedSegment == 1)
        NotificationCenter.default.post(name: .rivenUsageModeChanged, object: nil)
    }

    /// 브라우저 기본 검색. 흔한 것 셋 + 직접 입력 ({q} 자리에 검색어가 들어간다).
    private static let searchEngines: [(String, String)] = [
        ("Google", "https://www.google.com/search?q={q}"),
        ("DuckDuckGo", "https://duckduckgo.com/?q={q}"),
        ("Bing", "https://www.bing.com/search?q={q}"),
        ("Naver", "https://search.naver.com/search.naver?query={q}"),
    ]
    private func searchEngineMenu() -> NSView {
        let cur = Settings.shared.string("browserSearch", SettingsWindow.searchEngines[0].1)
        let pop = NSPopUpButton(frame: .zero, pullsDown: false)
        pop.addItems(withTitles: SettingsWindow.searchEngines.map { $0.0 } + [t("settings.custom")])
        let idx = SettingsWindow.searchEngines.firstIndex { $0.1 == cur }
        pop.selectItem(at: idx ?? SettingsWindow.searchEngines.count)
        pop.font = UIScale.font(UIScale.small)
        pop.target = self; pop.action = #selector(searchEngineChanged(_:))
        pop.translatesAutoresizingMaskIntoConstraints = false
        // 직접 입력일 때만 주소 칸을 보여 준다 - 늘 띄워 두면 고르는 줄이 두 줄이 된다.
        searchCustom.stringValue = idx == nil ? cur : ""
        searchCustom.isHidden = idx != nil
        searchCustom.target = self; searchCustom.action = #selector(searchCustomChanged)
        let f = field(searchCustom, width: 220)
        f.isHidden = idx != nil
        searchCustomBox = f
        let row = NSStackView(views: [pop, f])
        row.orientation = .horizontal; row.spacing = 8; row.alignment = .centerY
        return row
    }
    @objc private func searchEngineChanged(_ sender: NSPopUpButton) {
        let i = sender.indexOfSelectedItem
        if i < SettingsWindow.searchEngines.count {
            Settings.shared.set("browserSearch", SettingsWindow.searchEngines[i].1)
            searchCustomBox?.isHidden = true
        } else {
            searchCustomBox?.isHidden = false
            makeFirstResponder(searchCustom)
        }
    }
    @objc private func searchCustomChanged() {
        let v = searchCustom.stringValue.trimmingCharacters(in: .whitespaces)
        // {q} 가 없으면 검색이 아니라 그냥 그 주소로 가 버린다 - 저장하지 않는다.
        guard v.contains("{q}") else { return }
        Settings.shared.set("browserSearch", v)
    }

    /// 새 대화가 쓸 기본 모델. 페인마다 ⌥메뉴로 바꾸는 건 그대로 둔다.
    private var modelMenus: [NSPopUpButton: (key: String, ids: [String])] = [:]
    private func modelMenu(key: String, models: [(String, String)]) -> NSView {
        let cur = Settings.shared.string(key, "default")
        let pop = NSPopUpButton(frame: .zero, pullsDown: false)
        pop.addItems(withTitles: models.map { $0.0 })
        pop.selectItem(at: models.firstIndex { $0.1 == cur } ?? 0)
        pop.font = UIScale.font(UIScale.small)
        pop.target = self; pop.action = #selector(defaultModelChanged(_:))
        modelMenus[pop] = (key, models.map { $0.1 })
        return pop
    }
    @objc private func defaultModelChanged(_ sender: NSPopUpButton) {
        guard let m = modelMenus[sender] else { return }
        let i = max(0, min(m.ids.count - 1, sender.indexOfSelectedItem))
        Settings.shared.set(m.key, m.ids[i])
    }

    /// 새 대화가 시작할 승인 모드. 채팅 패널의 드롭다운과 같은 키를 쓴다.
    private func defaultModeMenu() -> NSView {
        let names = [t("chat.mode.plan"), t("chat.mode.ask"), t("chat.mode.auto")]
        let pop = NSPopUpButton(frame: .zero, pullsDown: false)
        pop.addItems(withTitles: names)
        pop.selectItem(at: max(0, min(names.count - 1, Settings.shared.int("chatPermMode", 1))))
        pop.font = UIScale.font(UIScale.small)
        pop.target = self; pop.action = #selector(defaultModeChanged(_:))
        return pop
    }
    @objc private func defaultModeChanged(_ sender: NSPopUpButton) {
        Settings.shared.set("chatPermMode", sender.indexOfSelectedItem)
    }

    @objc private func saveAutoUpdate() {
        Settings.shared.set("autoUpdate", autoUpdate.state == .on)
        Updater.shared.setAutomaticChecks(autoUpdate.state == .on)
    }

    /// 되돌리기는 되돌릴 수 없는 일이라 반드시 한 번 묻는다. 테마·글꼴 같은 것만 지우고
    /// 세션(열린 탭·대화)은 건드리지 않는다 - "설정 초기화" 로 작업까지 날리면 사고다.
    private func confirmResetAll() {
        let a = NSAlert()
        a.messageText = t("settings.resetAll")
        a.informativeText = t("settings.resetConfirm")
        a.alertStyle = .warning
        a.addButton(withTitle: t("settings.reset"))
        a.addButton(withTitle: t("common.cancel"))
        guard a.runModal() == .alertFirstButtonReturn else { return }
        Settings.shared.resetPreferences()
        NotificationCenter.default.post(name: .rivenFontSizeChanged, object: nil)
        Theme.apply(id: Settings.shared.string("theme", "ember"))
        showTab(activeTab)
    }
    private let searchCustom = NSTextField()
    private var searchCustomBox: NSView?

    /// 에디터 동작 토글. 저장하고 곧바로 에디터에 밀어 넣는다 - 재시작해야 먹는 설정은
    /// 고른 사람 입장에서 안 먹는 설정과 구분되지 않는다.
    private func editorToggle(_ b: NSButton, key: String, def: Bool) -> NSButton {
        b.title = ""
        b.state = Settings.shared.bool(key, def) ? .on : .off
        b.contentTintColor = Theme.fg
        b.target = self; b.action = #selector(editorToggleChanged(_:))
        b.identifier = NSUserInterfaceItemIdentifier(key)
        return b
    }
    @objc private func editorToggleChanged(_ sender: NSButton) {
        guard let key = sender.identifier?.rawValue else { return }
        Settings.shared.set(key, sender.state == .on)
        NotificationCenter.default.post(name: .rivenFontSizeChanged, object: nil)
    }

    /// 숫자 + 스테퍼 한 줄 (폰트 크기 칸과 같은 모양 - 같은 행에서 모양이 다르면 눈에 걸린다).
    private func stepperControl(_ field: NSTextField, key: String, min lo: Int, max hi: Int,
                                def: Int, hint: String) -> NSView {
        let cur = Swift.max(lo, Swift.min(hi, Settings.shared.int(key, def)))
        field.stringValue = String(cur)
        field.identifier = NSUserInterfaceItemIdentifier(key)
        let tf = self.fontField(field)
        tf.widthAnchor.constraint(equalToConstant: 56).isActive = true
        let stepper = NSStepper()
        stepper.minValue = Double(lo); stepper.maxValue = Double(hi); stepper.increment = 1
        stepper.integerValue = cur
        stepper.valueWraps = false
        stepper.target = self; stepper.action = #selector(numberStepperChanged(_:))
        stepper.identifier = NSUserInterfaceItemIdentifier(key)
        stepper.translatesAutoresizingMaskIntoConstraints = false
        let h = NSTextField(labelWithString: hint)
        h.font = UIScale.font(UIScale.caption); h.textColor = Theme.fgDim
        let row = NSStackView(views: [tf, stepper, h])
        row.orientation = .horizontal; row.spacing = 6; row.alignment = .centerY
        return row
    }
    @objc private func numberStepperChanged(_ sender: NSStepper) {
        guard let key = sender.identifier?.rawValue else { return }
        Settings.shared.set(key, sender.integerValue)
        if key == "editorTabSize" { tabSizeField.stringValue = String(sender.integerValue) }
        NotificationCenter.default.post(name: .rivenFontSizeChanged, object: nil)
    }

    /// "✓ 저장됨" 을 잠깐 띄운다. 실패한 동작에도 같은 자리를 쓰되 색으로 가른다 -
    /// 성공만 말하고 실패는 침묵하면, 아무 일도 없었을 때 눌리긴 한 건지 알 수 없다.
    func flashSaved(_ text: String, ok: Bool) {
        savedLabel.stringValue = (ok ? "✓ " : "· ") + text
        savedLabel.textColor = ok ? Theme.success : Theme.fgDim
        savedTimer?.invalidate()
        savedLabel.alphaValue = 1
        savedTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
            guard let self else { return }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.35
                self.savedLabel.animator().alphaValue = 0
            }
        }
    }

    /// 미리보기 줄의 오른쪽 표식. 고를 것이 없는 줄이라 컨트롤 대신 조용한 라벨을 둔다.
    private func previewChip() -> NSView {
        let l = NSTextField(labelWithString: t("settings.fontPreviewHint"))
        l.font = UIScale.font(UIScale.caption)
        l.textColor = Theme.fgDim
        return l
    }

    /// 값이 아니라 상태를 보여 주는 자리 (설치된 CLI 의 버전처럼 읽기 전용인 것).
    /// 컨트롤처럼 보이면 누를 수 있다고 오해하니, 알약 모양 라벨로 둔다.
    private func statusChip(_ text: String, ok: Bool) -> NSView {
        let l = NSTextField(labelWithString: text)
        l.font = UIScale.font(UIScale.caption, .medium)
        l.textColor = ok ? Theme.success : Theme.fgDim
        l.translatesAutoresizingMaskIntoConstraints = false
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = Theme.hover.cgColor
        box.layer?.cornerRadius = 5
        box.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(l)
        NSLayoutConstraint.activate([
            box.heightAnchor.constraint(equalToConstant: UIScale.pt(20)),
            l.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 8),
            l.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -8),
            l.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        ])
        return box
    }

    /// 카드 폭을 통째로 쓰는 줄 (테마 격자·미리보기처럼 이름/컨트롤로 나뉘지 않는 것).
    private func addWideRow(_ view: NSView, fill: Bool = false) {
        currentCard?.addWide(view, fill: fill)
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
    /// 전역 고정 프롬프트 멀티라인 편집기. 값은 즉시(디바운스) 저장된다 (textDidChange).
    private func promptEditor() -> NSView {
        let tv = fixedPromptView
        tv.font = UIScale.mono(UIScale.small)
        tv.isRichText = false; tv.drawsBackground = false; tv.allowsUndo = true
        tv.textColor = Theme.fg; tv.insertionPointColor = Theme.fg
        tv.textContainerInset = NSSize(width: 6, height: 6)
        tv.isVerticallyResizable = true; tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.textContainer?.widthTracksTextView = true
        tv.hint = t("settings.promptHint")
        tv.string = Settings.shared.string("prompt.global", "")
        tv.delegate = self
        let sc = NSScrollView()
        sc.documentView = tv
        sc.hasVerticalScroller = true; sc.hasHorizontalScroller = false
        sc.horizontalScrollElasticity = .none
        sc.drawsBackground = true; sc.backgroundColor = Theme.isLight ? Theme.bg : Theme.bg3
        sc.wantsLayer = true; sc.layer?.cornerRadius = 5
        sc.layer?.borderWidth = 1; sc.layer?.borderColor = Theme.edge.cgColor
        sc.translatesAutoresizingMaskIntoConstraints = false
        sc.heightAnchor.constraint(equalToConstant: UIScale.pt(120)).isActive = true
        return sc
    }
    /// 고정 프롬프트를 처음부터 쓰기 막막할 때를 위한 예시 몇 개. 고르면 편집기에 넣어 준다
    /// (이미 내용이 있으면 지우지 않고 아래에 이어 붙인다 - 여러 개를 섞어 쓸 수 있게).
    private func promptTemplates() -> [(String, String)] {
        [(t("settings.promptTpl.warm"),    t("settings.promptTpl.warmBody")),
         (t("settings.promptTpl.concise"), t("settings.promptTpl.conciseBody")),
         (t("settings.promptTpl.review"),  t("settings.promptTpl.reviewBody")),
         (t("settings.promptTpl.korean"),  t("settings.promptTpl.koreanBody"))]
    }
    private func promptTemplatePicker() -> NSView {
        // pull-down: 첫 항목은 늘 보이는 제목이고, 나머지가 실제 선택지다.
        let pop = NSPopUpButton(frame: .zero, pullsDown: true)
        pop.addItem(withTitle: t("settings.promptTemplate"))
        for tpl in promptTemplates() { pop.addItem(withTitle: tpl.0) }
        pop.font = UIScale.font(UIScale.small)
        pop.target = self; pop.action = #selector(promptTemplatePicked(_:))
        let wrap = NSStackView(views: [pop]); wrap.orientation = .horizontal
        return wrap
    }
    @objc private func promptTemplatePicked(_ p: NSPopUpButton) {
        // pull-down 에서 인덱스 0 은 제목이므로 실제 템플릿은 1 부터.
        let idx = p.indexOfSelectedItem
        let tpls = promptTemplates()
        guard idx >= 1, idx - 1 < tpls.count else { return }
        let body = tpls[idx - 1].1
        let cur = fixedPromptView.string
        let combined = cur.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? body : cur + "\n\n" + body
        fixedPromptView.string = combined
        Settings.shared.set("prompt.global", combined)
        p.selectItem(at: 0)   // 제목으로 되돌린다
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
        savedLabel.textColor = Theme.success
        navSidebar?.layer?.backgroundColor = Theme.bg2.cgColor
        navSideHair?.layer?.backgroundColor = Theme.hairline.cgColor
        showTab(activeTab)   // 본문 + 선택 표시(아래 selectTab)를 새 색으로 다시 그린다                           // 탭 라벨/밑줄 + 본문 컨트롤 색 재생성
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
            left.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
            left.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            left.trailingAnchor.constraint(lessThanOrEqualTo: control.leadingAnchor, constant: -12),
            // 컨트롤은 오른쪽 끝에 맞춘다 - 줄마다 제각각이면 눈이 기댈 선이 없다.
            control.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -16),
            control.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: UIScale.pt(38)),
            // 세로 여백은 줄 높이를 키우는 대신 안쪽 여백으로 준다. 최소 높이를 44 로 올렸더니
            // 컨트롤 높이와 충돌해 제약이 풀리고 내용이 통째로 사라졌다 (하얀 화면).
            left.topAnchor.constraint(greaterThanOrEqualTo: row.topAnchor, constant: 9),
            left.bottomAnchor.constraint(lessThanOrEqualTo: row.bottomAnchor, constant: -9),
        ])
        add(row)
    }

    func addWide(_ view: NSView) { addWide(view, fill: false) }
    /// fill=true 면 뷰가 카드 폭을 꽉 채운다 (trailing 을 == 로). intrinsic 폭이 없는 뷰
    /// (스크롤뷰·에디터)는 이걸 써야 한다 - lessThanOrEqualTo 로는 폭 0 으로 접혀 안 보인다.
    func addWide(_ view: NSView, fill: Bool) {
        if !rows.isEmpty { addSeparator() }
        view.translatesAutoresizingMaskIntoConstraints = false
        let row = NSView()
        row.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(view)
        let trailing = fill
            ? view.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -16)
            : view.trailingAnchor.constraint(lessThanOrEqualTo: row.trailingAnchor, constant: -16)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
            trailing,
            view.topAnchor.constraint(equalTo: row.topAnchor, constant: 12),
            view.bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -12),
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

extension SettingsWindow: NSTextViewDelegate {
    // 전역 고정 프롬프트 편집기의 변경을 즉시(디바운스) 저장한다. 이 창의 다른 텍스트 입력은
    // NSTextField(별도 경로)라, 여기로 오는 건 fixedPromptView 뿐이다.
    func textDidChange(_ notification: Notification) {
        guard (notification.object as? NSTextView) === fixedPromptView else { return }
        Settings.shared.set("prompt.global", fixedPromptView.string)
    }
}
