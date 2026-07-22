import AppKit

// riven native shell — Phase 1 core loop:
//   explorer (file tree) | Monaco editor (WKWebView) | libghostty terminal
// Open a folder → browse files → click to open in Monaco → ⌘S saves to disk.
// The terminal is a real GPU shell rooted at the workspace.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    // Re-assert terminal focus when the app returns to front — the surface can lose
    // ghostty focus while the window is inactive, leaving a "focused but no input" pane.
    func windowDidBecomeKey(_ notification: Notification) {
        if let tv = window?.firstResponder as? TerminalView { tv.focusTerminal() }
        else if let tv = currentTerminal(), activeDock?.activeGroup?.activePanel?.content === tv { tv.focusTerminal() }
    }
    var window: NSWindow!
    var rail: WorkspaceRail!
    var explorer: FileTreeView!
    var searchPanel: SearchPanel!
    var gitPanel: GitPanel!
    var previewPanel: PreviewPanel!
    var changesPanel: ChangesPanel!
    var sourceControl: SourceControlView!   // git panel = commit graph + working changes
    var sidebarLower: NSView!
    var editor: EditorView!
    var tabBar: TabBar!
    var statusBar: StatusBarView!
    var editorPane: NSView!
    var bodySplit: NSSplitView!
    var sidebarSplit: NSSplitView!
    private var sidebarContainer: NSView!
    private var pinnedUsage: NSView?
    private var agentWatch: AgentWatch?                       // fs watcher for the active workspace
    private var agentSessionWorkspaces: Set<String> = []      // workspaces with a live agent session
    private var headerLabel: NSTextField!                     // dock header: active workspace name
    private var headerIcon: NSImageView!
    private var headerUsage: NSTextField!                     // usage widget, top-right of the header
    private var headerUsageItem: NSView!                      // clickable wrapper (usage icon + label)
    private var headerUsagePopover: NSPopover?
    var dockHost: NSView!                 // holds the active workspace's dock.container
    var activeDock: DockManager?          // current workspace's dock
    var editorDockPanel: DockPanel?       // the shared editor panel (one WKWebView)
    private var workspaceColors: [URL: String] = [:]   // rail card colors (hex), persisted per session
    private var auxDockPanels: [String: DockPanel] = [:]  // search/git/preview/changes
    private var editorVisible = false
    var workspace: URL?
    let lsp = LSPManager.shared

    func applicationDidFinishLaunching(_ n: Notification) {
        installCrashHandler()
        // Match the system material appearance to the theme's mode so scrollers /
        // materials don't render the wrong polarity over our palette.
        NSApp.appearance = NSAppearance(named: Theme.isLight ? .aqua : .darkAqua)
        _ = GhosttyApp.shared   // init libghostty early

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 760),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "riven"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = Theme.bg
        window.center()
        window.delegate = self
        buildLayout()
        Theme.register(self)
        window.makeKeyAndOrderFront(nil)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        buildMenu()
        installKeybindings()
        startUsagePolling()
        Notifications.requestAuthorization()
        // Live language switch: rebuild the menu bar + refresh open panel titles so the
        // whole chrome follows the setting (panels observe .rivenLanguageChanged themselves).
        NotificationCenter.default.addObserver(forName: .rivenLanguageChanged, object: nil, queue: .main) { [weak self] _ in
            self?.buildMenu()
            self?.relocalizeOpenPanels()
            self?.editor.pushI18n()
        }
        NotificationCenter.default.addObserver(forName: .rivenFormatOnSaveChanged, object: nil, queue: .main) { [weak self] _ in
            self?.editor.setFormatOnSave(Settings.shared.bool("formatOnSave", false))
        }
        NotificationCenter.default.addObserver(forName: .rivenKeybindingsChanged, object: nil, queue: .main) { [weak self] _ in
            self?.buildMenu()   // rebuild the menu bar so remapped app/terminal shortcuts take effect
            self?.editor.setEditorKeys(Keys.editorChords())   // + editor per-command overrides
        }
        NotificationCenter.default.addObserver(forName: .rivenEditorKeymapChanged, object: nil, queue: .main) { [weak self] _ in
            self?.editor.setEditorKeymap(Settings.shared.string("editorKeymap", "vscode"))
        }
        NotificationCenter.default.addObserver(forName: .rivenSnippetsChanged, object: nil, queue: .main) { [weak self] _ in
            self?.editor.setSnippets(self?.loadSnippets() ?? [])
        }
        // Cloud settings sync (Supabase): when a pull lands, re-apply everything live.
        NotificationCenter.default.addObserver(forName: .rivenSettingsSynced, object: nil, queue: .main) { [weak self] _ in
            self?.reapplyAllSettings()
        }
        // Show the signed-in account (GitHub name) in the status bar; keep it in sync.
        NotificationCenter.default.addObserver(forName: .rivenAuthChanged, object: nil, queue: .main) { [weak self] _ in
            self?.statusBar.setAccount(SupabaseAuth.shared.displayName)
        }
        // Restore a signed-in riven account session (+ pull cloud settings) on launch.
        SupabaseAuth.shared.restore()
        statusBar.setAccount(SupabaseAuth.shared.displayName)
        // Open a folder on launch (or RIVEN_OPEN=path for headless debug).
        if let dbg = ProcessInfo.processInfo.environment["RIVEN_OPEN"] {
            let url = URL(fileURLWithPath: dbg)
            DispatchQueue.main.async {
                self.rail.addWorkspace(url); self.activate(url)
                // DEBUG: open a 2nd workspace + switch back, to verify per-workspace
                // terminals (2nd libghostty surface) don't crash and state swaps.
                if let dbg2 = ProcessInfo.processInfo.environment["RIVEN_OPEN2"] {
                    let url2 = URL(fileURLWithPath: dbg2)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                        self.rail.addWorkspace(url2); self.activate(url2)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                            self.switchWorkspace(url)   // back to first
                        }
                    }
                }
                if let f = ProcessInfo.processInfo.environment["RIVEN_OPENFILE"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        self.openFile(URL(fileURLWithPath: f))
                        if let shot = ProcessInfo.processInfo.environment["RIVEN_EDSHOT"] {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.editor.debugSnapshot(to: shot) }
                        }
                        // DEBUG: auto-trigger AI completion to verify the flow.
                        if ProcessInfo.processInfo.environment["RIVEN_AITEST"] != nil {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.editor.triggerAI() }
                        }
                        // DEBUG: exercise the exact ⌘S path (saveMenu → tabBar.active →
                        // requestSave) with format-on-save on, to verify prettier/eslint run.
                        if ProcessInfo.processInfo.environment["RIVEN_SAVETEST"] != nil {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                Settings.shared.set("formatOnSave", true)
                                self.editor.setFormatOnSave(true)
                                // Make the buffer messy so prettier has something to change.
                                let messy = "const   x=  {a:1,b:2}\n\n\nfunction  f( ){return    x}\n"
                                self.editor.debugSetValue(messy)
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                                    RLog.log("SAVETEST: tabBar.active=\(self.tabBar.active ?? "nil")")
                                    self.saveMenu()   // the literal ⌘S menu action
                                    if let shot = ProcessInfo.processInfo.environment["RIVEN_SAVESHOT"] {
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 4.5) { self.editor.debugSnapshot(to: shot) }
                                    }
                                }
                            }
                        }
                        // DEBUG: split the editor, open a 2nd file in the new group, snapshot.
                        if let f2 = ProcessInfo.processInfo.environment["RIVEN_SPLITFILE"] {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                self.editor.splitEditor(ProcessInfo.processInfo.environment["RIVEN_SPLITDIR"] ?? "right")
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                                    self.openFile(URL(fileURLWithPath: f2))
                                    if let shot = ProcessInfo.processInfo.environment["RIVEN_SPLITSHOT"] {
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.editor.debugSnapshot(to: shot) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // DEBUG: trigger the GitHub OAuth sign-in to reproduce the account-link crash.
        if ProcessInfo.processInfo.environment["RIVEN_AUTHTEST"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                RLog.log("AUTHTEST: configured=\(SupabaseConfig.isConfigured) url=\(SupabaseConfig.url)")
                SupabaseAuth.shared.signInWithGitHub { result in
                    RLog.log("AUTHTEST result: \(result)")
                }
            }
        }
        // DEBUG: emit a bell + OSC9 notification from the shell to verify ghostty
        // forwards them to our action_cb (RIVEN_BELLTEST).
        if ProcessInfo.processInfo.environment["RIVEN_BELLTEST"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 9.0) {
                let t = self.currentTerminal()
                RLog.log("BELLTEST: currentTerminal=\(t == nil ? "nil" : "ok"), sending printf")
                t?.runCommand("printf '\\a'; printf '\\033]9;riven test\\033\\\\'")
            }
        }
        // DEBUG: send synthetic keys to the terminal to reproduce key crashes.
        if let kt = ProcessInfo.processInfo.environment["RIVEN_KEYTEST"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
                let codes: [UInt32] = [0x24, 0x33, 0x7B, 0x7C]  // enter, backspace, left, right
                for c in codes { self.currentTerminal()?.debugSendKeycode(c) }
                _ = kt
                print("[KEYTEST] sent synthetic keys OK")
            }
        }
        // Restore the previous session (open folders + tabs) on a normal launch —
        // but NOT when a debug folder is forced via RIVEN_OPEN (else both would
        // open and the restored session would clobber the forced folder).
        if ProcessInfo.processInfo.environment["RIVEN_OPEN"] == nil {
            DispatchQueue.main.async { self.restoreSession() }
        }
        // No auto folder-open on launch; the user opens one via + / ⌘O.
        // DEBUG: self-capture the window chrome to a PNG so layout can be
        // inspected without screen-recording permission (RIVEN_SHOT=path).
        if let shot = ProcessInfo.processInfo.environment["RIVEN_SHOT"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                if ProcessInfo.processInfo.environment["RIVEN_PALETTE"] != nil { self.showCommandPalette() }
                if ProcessInfo.processInfo.environment["RIVEN_QUICKPANEL"] != nil { self.showQuickPanel() }
                if ProcessInfo.processInfo.environment["RIVEN_QUICKOPEN"] != nil { self.showQuickOpen() }
                if ProcessInfo.processInfo.environment["RIVEN_SETTINGS"] != nil {
                    self.settingsMenu()
                    if let t = ProcessInfo.processInfo.environment["RIVEN_SETTINGS_TAB"].flatMap(Int.init) {
                        self.settingsWin?.openTab(t)
                    }
                }
                // Reveal a sidebar panel for capture (RIVEN_PANEL=search|git).
                switch ProcessInfo.processInfo.environment["RIVEN_PANEL"] {
                case "search": self.toggleDockPanel("search")
                case "git": self.toggleDockPanel("git")
                case "preview": self.toggleDockPanel("preview")
                case "changes": self.toggleDockPanel("changes")
                default: break
                }
                // Optionally type a search query so results render (RIVEN_QUERY).
                if let q = ProcessInfo.processInfo.environment["RIVEN_QUERY"] {
                    self.searchPanel.debugSearch(q)
                }
            }
            let shotDelay = ProcessInfo.processInfo.environment["RIVEN_SHOT_DELAY"].flatMap(Double.init) ?? 3.6
            DispatchQueue.main.asyncAfter(deadline: .now() + shotDelay) {
                // Capture a panel (settings/palette) if one is open, else main.
                let panel = NSApp.windows.first { $0 is NSPanel && $0.isVisible && $0 !== self.window }
                let win = panel ?? NSApp.keyWindow ?? self.window
                guard let cv = win?.contentView,
                      let rep = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) else { return }
                cv.cacheDisplay(in: cv.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) {
                    try? data.write(to: URL(fileURLWithPath: shot))
                }
            }
        }
    }

    // Write crash stacks to /tmp/riven-crash.txt (raw binary won't produce a
    // normal crash report). Covers Obj-C exceptions + fatal signals.
    private func installCrashHandler() {
        NSSetUncaughtExceptionHandler { ex in
            let s = "EXCEPTION: \(ex.name.rawValue): \(ex.reason ?? "")\n\(ex.callStackSymbols.joined(separator: "\n"))"
            try? s.write(toFile: "/tmp/riven-crash.txt", atomically: true, encoding: .utf8)
        }
        for sig in [SIGSEGV, SIGABRT, SIGILL, SIGBUS, SIGTRAP] {
            signal(sig) { s in
                let syms = Thread.callStackSymbols.joined(separator: "\n")
                try? "SIGNAL \(s)\n\(syms)".write(toFile: "/tmp/riven-crash.txt", atomically: true, encoding: .utf8)
                exit(1)
            }
        }
    }

    private var rootView: NSView!
    private func buildLayout() {
        let root = NSView(frame: window.contentView!.bounds)
        rootView = root
        root.autoresizingMask = [.width, .height]
        root.wantsLayer = true
        root.layer?.backgroundColor = Theme.bg.cgColor

        let W = root.bounds.width, H = root.bounds.height
        let statusH: CGFloat = 25   // riven .status-bar
        let titleH: CGFloat = 30    // top strip: macOS traffic lights (left) + panel header (right)

        // Status bar (bottom, full width).
        statusBar = StatusBarView(frame: NSRect(x: 0, y: 0, width: W, height: statusH))
        statusBar.autoresizingMask = [.width, .maxYMargin]
        statusBar.onSettings = { [weak self] in self?.settingsMenu() }
        statusBar.onPin = { [weak self] in self?.pinUsage() }
        statusBar.moveControlsToHeader()   // usage + settings now live in the app header (top-right)

        // Body split: [sidebar | right area], full height above the status bar. The
        // header lives ONLY inside the right area (see rightContainer below); the left
        // sidebar just reserves a matching top inset for the macOS traffic lights.
        let bodyH = H - statusH - titleH   // dock/editor content height, below the header
        let body = NSSplitView(frame: NSRect(x: 0, y: statusH, width: W, height: H - statusH))
        body.isVertical = true
        body.dividerStyle = .thin
        body.autoresizingMask = [.width, .height]
        body.delegate = self
        bodySplit = body

        // --- Sidebar: workspace rail (top) + explorer (below) — unchanged. Wrapped
        // in a container that reserves `titleH` at the very top for the macOS traffic
        // lights, so the rail aligns with the right-area header and never sits under
        // the window buttons.
        let sidebarContainer = NSView(frame: NSRect(x: 0, y: 0, width: 220, height: H - statusH))
        self.sidebarContainer = sidebarContainer
        sidebarContainer.wantsLayer = true
        sidebarContainer.layer?.backgroundColor = Theme.bg2.cgColor
        let sidebarSplitV = NSSplitView(frame: NSRect(x: 0, y: 0, width: 220, height: bodyH))
        sidebarSplitV.isVertical = false
        sidebarSplitV.dividerStyle = .thin
        sidebarSplitV.delegate = self          // enforce a min rail height (see extension)
        sidebarSplit = sidebarSplitV
        sidebarView = sidebarSplitV

        rail = WorkspaceRail(frame: NSRect(x: 0, y: 0, width: 220, height: 150))
        rail.onOpen = { [weak self] in self?.openFolder() }
        rail.onSelect = { [weak self] url in self?.switchWorkspace(url) }
        rail.onReveal = { url in NSWorkspace.shared.activateFileViewerSelecting([url]) }
        rail.onClose = { [weak self] url in self?.closeWorkspace(url) }
        // Persist the rail card color so it survives across sessions.
        rail.onSetColor = { [weak self] url, color in
            guard let self else { return }
            self.workspaceColors[url] = color.map { self.hexString($0) }
            self.persistSession()
        }
        WorkspaceStatus.shared.onChange = { [weak self] ws in
            guard let self else { return }
            let a = WorkspaceStatus.shared.rollup(ws)
            self.rail.setActivity(URL(fileURLWithPath: ws), a)
            if self.workspace?.path == ws {   // reflect the active workspace's status in the header icon
                self.headerIcon?.contentTintColor = a == .attn ? Theme.warning : a == .busy ? Theme.accent2 : Theme.fgDim
            }
        }

        explorer = FileTreeView(frame: NSRect(x: 0, y: 0, width: 220, height: 480))
        explorer.onOpenFile = { [weak self] url in self?.openFile(url) }
        explorer.onChanged = { [weak self] in self?.refreshGit() }
        explorer.onFileDeleted = { [weak self] url in
            guard let self else { return }
            if self.tabBar.tabs.contains(url.path) { self.closeTab(url.path) }
        }
        explorer.onFileRenamed = { [weak self] old, new in
            guard let self else { return }
            if self.tabBar.tabs.contains(old.path) {
                self.closeTab(old.path)
                self.openFile(new)
            }
        }

        // The auxiliary panels (search/git/preview/changes) are dock panels now —
        // created here, added to the dock grid on demand (⌘⇧F/G/V/C).
        searchPanel = SearchPanel(frame: .zero)
        searchPanel.onOpen = { [weak self] path, line, col in
            self?.openFileAt(URL(fileURLWithPath: path), line: line, column: col)
        }
        gitPanel = GitPanel(frame: .zero)
        gitPanel.onOpenDiff = { [weak self] rel in self?.openGitDiff(rel) }
        sourceControl = SourceControlView(changes: gitPanel)
        sourceControl.graph.onOpenFile = { [weak self] rel in
            guard let self, let ws = self.workspace else { return }
            self.openFile(URL(fileURLWithPath: ws.path).appendingPathComponent(rel))
        }
        previewPanel = PreviewPanel(frame: .zero)
        previewPanel.onFocused = { [weak self] in self?.focusGroup(containing: self?.previewPanel) }
        // Preview capture → type the PNG path into the running agent terminal so it can
        // read the screenshot (riven's capture-to-Claude).
        previewPanel.onCapture = { [weak self] path in
            self?.deliverToAgent(" " + path + " ")   // queues + opens the picker if no agent is running
        }
        changesPanel = ChangesPanel(frame: .zero)
        changesPanel.onOpen = { [weak self] path in self?.openAgentEdit(path) }
        changesPanel.onReverted = { [weak self] path in self?.reloadIfOpen(path) }

        sidebarSplitV.addArrangedSubview(rail)
        sidebarSplitV.addArrangedSubview(explorer)
        sidebarSplitV.autoresizingMask = [.width, .height]
        sidebarContainer.addSubview(sidebarSplitV)   // fills below the head
        // Sidebar head (riven's .sidebar-head): the macOS traffic lights on the left,
        // the "패널 추가" button in this left fixed area (NOT over the dock).
        let sidebarHead = makeSidebarHead(width: 220, height: titleH)
        sidebarHead.frame = NSRect(x: 0, y: (H - statusH) - titleH, width: 220, height: titleH)
        sidebarHead.autoresizingMask = [.width, .minYMargin]
        sidebarContainer.addSubview(sidebarHead)

        // --- Editor panel content: file tabs + Monaco (hosted as a dock panel) ---
        let paneH = bodyH
        editorPane = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: paneH))
        tabBar = TabBar(frame: NSRect(x: 0, y: paneH - 30, width: 640, height: 30))
        tabBar.onSelect = { [weak self] path in self?.selectTab(path) }
        tabBar.onClose = { [weak self] path in self?.closeTab(path) }
        tabBar.onCloseOthers = { [weak self] keep in
            guard let self, let ws = self.workspace else { return }
            let st = self.state(for: ws)
            for p in st.openTabs where p != keep { self.editor.close(path: p) }
            st.openTabs = st.openTabs.contains(keep) ? [keep] : []
            st.activeTab = st.openTabs.first
            self.tabBar.closeOthers(except: keep)
        }
        tabBar.onCloseAll = { [weak self] in
            guard let self, let ws = self.workspace else { return }
            let st = self.state(for: ws)
            for p in st.openTabs { self.editor.close(path: p) }
            st.openTabs = []; st.activeTab = nil
            self.tabBar.closeAll()
        }
        editor = EditorView(frame: NSRect(x: 0, y: 0, width: 640, height: paneH - 30))
        wireEditor(editor, tabBar, secondary: false)
        // LSP diagnostics → Monaco markers (both editor groups).
        lsp.onDiagnostics = { [weak self] uri, diags in
            let path = uri.replacingOccurrences(of: "file://", with: "")
            self?.editor.setDiagnostics(path: path, diags: diags)
        }
        // The editor fills the whole pane — file tabs are rendered INSIDE the WebView
        // (one strip per split group). `tabBar` stays as a headless state tracker
        // (flat tab list, dirty state, ⌘W target, persistence) but isn't shown.
        editor.translatesAutoresizingMaskIntoConstraints = false
        editorPane.addSubview(editor)
        NSLayoutConstraint.activate([
            editor.topAnchor.constraint(equalTo: editorPane.topAnchor),
            editor.leadingAnchor.constraint(equalTo: editorPane.leadingAnchor),
            editor.trailingAnchor.constraint(equalTo: editorPane.trailingAnchor),
            editor.bottomAnchor.constraint(equalTo: editorPane.bottomAnchor)
        ])

        // --- Right area: a thin draggable header strip over the dock. It keeps the
        // dock tabs OUT of the window's titlebar drag region (so dragging a tab splits
        // panels instead of moving the window), and provides the window drag/zoom. ---
        let rightW = W - 220
        let rightContainer = NSView(frame: NSRect(x: 0, y: 0, width: rightW, height: H - statusH))
        let dockHeader = DraggableStrip(frame: NSRect(x: 0, y: bodyH, width: rightW, height: titleH))
        dockHeader.wantsLayer = true; dockHeader.layer?.backgroundColor = Theme.bg2.cgColor
        dockHeader.autoresizingMask = [.width, .minYMargin]
        let dhair = NSView(); dhair.wantsLayer = true; dhair.layer?.backgroundColor = Theme.hairline.cgColor
        dhair.frame = NSRect(x: 0, y: 0, width: rightW, height: 1); dhair.autoresizingMask = [.width, .maxYMargin]
        dockHeader.addSubview(dhair)
        // Active workspace info (folder + branch) so the header isn't empty.
        let hIcon = NSImageView(); hIcon.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        hIcon.contentTintColor = Theme.fgDim; hIcon.translatesAutoresizingMaskIntoConstraints = false
        let hLabel = NSTextField(labelWithString: ""); hLabel.font = .systemFont(ofSize: 12, weight: .medium)
        hLabel.textColor = Theme.fg; hLabel.translatesAutoresizingMaskIntoConstraints = false
        headerLabel = hLabel; headerIcon = hIcon
        dockHeader.addSubview(hIcon); dockHeader.addSubview(hLabel)

        // Right side of the header: usage widget + settings gear (moved here from the
        // bottom status bar per the app-header layout).
        let uIcon = NSImageView()
        uIcon.image = NSImage(systemSymbolName: "gauge.with.dots.needle.33percent", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        uIcon.contentTintColor = Theme.fgDim; uIcon.translatesAutoresizingMaskIntoConstraints = false
        let uLabel = NSTextField(labelWithString: ""); uLabel.font = .systemFont(ofSize: 11)
        uLabel.textColor = Theme.fgDim; uLabel.translatesAutoresizingMaskIntoConstraints = false
        headerUsage = uLabel
        let usageItem = NSStackView(views: [uIcon, uLabel])
        usageItem.orientation = .horizontal; usageItem.spacing = 5; usageItem.alignment = .centerY
        usageItem.translatesAutoresizingMaskIntoConstraints = false
        usageItem.isHidden = true
        usageItem.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(headerUsageClicked)))
        headerUsageItem = usageItem
        let gear = NSButton()
        gear.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        gear.image?.isTemplate = true; gear.imagePosition = .imageOnly; gear.isBordered = false
        gear.contentTintColor = Theme.fgDim; gear.target = self; gear.action = #selector(settingsMenu)
        gear.toolTip = t("menu.settings")
        gear.translatesAutoresizingMaskIntoConstraints = false
        (gear.cell as? NSButtonCell)?.highlightsBy = []
        usageItem.toolTip = "사용량 (클릭: 상세)"
        let rightCluster = NSStackView(views: [usageItem, gear])
        rightCluster.orientation = .horizontal; rightCluster.spacing = 12; rightCluster.alignment = .centerY
        rightCluster.translatesAutoresizingMaskIntoConstraints = false
        dockHeader.addSubview(rightCluster)

        NSLayoutConstraint.activate([
            hIcon.leadingAnchor.constraint(equalTo: dockHeader.leadingAnchor, constant: 12),
            hIcon.centerYAnchor.constraint(equalTo: dockHeader.centerYAnchor),
            hLabel.leadingAnchor.constraint(equalTo: hIcon.trailingAnchor, constant: 6),
            hLabel.centerYAnchor.constraint(equalTo: dockHeader.centerYAnchor),
            rightCluster.trailingAnchor.constraint(equalTo: dockHeader.trailingAnchor, constant: -12),
            rightCluster.centerYAnchor.constraint(equalTo: dockHeader.centerYAnchor),
            hLabel.trailingAnchor.constraint(lessThanOrEqualTo: rightCluster.leadingAnchor, constant: -10)
        ])
        dockHost = NSView(frame: NSRect(x: 0, y: 0, width: rightW, height: bodyH))
        dockHost.wantsLayer = true
        dockHost.layer?.backgroundColor = Theme.bg.cgColor
        dockHost.autoresizingMask = [.width, .height]
        rightContainer.addSubview(dockHost)
        rightContainer.addSubview(dockHeader)

        body.addArrangedSubview(sidebarContainer)
        body.addArrangedSubview(rightContainer)

        root.addSubview(statusBar)
        root.addSubview(body)
        window.contentView = root

        DispatchQueue.main.async {
            body.setPosition(220, ofDividerAt: 0)
            sidebarSplitV.setPosition(190, ofDividerAt: 0)   // rail shows ~2 cards + a bit
        }
    }

    // The sidebar head (riven's .sidebar-head): draggable like a native titlebar
    // (window move + double-click zoom), reserves the traffic-light zone on the left,
    // and hosts the "패널 추가" button just to their right — in the left fixed area.
    private var sidebarView: NSView!
    private func makeSidebarHead(width: CGFloat, height: CGFloat) -> NSView {
        let strip = DraggableStrip(frame: NSRect(x: 0, y: 0, width: width, height: height))
        strip.wantsLayer = true
        strip.layer?.backgroundColor = Theme.bg2.cgColor
        let addBtn = NSButton(title: " 패널 추가", target: self, action: #selector(quickPanelMenu))
        addBtn.image = NSImage(systemSymbolName: "rectangle.split.2x1", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
        addBtn.imagePosition = .imageLeading
        addBtn.isBordered = false
        addBtn.contentTintColor = Theme.fgDim
        addBtn.font = .systemFont(ofSize: 12, weight: .medium)
        addBtn.translatesAutoresizingMaskIntoConstraints = false
        strip.addSubview(addBtn)
        NSLayoutConstraint.activate([
            addBtn.trailingAnchor.constraint(equalTo: strip.trailingAnchor, constant: -8), // right of the sidebar head
            addBtn.centerYAnchor.constraint(equalTo: strip.centerYAnchor)
        ])
        return strip
    }

    // Create (once) an empty workspace dock. The terminal is added AFTER the dock
    // is in the window (see activate) — a libghostty surface created off-window
    // with a zero frame never spawns its shell.
    private func makeDock(for st: WorkspaceState) -> DockManager {
        let dock = DockManager()
        dock.onActivePanel = { [weak self] p in self?.dockActivePanelChanged(p) }
        dock.onAddTerminal = { [weak self] in self?.newTerminal() }
        dock.onOpenEditor = { [weak self] in self?.showEditorPane(); self?.editor.focusEditor() }
        dock.setRoot(DockGroup())
        return dock
    }

    // A terminal is just a dock panel whose content is one libghostty TerminalView
    // (riven: each terminal is a `term-N` dockview panel). New/split terminals add
    // more of these; multiple in a group become tabs, exactly like every panel.
    // Created with a real frame + only while its host dock is in the window.
    private func makeTerminalPanel(for st: WorkspaceState, agent: AgentDiscovery.Agent? = nil) -> DockPanel {
        st.terminalSeq += 1
        // An agent panel runs the CLI directly (claude launches immediately, no typing)
        // and is titled/iconed as that agent (e.g. "Claude Code" + sparkles).
        let tv = TerminalView(frame: dockHost.bounds, workdir: st.url.path, command: agent?.cmd)
        tv.autoresizingMask = [.width, .height]
        let title = agent.map { "\($0.name)" } ?? t("title.terminal")
        let icon = NSImage(systemSymbolName: agent?.symbol ?? "terminal", accessibilityDescription: nil)
        let p = DockPanel(id: "term-\(abs(st.url.path.hashValue))-\(st.terminalSeq)", title: title,
            icon: icon, content: tv, closable: true)
        p.autoTitle = true    // follow OSC titles for BOTH plain terminals AND agents, so
                              // "change the terminal title to X" from an agent works.
        // OSC 0/2 title from the shell/agent → update the tab. A path-like title shows
        // its last component; an explicit name (no slash) is used verbatim.
        tv.onTitle = { [weak self, weak p] title in
            guard let p, p.autoTitle, !title.isEmpty else { return }
            p.title = title.contains("/") ? (title as NSString).lastPathComponent : title
            self?.refreshDockTabs()
        }
        if agent != nil { markAgentSession() }
        let wsPath = st.url.path, paneId = p.id
        p.onActivate = { [weak self, weak tv, weak p] in     // looking at it clears attn (badge + workspace)
            tv?.window?.makeFirstResponder(tv)
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: false)
            if p?.badge != nil { p?.badge = nil; tv?.setRingState(nil); self?.refreshDockTabs() }
        }
        p.onClose = { [weak tv] in tv?.dispose(); WorkspaceStatus.shared.clearPane(ws: wsPath, pane: paneId) }
        // A bell or desktop-notification means the agent FINISHED a turn / needs input
        // (riven's pty:bell + pty:done). This is the authoritative "done" signal —
        // long-running agents never emit a shell COMMAND_FINISHED, so busy would
        // otherwise stay stuck. Always clear busy; then raise the attention ember
        // ring UNLESS you're already watching this exact pane (then it's just seen).
        tv.onActivity = { [weak self, weak tv, weak p] in
            guard let self, let p else { return }
            self.markAgentSession()   // agent activity (bell/notification) → track its edits
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, busy: false)
            let watching = self.window?.firstResponder === tv && self.window?.isKeyWindow == true
            if watching {
                p.badge = nil; tv?.setRingState(nil)
                WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: false)
            } else {
                p.badge = "attn"; tv?.setRingState("attn")
                WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: true)
            }
            self.refreshDockTabs()
        }
        tv.onFocused = { [weak self, weak tv, weak p] in
            self?.focusGroup(containing: tv)
            // Looking at a pane clears its attention (badge + ember ring + workspace dot).
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: false)
            if p?.badge == "attn" { p?.badge = nil; tv?.setRingState(nil); self?.refreshDockTabs() }
        }
        // Busy while an agent/command actively works. Shown ONLY on the left workspace
        // rail (WorkspaceStatus) — no tab dot, no panel border ring (user asked to keep
        // the running indicator to the rail; the ring is reserved for completion/attn).
        tv.onBusy = { [weak self, weak p] in
            self?.markAgentSession()   // something is working in the terminal → track its edits
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, busy: true)
            guard let p, p.badge != "attn" else { return }   // attn (needs-attention) outranks busy
            if p.badge != "busy" { p.badge = "busy" }
        }
        // Output stopped (activity poller / progress done) → clear busy. Attention is
        // raised separately (onTurnDone / bell / notification), so this alone doesn't ping.
        tv.onIdle = { [weak self, weak tv, weak p] in
            self?.refreshChangesAndGit()   // a command finished → an agent may have edited files
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, busy: false)
            guard let p, p.badge == "busy" else { return }
            p.badge = nil; tv?.setRingState(nil); self?.refreshDockTabs()
        }
        // A substantial turn ended (activity poller). If you weren't watching this pane,
        // raise the attention ember + post a completion notification (deduped against the
        // agent's own desktop notification, which fires only when unfocused).
        tv.onTurnDone = { [weak self, weak tv, weak p] in
            guard let self, let p, let tv else { return }
            let watching = self.window?.firstResponder === tv && self.window?.isKeyWindow == true
            if !watching {
                p.badge = "attn"; tv.setRingState("attn")
                WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: true)
                self.refreshDockTabs()
            }
            // ONE notification per user turn (armed by Enter). An agent turn has several
            // output bursts — without this gate each burst notified (the 3× spam).
            guard tv.turnArmed else { return }
            tv.turnArmed = false
            if watching { return }   // you're looking at it → no banner, just the ring
            // Scraping the agent's actual reply from a TUI redraw is unreliable (it isn't
            // real selectable terminal text), so use a fixed message titled by WHICH
            // workspace finished — that's the useful signal.
            let wsName = (wsPath as NSString).lastPathComponent
            Notifications.post(title: wsName, body: "\(p.title) · \(t("term.done"))")
        }
        return p
    }

    // Rebuild the active dock's tab bars (after a badge change).
    private func refreshDockTabs() { activeDock?.groups.forEach { $0.tabBar.rebuild() } }

    // Pop the active panel out into its own OS window (riven's panel.popout ⌘⇧O) so it
    // can live on another monitor. Closing the window re-docks the panel.
    private var poppedOut: [String: (win: NSWindow, dock: DockManager, panel: DockPanel, delegate: PopoutDelegate)] = [:]
    @objc private func popoutMenu() {
        guard let dock = activeDock, let panel = dock.activeGroup?.activePanel else { NSSound.beep(); return }
        dock.detach(panel)   // remove from the dock WITHOUT disposing the content
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 480))
        host.wantsLayer = true; host.layer?.backgroundColor = Theme.bg.cgColor
        panel.content.frame = host.bounds
        panel.content.autoresizingMask = [.width, .height]
        host.addSubview(panel.content)
        let win = NSWindow(contentRect: host.bounds, styleMask: [.titled, .closable, .resizable, .miniaturizable],
                           backing: .buffered, defer: false)
        win.title = panel.title.isEmpty ? "riven" : panel.title
        win.contentView = host
        win.isReleasedWhenClosed = false
        win.center()
        let id = panel.id
        let delegate = PopoutDelegate { [weak self] in self?.redock(id) }
        win.delegate = delegate
        poppedOut[id] = (win, dock, panel, delegate)
        win.makeKeyAndOrderFront(nil)
    }
    private func redock(_ id: String) {
        guard let entry = poppedOut[id] else { return }
        poppedOut[id] = nil
        entry.panel.content.removeFromSuperview()
        entry.dock.addPanel(entry.panel, reference: entry.dock.activeGroup, direction: nil)
    }

    // User snippets stored as prefix→body in Settings["snippets"].
    private func loadSnippets() -> [[String: String]] {
        let d = (Settings.shared.object("snippets") as? [String: String]) ?? [:]
        return d.map { ["prefix": $0.key, "body": $0.value] }
    }

    // Re-title open singleton/aux panels for the current language, then repaint tabs.
    private func relocalizeOpenPanels() {
        let key = ["search": "title.search", "git": "title.git", "preview": "title.preview", "changes": "title.changes"]
        for (id, p) in auxDockPanels { if let k = key[id] { p.title = t(k) } }
        editorDockPanel?.title = t("title.editor")
        for ws in workspaces {
            state(for: ws).dock?.groups.forEach { g in g.tabBar.rebuild() }
        }
    }

    func refreshChangesAndGit() { refreshGit() }

    // A workspace has a live agent session once an agent is launched or a terminal
    // goes busy — from then on, file changes (minus our own editor saves) are recorded
    // as agent edits (riven gates on pgrep; ghostty hides the shell PID, so we gate on
    // the launch/busy signal instead).
    private func markAgentSession() { if let ws = workspace { agentSessionWorkspaces.insert(ws.path) } }

    // A file changed on disk (FSEvents). Record it as an agent edit (before/after from
    // the session baseline) and surface the Changes panel without stealing focus.
    private func handleFileChange(_ path: String) {
        guard let ws = workspace, path.hasPrefix(ws.path + "/"), !AgentEdits.isIgnored(path) else { return }
        guard agentSessionWorkspaces.contains(ws.path) else { return }   // only during an agent session
        guard let after = try? String(contentsOfFile: path, encoding: .utf8) else {
            // deleted / unreadable — ignore (riven skips unlink)
            return
        }
        // `before` is the SESSION baseline and stays fixed, so the diff is cumulative
        // (first add + later edit both show) — do NOT advance the baseline here.
        let before = AgentEdits.shared.baselineContent(path)
            ?? Git.showFile(cwd: ws.path, rel: String(path.dropFirst(ws.path.count + 1)))
        if before == after { AgentEdits.shared.resolve(path: path); return }   // reverted to baseline
        // Seed the baseline once (first time we see the file) so it's fixed thereafter.
        if AgentEdits.shared.baselineContent(path) == nil { AgentEdits.shared.updateBaseline(path, before ?? "") }
        AgentEdits.shared.record(path: path, workspace: ws.path, before: before ?? "", after: after, isNew: before == nil)
        ensureChangesPanel()
    }
    // Open the Changes panel (240px, right) WITHOUT stealing keyboard focus from the
    // terminal (riven's ensureChanges → restore prev active panel).
    private func ensureChangesPanel() {
        if auxDockPanels["changes"] != nil { changesPanel.refresh(); return }
        let prevResponder = window?.firstResponder
        toggleDockPanel("changes")
        if let prev = prevResponder { window?.makeFirstResponder(prev) }
    }

    // The terminal the user is working in: the first responder if it's a terminal,
    // else the active dock panel's terminal, else any terminal in the dock.
    private func currentTerminal() -> TerminalView? {
        if let r = window?.firstResponder as? TerminalView { return r }
        guard let dock = activeDock else { return nil }
        if let tv = dock.activeGroup?.activePanel?.content as? TerminalView { return tv }
        for g in dock.groups { for p in g.panels { if let tv = p.content as? TerminalView { return tv } } }
        return nil
    }
    private func currentTerminalPanel() -> DockPanel? {
        guard let dock = activeDock, let tv = currentTerminal() else { return nil }
        for g in dock.groups { for p in g.panels where p.content === tv { return p } }
        return nil
    }
    private func terminalPanels() -> [DockPanel] {
        (activeDock?.groups ?? []).flatMap { $0.panels }.filter { $0.content is TerminalView }
    }

    // ---- terminal commands (all go through the dock, like riven) ----
    private func newTerminal() {                       // ⌘T
        guard let dock = activeDock, let ws = workspace else { return }
        let p = makeTerminalPanel(for: state(for: ws))
        dock.addPanel(p, reference: currentTerminalPanel()?.group ?? dock.activeGroup, direction: nil)
        (p.content as? TerminalView)?.focusTerminal()
    }
    // Launch an agent in its own panel (titled "Claude Code" + icon), running the CLI
    // directly — not typed into a shell.
    private func launchAgent(_ agent: AgentDiscovery.Agent) {
        guard let dock = activeDock, let ws = workspace else { return }
        let p = makeTerminalPanel(for: state(for: ws), agent: agent)
        dock.addPanel(p, reference: currentTerminalPanel()?.group ?? dock.activeGroup, direction: nil)
        if let tv = p.content as? TerminalView { tv.focusTerminal(); flushAgentContext(into: tv) }
    }

    // contextBus: text (⌘L selection / preview capture) is delivered to a running agent
    // terminal, or — when none exists — QUEUED and the agent picker opened; the queue is
    // flushed into the agent once it launches (riven's contextBus.flushPending).
    private var pendingAgentContext: [String] = []
    private func deliverToAgent(_ text: String) {
        if let tv = currentTerminal() {
            tv.window?.makeFirstResponder(tv)
            tv.sendText(text)
        } else {
            pendingAgentContext.append(text)
            showQuickPanel()
        }
    }
    private func flushAgentContext(into tv: TerminalView) {
        guard !pendingAgentContext.isEmpty else { return }
        let texts = pendingAgentContext; pendingAgentContext = []
        // Give the agent a moment to boot before pasting the queued context.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { texts.forEach { tv.sendText($0) } }
    }
    // Bring the app forward and run a command in a fresh terminal (used by the
    // settings Account tab's "gh auth login").
    func runInTerminal(_ cmd: String) {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        newTerminalRunning(cmd)
    }
    // Open a terminal and run a command in it (agent launch) — waits for the shell
    // to spawn, then types the command (riven's addTerminal(cmd)).
    private func newTerminalRunning(_ cmd: String) {
        guard let dock = activeDock, let ws = workspace else { return }
        markAgentSession()   // launching an agent starts its edit-tracking session
        let p = makeTerminalPanel(for: state(for: ws))
        dock.addPanel(p, reference: currentTerminalPanel()?.group ?? dock.activeGroup, direction: nil)
        let tv = p.content as? TerminalView
        tv?.focusTerminal()
        // Wait for the shell to spawn its prompt, then type + run the command (Enter is
        // a real key event — sending "\r" as text doesn't execute it).
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { tv?.runCommand(cmd) }
    }
    private func splitTerminal(_ dir: DockDir) {       // ⌘D right / ⌘⇧D below
        guard let dock = activeDock, let ws = workspace else { return }
        let p = makeTerminalPanel(for: state(for: ws))
        dock.addPanel(p, reference: currentTerminalPanel()?.group ?? dock.activeGroup, direction: dir)
        (p.content as? TerminalView)?.focusTerminal()
    }
    private func selectTerminal(_ n: Int) {            // ⌃1..9
        let terms = terminalPanels()
        guard terms.indices.contains(n - 1) else { return }
        let p = terms[n - 1]; p.group?.select(id: p.id)
        (p.content as? TerminalView)?.focusTerminal()
    }
    private func cycleTerminal(_ delta: Int) {         // ⌘⇧] / ⌘⇧[
        let terms = terminalPanels()
        guard terms.count > 1, let cur = currentTerminalPanel(),
              let idx = terms.firstIndex(where: { $0.id == cur.id }) else { return }
        let next = terms[(idx + delta + terms.count) % terms.count]
        next.group?.select(id: next.id)
        (next.content as? TerminalView)?.focusTerminal()
    }
    // ⌃⌘←→↑↓ — move focus to the nearest dock group in a direction (any panel).
    private func focusDock(_ dir: DockDir) {
        guard let dock = activeDock, let cur = dock.activeGroup else { return }
        let cf = cur.convert(cur.bounds, to: dockHost)
        let cc = NSPoint(x: cf.midX, y: cf.midY)
        var best: DockGroup?; var bestDist = CGFloat.greatestFiniteMagnitude
        for g in dock.groups where g !== cur {
            let f = g.convert(g.bounds, to: dockHost)
            let dx = f.midX - cc.x, dy = f.midY - cc.y
            let inDir: Bool
            switch dir {
            case .left: inDir = dx < -1; case .right: inDir = dx > 1
            case .up: inDir = dy > 1; case .down: inDir = dy < -1; case .center: inDir = false
            }
            if !inDir { continue }
            let d = dx * dx + dy * dy
            if d < bestDist { bestDist = d; best = g }
        }
        guard let b = best else { return }
        dock.setActive(b)
        if let tv = b.activePanel?.content as? TerminalView { tv.focusTerminal() }
        else { window?.makeFirstResponder(b.activePanel?.content) }
    }

    // Ensure the editor panel is in the active dock (opens to the right of the
    // terminal the first time a file is opened — riven's ensureEditor).
    private func showEditorPane() {
        guard let dock = activeDock else { return }
        if editorDockPanel == nil {
            let p = DockPanel(id: "editor", title: t("title.editor"),
                icon: NSImage(systemSymbolName: "curlybraces", accessibilityDescription: nil),
                content: editorPane, closable: true)
            p.onClose = { [weak self] in self?.closeAllEditorTabs() }
            editorDockPanel = p
        }
        let p = editorDockPanel!
        if p.group == nil || p.group?.manager !== dock {
            // Append to the rightmost group so the editor sits to the right of the
            // terminals and BEFORE right-side aux panels are restored (stable order).
            dock.addPanel(p, reference: dock.groups.last, direction: .right)
        } else {
            p.group?.select(id: "editor")
        }
    }
    private func closeAllEditorTabs() {
        guard let ws = workspace else { return }
        let st = state(for: ws)
        for p in st.openTabs { editor.close(path: p) }
        st.openTabs = []; st.activeTab = nil
        tabBar.closeAll(); editor.showEmpty()
        editorDockPanel = nil
        persistSession()
    }

    // Wire the editor's callbacks (save/dirty/focus/LSP/AI/⌘L/goto-def).
    private func wireEditor(_ ed: EditorView, _ tab: TabBar, secondary: Bool) {
        ed.onFocused = { [weak self, weak ed] in self?.focusGroup(containing: ed) }
        ed.onSendToAgent = { [weak self] file, start, end, text in
            let lang = (file as NSString).pathExtension
            self?.deliverToAgent("@\(file):\(start)-\(end)\n```\(lang)\n\(text)\n```\n")
        }
        ed.onAgentRevert = { [weak self, weak ed] path, newAfter in
            try? newAfter.write(toFile: path, atomically: true, encoding: .utf8)
            AgentEdits.shared.updateBaseline(path, newAfter)
            if let e = AgentEdits.shared.edit(for: path) {
                AgentEdits.shared.record(path: path, workspace: self?.workspace?.path ?? "", before: e.before, after: newAfter, isNew: e.hasBaseline ? false : true)
                ed?.agentDiff(path: path, before: e.before, after: newAfter)
            }
            self?.reloadIfOpen(path)
        }
        ed.onSave = { [weak self] path, content in self?.save(path: path, content: content) }
        ed.onDirty = { [weak tab] path, dirty in tab?.setDirty(path, dirty) }
        ed.onOpenDef = { [weak self] path, line, column in self?.openFileAt(URL(fileURLWithPath: path), line: line, column: column) }
        // The WebView owns split-group tab rendering; these sync it back to native
        // state (which stays a flat per-workspace tab list for persistence).
        ed.onCloseTab = { [weak self] path in self?.closeTab(path) }
        ed.onActiveTab = { [weak self] path in
            guard let self else { return }
            if let ws = self.workspace { self.state(for: ws).activeTab = path }
            self.tabBar.setActive(path)
        }
        ed.onLSP = { [weak self] id, method, path, params in self?.handleLSP(id, method, path, params) }
        ed.onLSPSync = { [weak self] path, version, text in
            guard let self, let ws = self.workspace else { return }
            self.lsp.client(languageId: self.langId(path), rootPath: ws.path)?
                .didChange(uri: "file://\(path)", version: version, text: text)
        }
        ed.onAI = { [weak ed] prefix, suffix in
            AIProvider.shared.complete(prefix: prefix, suffix: suffix) { text in
                DispatchQueue.main.async { ed?.suggest(text ?? "") }
            }
        }
        ed.setFormatOnSave(Settings.shared.bool("formatOnSave", false))
        ed.setEditorKeymap(Settings.shared.string("editorKeymap", "vscode"))
        ed.setEditorKeys(Keys.editorChords())
        ed.setSnippets(loadSnippets())
    }
    private func dockActivePanelChanged(_ p: DockPanel?) { p?.onActivate?() }

    // A pane's content (terminal / editor) took keyboard focus → move the active
    // group ring to the group that owns it (riven's focus-follows-click).
    func focusGroup(containing view: NSView?) {
        guard let view, let dock = activeDock else { return }
        for g in dock.groups where g.activePanel?.content === view || view.isDescendant(of: g) {
            dock.setActive(g); break
        }
    }

    // Editor with no open tabs shows its empty state; the panel stays in the dock.
    private func hideEditorPane() { editor.showEmpty() }

    // ---- workspace / file ops ----
    private func openFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.begin { [weak self] resp in
            guard resp == .OK, let url = panel.url, let self else { return }
            let canon = url.standardizedFileURL.resolvingSymlinksInPath()
            // Allow MULTIPLE workspaces on the same folder (parallel agent sessions like
            // cmux). Identity is disambiguated with a URL fragment (#2, #3…) that .path
            // ignores — so the filesystem/explorer/git/terminal all use the same real
            // path, while workspaces/states/rail treat them as distinct instances.
            let ws = self.uniqueWorkspaceURL(for: canon)
            self.rail.addWorkspace(ws)
            self.activate(ws)
            self.persistSession()
        }
    }

    private var workspaces: [URL] = []
    private var states: [URL: WorkspaceState] = [:]      // per-workspace editor tabs + terminal

    // A unique identity URL for a folder — the bare path the first time, then path#2,
    // #3… for additional instances. `.path` strips the fragment so all fs ops share the
    // real folder while each workspace keeps a distinct identity.
    private func uniqueWorkspaceURL(for canon: URL) -> URL {
        if !workspaces.contains(canon) { return canon }
        var n = 2
        while let u = URL(string: canon.absoluteString + "#\(n)") {
            if !workspaces.contains(u) { return u }
            n += 1
        }
        return canon
    }

    private func state(for url: URL) -> WorkspaceState {
        if let s = states[url] { return s }
        let s = WorkspaceState(url: url); states[url] = s; return s
    }

    // Make a workspace active: swap in this workspace's dock (its own terminals +
    // layout), move the shared editor into it, restore tabs, re-root explorer/git.
    private func activate(_ url: URL) {
        if !workspaces.contains(url) { workspaces.append(url) }
        let st = state(for: url)

        // Remember which aux panels the OUTgoing workspace had open, so switching back
        // restores them (they don't just vanish).
        if let old = workspace, old != url { state(for: old).openAux = Set(auxDockPanels.keys) }

        // Detach the shared editor + aux panels from the OUTgoing workspace's dock
        // (their views are singletons; only one dock can hold them at a time).
        if let old = activeDock {
            if let ep = editorDockPanel, ep.group?.manager === old { old.detach(ep) }
            for (_, ap) in auxDockPanels where ap.group?.manager === old { old.detach(ap) }
        }
        auxDockPanels.removeAll()

        // Swap the dock view for this workspace's dock (create it on first visit).
        activeDock?.container.removeFromSuperview()
        let isNew = (st.dock == nil)
        let dock = st.dock ?? { let d = makeDock(for: st); st.dock = d; return d }()
        dock.container.frame = dockHost.bounds
        dock.container.autoresizingMask = [.width, .height]
        dockHost.addSubview(dock.container)
        activeDock = dock
        workspace = url
        // Add the default terminal now that the dock is in the window (a libghostty
        // surface must be created in-window with a real size to spawn its shell).
        if isNew, let g = dock.activeGroup, g.panels.isEmpty {
            let term = makeTerminalPanel(for: st)
            g.add(term)
            (term.content as? TerminalView)?.focusTerminal()
        }

        // Restore this workspace's editor tabs (adds the editor panel if needed).
        rebuildTabs(for: st)
        // Restore the aux panels this workspace had open (search/git/preview/changes).
        for id in ["search", "git", "preview", "changes"] where st.openAux.contains(id) {
            if auxDockPanels[id] == nil { toggleDockPanel(id) }
        }

        explorer.setRoot(url)
        searchPanel.setRoot(url); gitPanel.setRoot(url); changesPanel.setWorkspace(url)
        window.title = "riven — \(url.lastPathComponent)"
        statusBar.setWorkspaceName(url.lastPathComponent)
        // Header: folder name + dimmed path.
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let short = url.path.hasPrefix(home) ? "~" + url.path.dropFirst(home.count) : url.path
        let hs = NSMutableAttributedString(string: url.lastPathComponent,
            attributes: [.foregroundColor: Theme.fg, .font: NSFont.systemFont(ofSize: 12, weight: .medium)])
        hs.append(NSAttributedString(string: "   \(short)",
            attributes: [.foregroundColor: Theme.fgDim, .font: NSFont.systemFont(ofSize: 11)]))
        headerLabel?.attributedStringValue = hs
        rail.setActive(url)   // keep the highlighted card in sync with the shown workspace
        refreshGit()

        // Agent-edit tracking: snapshot the session baseline + watch the tree so files
        // the agent writes appear in the Changes panel with before/after diffs.
        AgentEdits.shared.snapshot(workspace: url)
        agentWatch?.stop()
        agentWatch = AgentWatch(root: url) { [weak self] path in self?.handleFileChange(path) }
    }

    private func switchWorkspace(_ url: URL) { activate(url); persistSession() }

    // Close a workspace: tear down its dock + state, switch to another (or empty).
    private func closeWorkspace(_ url: URL) {
        if let st = states[url] {
            st.dock?.container.removeFromSuperview()
            for p in st.dock?.groups.flatMap({ $0.panels }) ?? [] { (p.content as? TerminalView)?.dispose() }
        }
        states[url] = nil
        workspaces.removeAll { $0 == url }
        if workspace == url {
            agentWatch?.stop(); agentWatch = nil
            if let next = workspaces.last { activate(next) }
            else {
                workspace = nil; activeDock = nil
                editorDockPanel = nil; auxDockPanels.removeAll()
                editor.showEmpty(); tabBar.closeAll()
                explorer.clear()                 // no workspace → empty the file tree too
                statusBar.setWorkspaceName(nil); statusBar.setBranch(nil); window.title = "riven"
            }
        }
        persistSession()
    }

    // ---- session persistence (open folders + tabs, restored on next launch) ----
    private func persistSession() {
        var tabs: [String: Any] = [:]
        var actives: [String: Any] = [:]
        for url in workspaces {
            let st = state(for: url)
            tabs[url.absoluteString] = st.openTabs   // absoluteString keeps #2/#3 instance identity
            if let a = st.activeTab { actives[url.absoluteString] = a }
        }
        var colors: [String: String] = [:]
        for url in workspaces { if let hex = workspaceColors[url] { colors[url.absoluteString] = hex } }
        let session: [String: Any] = [
            "workspaces": workspaces.map { $0.absoluteString },
            "active": workspace?.absoluteString ?? "",
            "tabs": tabs,
            "activeTab": actives,
            "colors": colors
        ]
        Settings.shared.set("session", session)
    }
    // sRGB hex for a rail card color (persisted); Theme.hex parses it back.
    private func hexString(_ c: NSColor) -> String {
        let s = c.usingColorSpace(.sRGB) ?? c
        return String(format: "#%02X%02X%02X",
                      Int(round(s.redComponent * 255)), Int(round(s.greenComponent * 255)), Int(round(s.blueComponent * 255)))
    }

    private func restoreSession() {
        guard let s = Settings.shared.object("session"),
              let keys = s["workspaces"] as? [String], !keys.isEmpty else { return }
        let tabs = s["tabs"] as? [String: Any] ?? [:]
        let actives = s["activeTab"] as? [String: Any] ?? [:]
        let colors = s["colors"] as? [String: String] ?? [:]
        let fm = FileManager.default
        var restored: [URL] = []
        for key in keys {
            // Backward-compatible: old sessions stored bare paths, new ones absoluteString.
            let url = URL(string: key) ?? URL(fileURLWithPath: key)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { continue }
            let st = state(for: url)
            st.openTabs = (tabs[key] as? [String] ?? []).filter { fm.fileExists(atPath: $0) }
            st.activeTab = (actives[key] as? String).flatMap { st.openTabs.contains($0) ? $0 : st.openTabs.last }
            rail.addWorkspace(url)
            if let hex = colors[key] { workspaceColors[url] = hex; rail.setColor(url, Theme.hex(hex)) }   // restore card color
            restored.append(url)
        }
        guard !restored.isEmpty else { return }
        workspaces = restored
        let activeKey = s["active"] as? String
        let active = restored.first { $0.absoluteString == activeKey } ?? restored.first!
        activate(active)
    }

    // Rebuild the tab bar + active editor model for a workspace's open tabs.
    private func rebuildTabs(for st: WorkspaceState) {
        tabBar.closeAll()
        for p in st.openTabs { tabBar.open(p) }
        if let active = st.activeTab {
            showEditorPane()
            tabBar.setActive(active)
            showTabContent(active)
            statusBar.setFileInfo(fileInfo(active))
        } else {
            hideEditorPane()   // workspace has no open tabs → terminal full width
            editor.showEmpty()
            statusBar.setFileInfo("")
        }
    }

    private func refreshGit() {
        guard let ws = workspace else { return }
        DispatchQueue.global(qos: .utility).async {
            let branch = Git.branch(cwd: ws.path)
            let status = Git.status(cwd: ws.path)
            DispatchQueue.main.async {
                self.statusBar.setBranch(branch)
                self.rail.setBranch(ws, branch)
                self.explorer.setGitStatus(status)
                self.gitPanel.refresh()   // keep the Source Control panel live
            }
        }
    }

    private var openPaths: Set<String> {   // paths open in the current workspace
        guard let ws = workspace else { return [] }
        return Set(state(for: ws).openTabs)
    }

    // Open a file and jump to (line, column) — used by search results. Reveal is
    // deferred a beat so Monaco's model/layout exists before we move the cursor.
    private func openFileAt(_ url: URL, line: Int, column: Int) {
        openFile(url)
        let path = url.path
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            self?.editor.reveal(path: path, line: line, column: column)
        }
    }

    private func openFile(_ url: URL) {
        RLog.log("openFile \(url.lastPathComponent) ws=\(workspace?.lastPathComponent ?? "nil")")
        guard let ws = workspace else { RLog.log("openFile: no workspace!"); return }
        let st = state(for: ws)
        let path = url.path
        explorer.reveal(url)   // keep the explorer selection on the active file
        if st.openTabs.contains(path) {
            st.activeTab = path
            showEditorPane()
            tabBar.open(path)
            editor.open(path: path, content: "")   // Monaco reuses the existing model
            statusBar.setFileInfo(fileInfo(path))
            return
        }
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            RLog.log("openFile: cannot read \(path) as UTF-8"); return
        }
        RLog.log("openFile: read \(content.count) chars, showing editor")
        st.openTabs.append(path)
        st.activeTab = path
        showEditorPane()
        tabBar.open(path)
        editor.open(path: path, content: content)
        statusBar.setFileInfo(fileInfo(path))
        fetchBlame(path)
        persistSession()
        let lang = langId(path)
        DispatchQueue.global(qos: .userInitiated).async {
            self.lsp.client(languageId: lang, rootPath: ws.path)?
                .didOpen(uri: "file://\(path)", languageId: lang, text: content)
        }
    }

    // Monaco/LSP language id from extension.
    private func langId(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "ts": return "typescript"; case "tsx": return "tsx"
        case "js", "mjs", "cjs": return "javascript"; case "jsx": return "jsx"
        case "py": return "python"; case "rs": return "rust"; case "go": return "go"
        case "swift": return "swift"; case "json": return "json"; case "css": return "css"
        default: return "plaintext"
        }
    }

    // Route an LSP request from Monaco to the language server, reply with result.
    private func handleLSP(_ id: Int, _ method: String, _ path: String, _ params: [String: Any]) {
        guard let ws = workspace,
              let client = lsp.client(languageId: langId(path), rootPath: ws.path) else {
            editor.lspRespond(id: id, result: nil); return
        }
        let uri = "file://\(path)"
        let line = params["line"] as? Int ?? 0, char = params["char"] as? Int ?? 0
        let reply: (Any?) -> Void = { [weak self] result in
            DispatchQueue.main.async { self?.editor.lspRespond(id: id, result: result) }
        }
        switch method {
        case "completion": client.completion(uri: uri, line: line, char: char, reply)
        case "hover":      client.hover(uri: uri, line: line, char: char, reply)
        case "definition": client.definition(uri: uri, line: line, char: char, reply)
        case "references": client.references(uri: uri, line: line, char: char, reply)
        default: reply(nil)
        }
    }

    // GitLens-style inline blame: fetch on a background thread, format, send.
    private func fetchBlame(_ path: String) {
        DispatchQueue.global(qos: .utility).async {
            let blame = Git.blame(file: path)
            guard !blame.isEmpty else { return }
            let map = blame.mapValues { "\($0.author), \(Self.relativeTime($0.time))  ·  \($0.summary.prefix(50))" }
            DispatchQueue.main.async { self.editor.setBlame(path: path, map: map) }
        }
    }

    private static func relativeTime(_ epoch: Int) -> String {
        let d = max(0, Int(Date().timeIntervalSince1970) - epoch)
        if d < 60 { return "방금 전" }
        if d < 3600 { return "\(d/60)분 전" }
        if d < 86400 { return "\(d/3600)시간 전" }
        if d < 86400*7 { return "\(d/86400)일 전" }
        if d < 86400*30 { return "\(d/(86400*7))주 전" }
        if d < 86400*365 { return "\(d/(86400*30))개월 전" }
        return "\(d/(86400*365))년 전"
    }

    private func selectTab(_ path: String) {
        if let ws = workspace { state(for: ws).activeTab = path }
        tabBar.setActive(path)
        showTabContent(path)
        statusBar.setFileInfo(fileInfo(path))
        explorer.reveal(URL(fileURLWithPath: path))   // explorer follows the active tab
    }

    // Show a tab in the editor. Passes the real disk content so a model that was
    // never created (restored tab, not yet opened this session) is built with its
    // contents; if the model already exists, Monaco reuses it (keeping edits) and
    // the content is ignored.
    private func showTabContent(_ path: String) {
        let content = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        editor.open(path: path, content: content)
    }

    private func fileInfo(_ path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        let lang: [String: String] = ["ts":"TypeScript","tsx":"TypeScript JSX","js":"JavaScript",
            "jsx":"JavaScript JSX","swift":"Swift","py":"Python","rs":"Rust","go":"Go","json":"JSON",
            "md":"Markdown","css":"CSS","html":"HTML","yaml":"YAML","yml":"YAML","sh":"Shell"]
        return lang[ext] ?? (ext.isEmpty ? "Plain Text" : ext.uppercased())
    }

    // Close a tab. If it has unsaved changes, prompt to save first (riven confirm).
    // When the last tab closes, the editor dock panel itself is removed (⌘W in the
    // editor closes files one-by-one, then the panel).
    private func closeTab(_ path: String) {
        if tabBar.isDirty(path) {
            let a = NSAlert()
            a.messageText = "\((path as NSString).lastPathComponent)의 변경 사항을 저장하시겠습니까?"
            a.informativeText = "저장하지 않으면 변경 내용이 사라집니다."
            a.addButton(withTitle: "저장")
            a.addButton(withTitle: "저장 안 함")
            a.addButton(withTitle: "취소")
            switch a.runModal() {
            case .alertFirstButtonReturn:           // 저장 then close
                editor.requestSave(path: path)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.finishCloseTab(path) }
                return
            case .alertSecondButtonReturn: break     // 저장 안 함 → fall through to close
            default: return                          // 취소
            }
        }
        finishCloseTab(path)
    }
    private func finishCloseTab(_ path: String) {
        var emptied = false
        if let ws = workspace {
            let st = state(for: ws)
            st.openTabs.removeAll { $0 == path }
            if st.activeTab == path { st.activeTab = st.openTabs.last }
            emptied = st.openTabs.isEmpty
        }
        editor.close(path: path)
        tabBar.close(path)
        // Last tab gone → tear down the editor dock panel entirely.
        if emptied, let ep = editorDockPanel {
            activeDock?.removePanel(ep)      // triggers onClose → closeAllEditorTabs → editorDockPanel = nil
        }
        persistSession()
    }

    private func save(path: String, content: String) {
        // Format-on-save with the PROJECT's prettier + eslint --fix (real config/plugins),
        // off the main thread. Prettier runs over stdin; eslint --fix operates on the
        // written file; the final on-disk text is pushed back to the editor.
        if Settings.shared.bool("formatOnSave", false), let root = workspace {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                var text = content
                if let f = self.formatWithPrettier(root: root, path: path, content: text) { text = f }
                try? text.write(toFile: path, atomically: true, encoding: .utf8)
                self.runEslintFix(root: root, path: path)   // in-place on the file
                let final = (try? String(contentsOfFile: path, encoding: .utf8)) ?? text
                DispatchQueue.main.async {
                    self.editor.markSaved(path: path)
                    if final != content { self.editor.open(path: path, content: final) }
                    AgentEdits.shared.updateBaseline(path, final)
                    self.refreshGit()
                }
            }
            return
        }
        writeAndMark(path: path, content: content)
    }
    private func runEslintFix(root: URL, path: String) {
        let bin = root.path + "/node_modules/.bin/eslint"
        guard FileManager.default.isExecutableFile(atPath: bin) else { return }
        let p = Process(); p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["--fix", path]
        p.currentDirectoryURL = root
        p.standardOutput = Pipe(); p.standardError = Pipe()
        guard (try? p.run()) != nil else { return }
        p.waitUntilExit()
    }
    private func writeAndMark(path: String, content: String) {
        do {
            try content.write(toFile: path, atomically: true, encoding: .utf8)
            editor.markSaved(path: path)
            AgentEdits.shared.updateBaseline(path, content)   // our own save isn't an agent edit
            refreshGit()
        } catch { NSSound.beep() }
    }
    // Run the workspace's prettier over `content` (via --stdin-filepath so its config +
    // parser inference apply). Returns nil if prettier isn't installed or errors.
    private func formatWithPrettier(root: URL, path: String, content: String) -> String? {
        let bin = root.path + "/node_modules/.bin/prettier"
        guard FileManager.default.isExecutableFile(atPath: bin) else { return nil }
        let p = Process(); p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["--stdin-filepath", path]
        p.currentDirectoryURL = root
        let inPipe = Pipe(), outPipe = Pipe(); p.standardInput = inPipe; p.standardOutput = outPipe; p.standardError = Pipe()
        guard (try? p.run()) != nil else { return nil }
        inPipe.fileHandleForWriting.write(content.data(using: .utf8) ?? Data())
        inPipe.fileHandleForWriting.closeFile()
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0, let out = String(data: outData, encoding: .utf8), !out.isEmpty else { return nil }
        return out
    }

    private func updateTitle(path: String, dirty: Bool) {
        let name = URL(fileURLWithPath: path).lastPathComponent
        let ws = workspace?.lastPathComponent ?? "riven"
        window.title = "riven — \(ws)" + (dirty ? "  •  \(name) (수정됨)" : "  •  \(name)")
    }

    // ---- menu (keyEquivalents are the reliable native shortcut path) ----
    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem(); mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: t("menu.about"), action: nil, keyEquivalent: "")
        addRemap(appMenu, t("menu.settings"), "app.settings", #selector(settingsMenu))
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: t("menu.quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: t("menu.file"))
        addRemap(fileMenu, t("menu.addPanel"), "file.addPanel", #selector(quickPanelMenu))   // riven ⌘O
        addRemap(fileMenu, t("menu.quickOpen"), "file.quickOpen", #selector(quickOpenMenu))
        addRemap(fileMenu, t("menu.commandPalette"), "file.commandPalette", #selector(commandPaletteMenu))
        fileMenu.addItem(.separator())
        addRemap(fileMenu, t("menu.newWorkspace"), "file.newWorkspace", #selector(openFolderMenu))
        addRemap(fileMenu, t("menu.save"), "file.save", #selector(saveMenu))
        addRemap(fileMenu, t("menu.closeTab"), "file.closeTab", #selector(closeTabMenu))
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem(); mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: t("menu.edit"))
        // Standard edit actions so ⌘C/⌘V/⌘Z/⌘A work in Monaco/inputs.
        add(editMenu, t("menu.undo"), Selector(("undo:")), "z", [.command])
        add(editMenu, t("menu.redo"), Selector(("redo:")), "z", [.command, .shift])
        editMenu.addItem(.separator())
        add(editMenu, t("menu.cut"), #selector(NSText.cut(_:)), "x", [.command])
        add(editMenu, t("menu.copy"), #selector(NSText.copy(_:)), "c", [.command])
        add(editMenu, t("menu.paste"), #selector(NSText.paste(_:)), "v", [.command])
        add(editMenu, t("menu.selectAll"), #selector(NSText.selectAll(_:)), "a", [.command])
        editItem.submenu = editMenu

        let viewItem = NSMenuItem(); mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: t("menu.view"))
        addRemap(viewMenu, t("menu.toggleSidebar"), "view.toggleSidebar", #selector(toggleSidebarMenu))
        addRemap(viewMenu, t("menu.search"), "view.search", #selector(searchMenu))
        addRemap(viewMenu, t("menu.git"), "view.git", #selector(gitMenu))
        addRemap(viewMenu, t("menu.preview"), "view.preview", #selector(previewMenu))
        addRemap(viewMenu, t("menu.changes"), "view.changes", #selector(changesMenu))
        addRemap(viewMenu, t("menu.focusEditor"), "view.focusEditor", #selector(focusEditorMenu))
        addRemap(viewMenu, t("menu.focusTerminal"), "view.focusTerminal", #selector(focusTerminalMenu))
        addRemap(viewMenu, t("menu.popout"), "view.popout", #selector(popoutMenu))
        viewMenu.addItem(.separator())
        addRemap(viewMenu, t("menu.zoomIn"), "view.zoomIn", #selector(zoomInMenu))
        addRemap(viewMenu, t("menu.zoomOut"), "view.zoomOut", #selector(zoomOutMenu))
        addRemap(viewMenu, t("menu.zoomReset"), "view.zoomReset", #selector(zoomResetMenu))
        viewItem.submenu = viewMenu

        let termItem = NSMenuItem(); mainMenu.addItem(termItem)
        let termMenu = NSMenu(title: t("menu.terminal"))
        addRemap(termMenu, t("menu.newTerminal"), "term.new", #selector(newTerminalMenu))
        add(termMenu, t("run.title"), #selector(runScriptMenu), "r", [.command])
        addRemap(termMenu, t("menu.clearTerminal"), "term.clear", #selector(clearTerminalMenu))
        addRemap(termMenu, t("menu.splitRight"), "term.splitRight", #selector(splitRightMenu))
        addRemap(termMenu, t("menu.splitDown"), "term.splitDown", #selector(splitDownMenu))
        addRemap(termMenu, t("menu.nextTerminal"), "term.next", #selector(nextTerminalMenu))
        addRemap(termMenu, t("menu.prevTerminal"), "term.prev", #selector(prevTerminalMenu))
        termMenu.addItem(.separator())
        // Directional focus between split panes (⌃⌘←→↑↓) — riven focusGroupInDirection.
        add(termMenu, t("menu.paneLeft"), #selector(focusPaneLeftMenu), "\u{2190}", [.command, .control])
        add(termMenu, t("menu.paneRight"), #selector(focusPaneRightMenu), "\u{2192}", [.command, .control])
        add(termMenu, t("menu.paneUp"), #selector(focusPaneUpMenu), "\u{2191}", [.command, .control])
        add(termMenu, t("menu.paneDown"), #selector(focusPaneDownMenu), "\u{2193}", [.command, .control])
        termMenu.addItem(.separator())
        // Select terminal 1..9 (⌃N on macOS, keeping ⌘N for workspaces) — riven terminal.select.
        for i in 1...9 {
            let it = NSMenuItem(title: t("menu.selectTerminalN", ["n": i]), action: #selector(selectTerminalMenu(_:)), keyEquivalent: "\(i)")
            it.keyEquivalentModifierMask = [.control]
            it.target = self; it.tag = i
            termMenu.addItem(it)
        }
        termItem.submenu = termMenu

        NSApp.mainMenu = mainMenu
    }

    // Add a menu item whose shortcut is read from the remappable Keys model (live).
    private func addRemap(_ menu: NSMenu, _ title: String, _ id: String, _ action: Selector) {
        let (key, mods) = Keys.resolve(Keys.effective(id))
        add(menu, title, action, key, mods)
    }

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags) {
        let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
        it.keyEquivalentModifierMask = mods
        it.target = (action == Selector(("undo:")) || action == Selector(("redo:"))) ? nil : self
        // Standard responder actions (cut/copy/paste/selectAll/undo) route via nil target.
        if ["cut:", "copy:", "paste:", "selectAll:", "undo:", "redo:"].contains(NSStringFromSelector(action)) {
            it.target = nil
        }
        menu.addItem(it)
    }

    @objc private func openFolderMenu() { openFolder() }
    @objc private func quickOpenMenu() { showQuickOpen() }
    @objc private func commandPaletteMenu() { showCommandPalette() }
    @objc private func quickPanelMenu() { showQuickPanel() }

    // Read package.json "scripts" for the active workspace + detect the package manager
    // (riven's ScriptRunner). Returns [(scriptName, "pm run name")].
    private func packageScripts() -> [(String, String)] {
        guard let ws = workspace else { return [] }
        let pkg = ws.appendingPathComponent("package.json")
        guard let data = try? Data(contentsOf: pkg),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let scripts = obj["scripts"] as? [String: String] else { return [] }
        let fm = FileManager.default
        let pm: String
        if fm.fileExists(atPath: ws.appendingPathComponent("pnpm-lock.yaml").path) { pm = "pnpm" }
        else if fm.fileExists(atPath: ws.appendingPathComponent("yarn.lock").path) { pm = "yarn" }
        else if fm.fileExists(atPath: ws.appendingPathComponent("bun.lockb").path) { pm = "bun" }
        else { pm = "npm" }
        return scripts.keys.sorted().map { ($0, "\(pm) run \($0)") }
    }

    // Separate "Run script" picker (NOT the add-panel panel — running a script isn't
    // adding a panel). Runs the chosen package.json script in a new terminal, and for
    // server scripts opens a preview panel on the port the server starts listening on.
    private var scriptPanel: QuickPanel?
    @objc private func runScriptMenu() {
        guard let window else { return }
        // ⌘R is "reload" when the preview panel is focused/active (standard browser
        // refresh), otherwise it opens the script runner.
        if activeDock?.activeGroup?.activePanel?.content === previewPanel || (window.firstResponder as? NSView)?.isDescendant(of: previewPanel) == true {
            previewPanel.reload(); return
        }
        let scripts = packageScripts()
        guard !scripts.isEmpty else { NSSound.beep(); return }
        if scriptPanel == nil { scriptPanel = QuickPanel() }
        let actions = scripts.map { (name, cmd) in
            QuickAction(title: name, hint: cmd, symbol: "play") { [weak self] in self?.runScript(name: name, cmd: cmd) }
        }
        scriptPanel?.show(actions: actions, title: t("run.title"), over: window)
    }
    private func runScript(name: String, cmd: String) {
        let serverish = ["dev", "start", "serve", "preview", "watch"].contains { name.lowercased().contains($0) }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let before = self?.listeningPorts() ?? []
            DispatchQueue.main.async {
                self?.newTerminalRunning(cmd)
                if serverish { self?.detectNewPort(before: before, attempt: 0) }
            }
        }
    }
    // Poll (off the main thread) for a port the just-launched server opened, then open
    // a preview panel on it.
    private func detectNewPort(before: Set<Int>, attempt: Int) {
        guard attempt < 12 else { return }   // give the server up to ~12s to bind
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self else { return }
            let now = self.listeningPorts()
            let fresh = now.subtracting(before).sorted().first { $0 >= 1024 && $0 < 60000 }
            DispatchQueue.main.async {
                if let port = fresh {
                    self.toggleDockPanel("preview")
                    self.previewPanel.openURLString("http://localhost:\(port)")
                } else {
                    self.detectNewPort(before: before, attempt: attempt + 1)
                }
            }
        }
    }
    // TCP ports currently in LISTEN state (via lsof).
    private func listeningPorts() -> Set<Int> {
        let p = Process(); p.launchPath = "/usr/sbin/lsof"
        p.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
        guard (try? p.run()) != nil else { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
        let out = String(data: data, encoding: .utf8) ?? ""
        var ports = Set<Int>()
        for line in out.split(separator: "\n") {
            if let r = line.range(of: #":(\d+)\s*\(LISTEN\)"#, options: .regularExpression) {
                let s = line[r].dropFirst().prefix { $0.isNumber }
                if let n = Int(s) { ports.insert(n) }
            }
        }
        return ports
    }

    private var quickPanel: QuickPanel?
    private func showQuickPanel() {
        guard let window else { return }
        if quickPanel == nil { quickPanel = QuickPanel() }
        var actions: [QuickAction] = [
            QuickAction(title: "새 터미널", hint: "⌘T", symbol: "terminal") { [weak self] in self?.newTerminal() }
        ]
        // Installed AI agents (scanned from PATH) — riven's AgentPicker entries.
        for a in AgentDiscovery.available() {
            actions.append(QuickAction(title: a.name, hint: "에이전트", symbol: a.symbol) { [weak self] in
                self?.launchAgent(a)
            })
        }
        actions.append(contentsOf: [
            QuickAction(title: "에디터", hint: "", symbol: "doc.text") { [weak self] in self?.showEditorPane(); self?.editor.focusEditor() },
            QuickAction(title: "검색", hint: "⌘⇧F", symbol: "magnifyingglass") { [weak self] in self?.toggleDockPanel("search") },
            QuickAction(title: "소스 컨트롤", hint: "⌘⇧G", symbol: "arrow.triangle.branch") { [weak self] in self?.toggleDockPanel("git") },
            QuickAction(title: "미리보기", hint: "⌘⇧V", symbol: "eye") { [weak self] in self?.toggleDockPanel("preview") },
            QuickAction(title: "변경사항", hint: "⌘⇧C", symbol: "clock.arrow.circlepath") { [weak self] in self?.toggleDockPanel("changes") },
            QuickAction(title: "새 워크스페이스", hint: "⌘⇧N", symbol: "folder.badge.plus") { [weak self] in self?.openFolder() },
            QuickAction(title: "사이드바 토글", hint: "⌘B", symbol: "sidebar.left") { [weak self] in self?.toggleSidebar() }
        ])
        quickPanel?.show(actions: actions, over: window)
    }
    private var settingsWin: SettingsWindow?
    @objc private func settingsMenu() {
        if settingsWin == nil { settingsWin = SettingsWindow() }
        settingsWin?.center(); settingsWin?.makeKeyAndOrderFront(nil)
    }

    private var commandPalette: CommandPalette?
    private func showCommandPalette() {
        if commandPalette == nil { commandPalette = CommandPalette() }
        let cmds: [Command] = [
            Command(title: "폴더 열기", hint: "⌘O") { [weak self] in self?.openFolder() },
            Command(title: "빠른 파일 열기", hint: "⌘P") { [weak self] in self?.showQuickOpen() },
            Command(title: "저장", hint: "⌘S") { [weak self] in if let p = self?.tabBar.active { self?.editor.requestSave(path: p) } },
            Command(title: "새 터미널", hint: "⌘T") { [weak self] in self?.newTerminal() },
            Command(title: "사이드바 토글", hint: "⌘B") { [weak self] in self?.toggleSidebar() },
            Command(title: "AI 자동완성", hint: "⌃Space") { [weak self] in self?.editor.triggerAI() },
            Command(title: "소스 컨트롤 (그래프)", hint: "⌘⇧G") { [weak self] in self?.toggleDockPanel("git") },
            Command(title: "패널 크기 균등화", hint: "⌥⌘=") { [weak self] in self?.activeDock?.distributeEvenly() },
            Command(title: "편집기 분할 (오른쪽)", hint: "⌘\\") { [weak self] in self?.editor.splitEditor("right") },
            Command(title: "편집기 분할 (아래)", hint: "⌥⌘\\") { [weak self] in self?.editor.splitEditor("down") },
            Command(title: "탭 닫기", hint: "⌘W") { [weak self] in if let p = self?.tabBar.active { self?.closeTab(p) } }
        ]
        commandPalette?.show(commands: cmds, over: window)
    }
    @objc private func saveMenu() { if let p = tabBar.active { editor.requestSave(path: p) } }
    // ⌘W acts on the FOCUSED panel (riven's sendToFocused → activePanel): if the
    // terminal holds focus, close that terminal dock panel; otherwise close the
    // active editor tab.
    @objc private func closeTabMenu() {
        // A modal/aux window (settings / palette / quick panel) takes ⌘W first.
        if let kw = NSApp.keyWindow, kw !== window { kw.performClose(nil); return }
        // Close the FOCUSED panel first, one at a time. Quitting the app is the LAST
        // resort — only when there is genuinely nothing left to close (no panels).
        // Terminal focused → close that terminal panel.
        if let tv = window?.firstResponder as? TerminalView,
           let p = currentTerminalPanel(), p.content === tv {
            activeDock?.removePanel(p); return
        }
        // Otherwise act on the active dock panel (riven's sendToFocused → activePanel).
        if let panel = activeDock?.activeGroup?.activePanel {
            if panel.id == "editor" {
                if let p = tabBar.active { closeTab(p) }   // close a tab; panel closes when last one goes
                else { activeDock?.removePanel(panel) }
            } else if panel.content is TerminalView {
                activeDock?.removePanel(panel)
            } else {                                       // search / git / preview / changes
                activeDock?.detach(panel)
                auxDockPanels[panel.id] = nil
            }
            return
        }
        // A stray editor tab with no active dock panel → close it.
        if let p = tabBar.active { closeTab(p); return }
        // Nothing left to close → the dock is empty → quit (like riven / VS Code).
        window?.performClose(nil)
    }
    private func terminalHasFocus() -> Bool { window?.firstResponder is TerminalView }

    // ---- global UI zoom (⌘+ / ⌘- / ⌘0) — scales the WHOLE UI (editor + terminals +
    // all AppKit chrome), matching riven's browser page-zoom, via UIScale. ----
    @objc private func zoomInMenu() { applyZoom(UIScale.step(+1), delta: +1) }
    @objc private func zoomOutMenu() { applyZoom(UIScale.step(-1), delta: -1) }
    @objc private func zoomResetMenu() { applyZoom(UIScale.reset(), delta: 0) }
    private func applyZoom(_ baseFont: Int, delta: Int) {
        // Editor → absolute Monaco size. Terminals → rebuild the ghostty config with the
        // new absolute font-size (the relative increase/decrease bindings drifted out of
        // sync and sometimes no-op'd; an absolute config update is deterministic).
        editor.setFontSize(baseFont)
        GhosttyApp.shared.reloadTheme()   // config now carries font-size = UIScale.baseFontSize
        // Rebuild AppKit chrome so its fonts + metrics pick up the new factor.
        applyUIScale()
    }
    // Re-lay-out every chrome component that reads UIScale (rail cards, dock tabs,
    // status bar, file tree). Each has an idempotent rebuild path.
    private func applyUIScale() {
        rail.rebuildForScale()
        statusBar.rebuildForScale()
        for ws in workspaces { state(for: ws).dock?.groups.forEach { $0.tabBar.rebuild() } }
        explorer.rebuildForScale()
    }
    @objc private func toggleSidebarMenu() { toggleSidebar() }
    @objc private func searchMenu() { toggleDockPanel("search") }
    @objc private func gitMenu() { toggleDockPanel("git") }
    @objc private func previewMenu() { toggleDockPanel("preview") }
    @objc private func changesMenu() { toggleDockPanel("changes") }
    @objc private func focusEditorMenu() { editor.focusEditor() }
    @objc private func focusTerminalMenu() { currentTerminal()?.focusTerminal() }
    // ⌘K clears the terminal only while it holds focus (riven's context:'terminal').
    @objc private func clearTerminalMenu() { if terminalHasFocus() { currentTerminal()?.clearScreen() } }
    // ⌘D / ⌘⇧D add a new terminal split to the right / below (riven's splitTerminal).
    @objc private func splitRightMenu() { splitTerminal(.right) }
    @objc private func splitDownMenu() { splitTerminal(.down) }
    @objc private func selectTerminalMenu(_ s: NSMenuItem) {
        let n = s.tag
        // ⌃N is context-sensitive: when the editor holds focus it selects the Nth open
        // editor tab; otherwise the Nth terminal (riven).
        if editorHasFocus(), let ws = workspace {
            let tabs = state(for: ws).openTabs
            if tabs.indices.contains(n - 1) { selectTab(tabs[n - 1]); editor.focusEditor(); return }
        }
        selectTerminal(n)
    }
    private func editorHasFocus() -> Bool {
        if activeDock?.activeGroup?.activePanel?.id == "editor" { return true }
        var r = window?.firstResponder as? NSView
        while let v = r { if v === editor { return true }; r = v.superview }
        return false
    }
    @objc private func focusPaneLeftMenu() { focusDock(.left) }
    @objc private func focusPaneRightMenu() { focusDock(.right) }
    @objc private func focusPaneUpMenu() { focusDock(.up) }
    @objc private func focusPaneDownMenu() { focusDock(.down) }
    @objc private func newTerminalMenu() { newTerminal() }
    @objc private func nextTerminalMenu() { cycleTerminal(1) }
    @objc private func prevTerminalMenu() { cycleTerminal(-1) }

    // ---- keybindings (matches riven defaults) ----
    private var quickOpen: QuickOpenPanel?

    private func installKeybindings() {
        // Menu keyEquivalents handle ⌘O/P/S/W/B/T/⇧]/[. The monitor covers the
        // ones menus can't easily express: ⌃Space (AI) and ⌘1-9 (workspaces).
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self else { return e }
            if e.modifierFlags.contains(.control), e.charactersIgnoringModifiers == " " {
                self.editor.triggerAI()   // gathers cursor context → onAI → provider
                return nil
            }
            if e.modifierFlags.contains(.command),
               let d = e.charactersIgnoringModifiers, d.count == 1, d.first!.isNumber,
               let n = Int(d), n >= 1, n <= self.workspaces.count {
                self.switchWorkspace(self.workspaces[n - 1]); return nil
            }
            // ⌘, → settings. A menu keyEquivalent of "," can be swallowed by a focused
            // ghostty terminal, so guarantee it here.
            if e.modifierFlags.intersection([.command, .shift, .option, .control]) == [.command],
               e.charactersIgnoringModifiers == "," {
                self.settingsMenu(); return nil
            }
            return e
        }
    }

    private var sidebarWidth: CGFloat = 220
    private var sidebarCollapsed = false
    private func toggleSidebar() {
        guard let body = bodySplit, let sb = body.arrangedSubviews.first else { return }
        sidebarCollapsed.toggle()
        if sidebarCollapsed {
            sidebarWidth = max(160, sb.frame.width)
            sb.isHidden = true
        } else {
            sb.isHidden = false
        }
        // Force the split to reclaim/return the pane's space (isHidden alone leaves the
        // divider + slot; the delegate below returns 0 min-width while collapsed).
        body.adjustSubviews()
        if !sidebarCollapsed { body.setPosition(sidebarWidth, ofDividerAt: 0) }
        body.layoutSubtreeIfNeeded()
    }

    // Toggle an auxiliary dock panel (search/git/preview/changes) — matches riven's
    // togglePanel: if open, close it; else add it to the dock (search/git open to
    // the left, preview/changes to the right of the main area). Once open, the user
    // can drag it anywhere / split / resize like any dock panel.
    private func toggleDockPanel(_ id: String) {
        guard let ws = workspace, let dock = activeDock else { return }
        if let existing = auxDockPanels[id] {
            dock.detach(existing); auxDockPanels[id] = nil
            return
        }
        if bodySplit.arrangedSubviews.first?.isHidden ?? false { toggleSidebar() }
        let side: DockDir = (id == "search" || id == "git") ? .left : .right
        let title: String; let symbol: String
        let content: NSView
        switch id {
        case "search":  title = t("title.search"); symbol = "magnifyingglass"; searchPanel.setRoot(ws); content = searchPanel
        case "git":     title = t("title.git"); symbol = "arrow.triangle.branch"; sourceControl.setRoot(ws); content = sourceControl
        case "preview": title = t("title.preview"); symbol = "safari"; content = previewPanel
        case "changes": title = t("title.changes"); symbol = "clock.arrow.circlepath"; changesPanel.setWorkspace(ws); content = changesPanel
        default: return
        }
        let panel = DockPanel(id: id, title: title,
            icon: NSImage(systemSymbolName: symbol, accessibilityDescription: nil), content: content)
        panel.onClose = { [weak self] in self?.auxDockPanels[id] = nil }
        auxDockPanels[id] = panel
        // Attach at the appropriate EDGE (leftmost for left panels, rightmost for right)
        // so panels append/prepend in a stable order instead of wedging between the
        // terminal and the editor (which reordered them on every workspace switch).
        let ref = side == .left ? dock.groups.first : dock.groups.last
        dock.addPanel(panel, reference: ref, direction: side)
        // Aux panels are narrow by default (riven pins Changes/search/git ~280px),
        // not a 50/50 split.
        setAuxPanelWidth(panel, id == "git" ? 720 : 300)   // source control (graph + changes) needs width
        if id == "search" { searchPanel.focusQuery() }
        else if id == "preview" { previewPanel.focusURL() }
    }

    // Resize a freshly-added side panel to a fixed width instead of the 50/50 split.
    private func setAuxPanelWidth(_ panel: DockPanel, _ width: CGFloat) {
        DispatchQueue.main.async {
            guard let g = panel.group, let sv = g.superview as? NSSplitView, sv.isVertical else { return }
            let total = sv.bounds.width
            guard total > width + 120 else { return }
            let idx = sv.arrangedSubviews.firstIndex(of: g) ?? 0
            if idx == 0 { sv.setPosition(width, ofDividerAt: 0) }                 // panel on the left
            else { sv.setPosition(max(0, total - width), ofDividerAt: idx - 1) }  // panel on the right
        }
    }

    // Reload a file's editor model from disk (after an agent-edit revert).
    private func reloadIfOpen(_ path: String) {
        guard let ws = workspace, state(for: ws).openTabs.contains(path),
              let content = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        editor.close(path: path)
        editor.open(path: path, content: content)
    }

    // Open an agent-edited file with its before/after diff (green added lines, red
    // deleted view-zones, hunk revert) — the editor opens to the RIGHT of the terminal.
    private func openAgentEdit(_ path: String) {
        openFile(URL(fileURLWithPath: path))
        if let e = AgentEdits.shared.edit(for: path) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                self.editor.agentDiff(path: path, before: e.before, after: e.after)
            }
        }
    }
    // Open a changed file with its diff-vs-HEAD (git panel): before = HEAD version,
    // after = working tree — same before/after renderer as agent edits.
    private func openGitDiff(_ rel: String) {
        guard let ws = workspace else { return }
        let url = ws.appendingPathComponent(rel)
        openFile(url)
        DispatchQueue.global(qos: .userInitiated).async {
            let before = Git.showFile(cwd: ws.path, rel: rel) ?? ""
            let after = (try? String(contentsOfFile: url.path, encoding: .utf8)) ?? ""
            DispatchQueue.main.async {
                if before != after { self.editor.agentDiff(path: url.path, before: before, after: after) }
            }
        }
    }

    private func showQuickOpen() {
        guard let ws = workspace else { return }
        if quickOpen == nil {
            quickOpen = QuickOpenPanel()
            quickOpen?.onOpen = { [weak self] url in self?.openFile(url) }
        }
        quickOpen?.show(workspace: ws, over: window)
    }

    // Refresh today's agent usage (local Claude logs) now + every 60s, like riven.
    private var usageTimer: Timer?
    private func startUsagePolling() {
        refreshUsage()
        usageTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refreshUsage() }
    }
    private func refreshUsage() {
        DispatchQueue.global(qos: .utility).async {
            let t = Usage.today()
            // Show today's $cost right away (riven's fallback) so the widget is never
            // empty; upgrade to session%·weekly% if the plan-limits API resolves.
            DispatchQueue.main.async { self.lastToday = t; self.statusBar.setUsage(limits: self.lastLimits, today: t); self.updateHeaderUsage(limits: self.lastLimits, today: t); self.rebuildPinnedUsage() }
            Usage.limits { lim in
                guard lim.sessionRemaining != nil || lim.weeklyRemaining != nil else { return }
                DispatchQueue.main.async { self.lastLimits = lim; self.statusBar.setUsage(limits: lim, today: t); self.updateHeaderUsage(limits: lim, today: t); self.rebuildPinnedUsage() }
            }
        }
    }

    // Header usage widget: session% · weekly% (remaining), else today's $cost.
    private func updateHeaderUsage(limits: Usage.Limits?, today: Usage.Today?) {
        let s = limits?.sessionRemaining, w = limits?.weeklyRemaining
        if let s, let w { headerUsage.stringValue = "\(s)% · \(w)%"; headerUsageItem.isHidden = false }
        else if let s { headerUsage.stringValue = "\(s)%"; headerUsageItem.isHidden = false }
        else if let c = today?.totalCost, c > 0 { headerUsage.stringValue = String(format: "$%.2f", c); headerUsageItem.isHidden = false }
        else { headerUsageItem.isHidden = true }
    }
    @objc private func headerUsageClicked() {
        if headerUsagePopover?.isShown == true { headerUsagePopover?.close(); return }
        let pop = headerUsagePopover ?? NSPopover()
        pop.behavior = .transient
        pop.contentViewController = NSViewController()
        pop.contentViewController?.view = UsageUI.content(limits: lastLimits, today: lastToday) { [weak self] in
            self?.headerUsagePopover?.close(); self?.pinUsage()
        }
        headerUsagePopover = pop
        pop.show(relativeTo: headerUsageItem.bounds, of: headerUsageItem, preferredEdge: .maxY)
    }

    // Pin the usage view to the bottom of the sidebar (riven's UsagePinned). Reserves
    // a strip at the bottom of the sidebar container and hides the status-bar widget.
    private let pinnedUsageH: CGFloat = 118
    private func pinUsage() {
        guard pinnedUsage == nil, let sc = sidebarContainer else { return }
        Settings.shared.set("usagePinned", true)
        let v = makePinnedUsage()
        v.frame = NSRect(x: 0, y: 0, width: sc.bounds.width, height: pinnedUsageH)
        v.autoresizingMask = [.width, .maxYMargin]
        sc.addSubview(v)
        pinnedUsage = v
        // Shrink the split view to sit above the pinned strip.
        if let sv = sidebarSplit {
            var f = sv.frame; f.origin.y = pinnedUsageH; f.size.height -= pinnedUsageH; sv.frame = f
        }
        statusBar.setUsagePinned(true)
        refreshUsage()
    }
    private func unpinUsage() {
        Settings.shared.set("usagePinned", false)
        pinnedUsage?.removeFromSuperview(); pinnedUsage = nil
        if let sv = sidebarSplit {
            var f = sv.frame; f.origin.y = 0; f.size.height += pinnedUsageH; sv.frame = f
        }
        statusBar.setUsagePinned(false)
        refreshUsage()
    }
    private func makePinnedUsage() -> NSView {
        let box = NSView(); box.wantsLayer = true; box.layer?.backgroundColor = Theme.bg2.cgColor
        let hair = NSView(); hair.wantsLayer = true; hair.layer?.backgroundColor = Theme.hairline.cgColor
        hair.translatesAutoresizingMaskIntoConstraints = false; box.addSubview(hair)
        // Header row: "남은 한도" + 고정 해제.
        let title = NSTextField(labelWithString: "남은 한도")
        title.font = .systemFont(ofSize: 10, weight: .semibold); title.textColor = Theme.fgDim
        title.translatesAutoresizingMaskIntoConstraints = false; box.addSubview(title)
        let unpin = NSButton(title: " 고정 해제", target: self, action: #selector(unpinUsageMenu))
        unpin.image = NSImage(systemSymbolName: "pin.slash", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .regular))
        unpin.imagePosition = .imageLeading; unpin.isBordered = false
        unpin.font = .systemFont(ofSize: 10); unpin.contentTintColor = Theme.fgDim
        unpin.translatesAutoresizingMaskIntoConstraints = false; box.addSubview(unpin)
        let content = UsageUI.pinnedContent(limits: lastLimits, today: lastToday) { }
        content.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(content)
        NSLayoutConstraint.activate([
            hair.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            hair.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            hair.topAnchor.constraint(equalTo: box.topAnchor), hair.heightAnchor.constraint(equalToConstant: 1),
            title.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
            title.topAnchor.constraint(equalTo: box.topAnchor, constant: 8),
            unpin.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -8),
            unpin.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            content.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 4),
            content.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: box.trailingAnchor)
        ])
        return box
    }
    @objc private func unpinUsageMenu() { unpinUsage() }
    private var lastLimits: Usage.Limits?
    private var lastToday: Usage.Today?
    // Rebuild the pinned strip's contents when usage refreshes (it's pinned already).
    private func rebuildPinnedUsage() {
        guard pinnedUsage != nil, let sc = sidebarContainer else { return }
        pinnedUsage?.removeFromSuperview()
        let v = makePinnedUsage()
        v.frame = NSRect(x: 0, y: 0, width: sc.bounds.width, height: pinnedUsageH)
        v.autoresizingMask = [.width, .maxYMargin]
        sc.addSubview(v); pinnedUsage = v
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { persistSession() }
}

// App-level chrome re-themes with the rest (window/root/terminal well), and the
// editor is told the new shiki theme so Monaco re-highlights live.
extension AppDelegate: Themable {
    func applyTheme() {
        window.backgroundColor = Theme.bg
        rootView?.layer?.backgroundColor = Theme.bg.cgColor
        dockHost?.layer?.backgroundColor = Theme.bg.cgColor
        sidebarContainer?.layer?.backgroundColor = Theme.bg2.cgColor
        // Recolor every dock group (backgrounds + tab titles/underline) — dock views
        // aren't individually Themable, so rebuild their tab bars here.
        for st in states.values {
            st.dock?.container.layer?.backgroundColor = Theme.bg.cgColor
            st.dock?.groups.forEach { g in
                g.layer?.backgroundColor = Theme.bg.cgColor
                g.tabBar.rebuild()
            }
        }
        // Live-recolor the terminal(s) — ghostty config is otherwise frozen at launch.
        GhosttyApp.shared.reloadTheme()
    }
    // Called from Settings: switch theme live across all chrome + the editor.
    func switchTheme(_ id: String) {
        Theme.apply(id: id) { [weak self] shiki in
            self?.editor.setEditorTheme(shiki: shiki, bg: Theme.current.bg, accent: Theme.current.accent, accent2: Theme.current.accent2)
        }
    }
    // Re-apply all settings-driven state after a cloud pull overwrote the settings dict.
    func reapplyAllSettings() {
        let lang = Lang(rawValue: Settings.shared.string("language", "ko")) ?? .ko
        if I18n.current != lang { I18n.setLanguage(lang) }   // posts .rivenLanguageChanged → menu/i18n
        switchTheme(Settings.shared.string("theme", "ember"))
        editor.setFormatOnSave(Settings.shared.bool("formatOnSave", false))
        editor.setEditorKeymap(Settings.shared.string("editorKeymap", "vscode"))
        editor.setEditorKeys(Keys.editorChords())
        editor.setSnippets(loadSnippets())
        buildMenu()
    }
}

// Split-view behavior. Without a delegate the outer [sidebar | main] split has no
// holding priority, so a dragged divider snapped back to its old position and the
// sidebar couldn't be resized. Constraining the sidebar's min/max and keeping its
// width fixed on window resize (only the main area flexes) makes the drag stick.
extension AppDelegate: NSSplitViewDelegate {
    func splitView(_ sv: NSSplitView, constrainMinCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat {
        if sv === bodySplit && i == 0 { return sidebarCollapsed ? 0 : 160 }
        if sv === sidebarSplit && i == 0 { return 96 }   // rail never smaller than one card
        return p
    }
    func splitView(_ sv: NSSplitView, constrainMaxCoordinate p: CGFloat, ofSubviewAt i: Int) -> CGFloat {
        if sv === bodySplit && i == 0 { return 480 }
        if sv === sidebarSplit && i == 0 { return 400 }
        return p
    }
    // Neither the rail nor the sidebar column may collapse to zero (that's what made
    // the workspace area "disappear").
    func splitView(_ sv: NSSplitView, canCollapseSubview view: NSView) -> Bool { false }
    // On window resize, flex the main area and keep the sidebar's width; inside the
    // sidebar, keep the rail's height fixed and flex the explorer below it.
    func splitView(_ sv: NSSplitView, shouldAdjustSizeOfSubview view: NSView) -> Bool {
        if sv === bodySplit { return view !== sidebarView }   // keep the sidebar's width fixed
        if sv === sidebarSplit { return view !== rail }       // keep the rail height, flex explorer
        return true
    }
}

// Popped-out panel window delegate: re-docks the panel when the window closes.
final class PopoutDelegate: NSObject, NSWindowDelegate {
    private let onClose: () -> Void
    init(_ onClose: @escaping () -> Void) { self.onClose = onClose }
    func windowWillClose(_ notification: Notification) { onClose() }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
