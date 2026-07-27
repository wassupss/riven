import AppKit

// Owner-only crash-log path under Application Support (computed once so the C signal
// handler, which can't allocate/capture, has a ready path).
let rivenCrashPath: String = {
    let dir = AppPaths.supportDir
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let p = dir.appendingPathComponent("crash.txt").path
    if !FileManager.default.fileExists(atPath: p) {
        FileManager.default.createFile(atPath: p, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    return p
}()

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
    var apiPanel: APIClientPanel!
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
    private var workspaceNames: [URL: String] = [:]    // custom rail names, persisted per session
    private var sigtermSource: DispatchSourceSignal?   // persist on SIGTERM (kill/restart/logout)
    private var auxDockPanels: [String: DockPanel] = [:]  // search/git/preview/changes
    private var editorVisible = false
    var workspace: URL?
    let lsp = LSPManager.shared

    func applicationDidFinishLaunching(_ n: Notification) {
        installCrashHandler()
        setupShellShim()   // per-pane `claude` session shim (typed `claude` resumes on relaunch)
        startAgentHooks()  // agent lifecycle events → pane busy/attn (replaces viewport polling)
        // Persist the session on SIGTERM too (kill / restart / logout), not just ⌘Q —
        // Cocoa doesn't call applicationWillTerminate for SIGTERM, so a killed app would
        // otherwise lose panes created since the last save (incl. their claude session ids).
        // A dispatch source runs on the main queue, so touching AppKit here is safe.
        signal(SIGTERM, SIG_IGN)
        let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigterm.setEventHandler { [weak self] in
            self?.persistSession()
            // NSApp.terminate can be DEFERRED — a modal sheet is up, or a delegate returns
            // .terminateLater. The default SIGTERM disposition is now SIG_IGN, so in that
            // case the process would survive and `kill <pid>` would stop working entirely.
            // Arm a watchdog so the signal still means "exit", after giving the normal path
            // a moment to shut the language servers down (#27).
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(0) }
            NSApp.terminate(nil)
        }
        sigterm.resume()
        sigtermSource = sigterm
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
        // Start Sparkle auto-update (scheduled background checks; no-op if no feed).
        Updater.shared.start()
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
        // DEBUG: split the terminal into N extra panes after launch to inspect sizing.
        if let n = ProcessInfo.processInfo.environment["RIVEN_ADDTERMS"].flatMap(Int.init) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                for _ in 0..<n { self.splitTerminal(.right) }
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
                case "api": self.toggleDockPanel("api")
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

    // Write crash stacks to a per-user, owner-only file under Application Support
    // (not world-readable /tmp — stacks can contain workspace paths). Raw binary
    // won't produce a normal crash report. Covers Obj-C exceptions + fatal signals.
    private func installCrashHandler() {
        NSSetUncaughtExceptionHandler { ex in
            let s = "EXCEPTION: \(ex.name.rawValue): \(ex.reason ?? "")\n\(ex.callStackSymbols.joined(separator: "\n"))"
            try? s.write(toFile: rivenCrashPath, atomically: true, encoding: .utf8)
        }
        for sig in [SIGSEGV, SIGABRT, SIGILL, SIGBUS, SIGTRAP] {
            signal(sig) { s in
                let syms = Thread.callStackSymbols.joined(separator: "\n")
                try? "SIGNAL \(s)\n\(syms)".write(toFile: rivenCrashPath, atomically: true, encoding: .utf8)
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
        // 카드를 끌어 순서를 바꾸면 workspaces 배열도 같은 순서로 맞추고 저장한다
        // (⌘1-9 단축키와 다음 실행의 복원 순서가 레일과 항상 일치하도록).
        rail.onReorder = { [weak self] order in
            guard let self else { return }
            let known = self.workspaces
            self.workspaces = order.filter { known.contains($0) } + known.filter { !order.contains($0) }
            self.persistSession()
        }
        // Persist the rail card color so it survives across sessions.
        rail.onSetColor = { [weak self] url, color in
            guard let self else { return }
            self.workspaceColors[url] = color.map { self.hexString($0) }
            self.persistSession()
        }
        // Persist a custom workspace name (rename) across sessions.
        rail.onRename = { [weak self] url, name in
            guard let self else { return }
            self.workspaceNames[url] = name
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
        apiPanel = APIClientPanel(frame: .zero)
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
            // Servers echo a percent-encoded URI (file:///Users/x/my%20project/a.ts); decode
            // so it matches the raw Monaco model key, else diagnostics are dropped for any
            // path with a space / non-ASCII char.
            let stripped = uri.replacingOccurrences(of: "file://", with: "")
            let path = stripped.removingPercentEncoding ?? stripped
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
        let hLabel = NSTextField(labelWithString: ""); hLabel.font = UIScale.font(12, .medium)
        hLabel.textColor = Theme.fg; hLabel.translatesAutoresizingMaskIntoConstraints = false
        headerLabel = hLabel; headerIcon = hIcon
        dockHeader.addSubview(hIcon); dockHeader.addSubview(hLabel)

        // Right side of the header: usage widget + settings gear (moved here from the
        // bottom status bar per the app-header layout).
        let uIcon = NSImageView()
        uIcon.image = NSImage(systemSymbolName: "gauge.with.dots.needle.33percent", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        uIcon.contentTintColor = Theme.fgDim; uIcon.translatesAutoresizingMaskIntoConstraints = false
        let uLabel = NSTextField(labelWithString: ""); uLabel.font = UIScale.font(11)
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
        addBtn.font = UIScale.font(12, .medium)
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
    // Per-pane Claude session shim. riven exports ZDOTDIR to this dir + RIVEN_PANE_SESSION
    // per terminal; the .zshrc here sources the user's real config, then defines a `claude`
    // function that injects `--session-id $RIVEN_PANE_SESSION` — so even a hand-typed
    // `claude` resumes that pane's exact conversation on relaunch. Interactive shells only
    // (.zshrc isn't sourced for scripts), so scripts that call `claude` are unaffected.
    private var rivenZdotdir: String {
        AppPaths.support("zdotdir").path
    }
    private func setupShellShim() {
        let dir = rivenZdotdir
        // 0700: everything in here is SOURCED BY THE SHELL, so write access for another
        // local user would be code execution in the user's terminal. The explicit chmod
        // matters — createDirectory's attributes are ignored when the directory already
        // exists, which it does on every launch after the first.
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        chmod(dir, 0o700)
        let files: [String: String] = [
            ".zshenv": #"[ -r "$HOME/.zshenv" ] && source "$HOME/.zshenv""#,
            ".zprofile": #"[ -r "$HOME/.zprofile" ] && source "$HOME/.zprofile""#,
            ".zshrc": """
            [ -r "$HOME/.zshrc" ] && source "$HOME/.zshrc"
            # riven: typing `claude` resumes THIS pane's session across app restarts.
            if [ -n "$RIVEN_PANE_SESSION" ]; then
              claude() {
                # Build flags in a zsh array — NOT via ${VAR:+--flag "$VAR"}, because zsh
                # does not field-split parameter expansions, so that form would pass
                # "--flag value" to claude as a single argv word (it rejects it).
                local -a rv
                # Only inject our per-pane --session-id when the user hasn't chosen a session
                # themselves; otherwise claude sees a duplicate/ conflicting session flag.
                case " $* " in
                  (*" --session-id "*|*" --resume "*|*" -r "*|*" --continue "*|*" -c "*|*" --from-pr "*) ;;
                  (*) rv+=(--session-id "$RIVEN_PANE_SESSION") ;;
                esac
                # riven's agent hooks (deep-merged, so the user's own hooks still fire).
                [ -n "$RIVEN_HOOKS_SETTINGS" ] && rv+=(--settings "$RIVEN_HOOKS_SETTINGS")
                command "${RIVEN_REAL_CLAUDE:-claude}" "${rv[@]}" "$@"
              }
            fi
            export ZDOTDIR="$HOME"   # restore so .zlogin / nested references use the user's dir
            """,
        ]
        for (name, body) in files {
            try? (body + "\n").write(toFile: (dir as NSString).appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
    }

    // ---- agent lifecycle hooks (docs/agent-hooks-design.md) -----------------
    // Start the hook socket and give [[AgentActivity]] the UI verbs it needs. The
    // policy (what raises attention, when a banner fires) lives in AgentActivity; this
    // only supplies "how" — which panel, which badge, is the user looking at it.
    private func startAgentHooks() {
        AgentActivity.shared.sink = AgentActivity.Sink(
            setBusy: { [weak self] pane, busy in
                WorkspaceStatus.shared.setPane(ws: pane.workspace, pane: pane.paneId, busy: busy)
                guard let p = self?.panel(pane) else { return }
                // attn (needs input) outranks busy, exactly as the old poller decided.
                if busy { if p.badge != "attn" { p.badge = "busy" } }
                else if p.badge == "busy" { p.badge = nil; (p.content as? TerminalView)?.setRingState(nil) }
                self?.refreshDockTabs()
            },
            setAttention: { [weak self] pane, attn in
                WorkspaceStatus.shared.setPane(ws: pane.workspace, pane: pane.paneId, attn: attn)
                guard let p = self?.panel(pane) else { return }
                p.badge = attn ? "attn" : nil
                (p.content as? TerminalView)?.setRingState(attn ? "attn" : nil)
                self?.refreshDockTabs()
            },
            isWatched: { [weak self] pane in
                guard let self, let p = self.panel(pane), let tv = p.content as? TerminalView else { return false }
                return self.window?.firstResponder === tv && self.window?.isKeyWindow == true
            },
            notify: { [weak self] pane, body in
                let title = (pane.workspace as NSString).lastPathComponent
                let name = self?.panel(pane)?.title ?? t("title.terminal")
                Notifications.post(title: title, body: "\(name) · \(body)")
            }
        )
        AgentHookServer.shared.onEvent = { AgentActivity.shared.handle($0) }
        AgentHookServer.shared.start()
    }

    /// Single-quote a path for the launch command line — the app-support path contains
    /// a space ("Application Support") and could contain more if the home dir is renamed.
    private func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Resolve a registry pane back to its live DockPanel (nil once it's been closed).
    private func panel(_ pane: PaneSessionRegistry.Pane) -> DockPanel? {
        guard let url = states.keys.first(where: { $0.path == pane.workspace }),
              let dock = states[url]?.dock else { return nil }
        for g in dock.groups { for p in g.panels where p.id == pane.paneId { return p } }
        return nil
    }

    private func makeTerminalPanel(for st: WorkspaceState, agent: AgentDiscovery.Agent? = nil,
                                   sessionId: String? = nil) -> DockPanel {
        st.terminalSeq += 1
        // EVERY terminal gets a stable per-pane session UUID (reused on restore) and env
        // that (a) makes a hand-typed `claude` resume THIS pane's session via the ZDOTDIR
        // shim, and (b) forces transcript persistence. Only a well-formed UUID is accepted
        // from the persisted (tamperable) snapshot — else mint a fresh one — so nothing
        // untrusted reaches the shell/command.
        let paneSession = sessionId.flatMap { UUID(uuidString: $0) != nil ? $0 : nil } ?? UUID().uuidString.lowercased()
        var env: [String: String] = [
            "RIVEN_PANE_SESSION": paneSession,
            "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE": "1",
            "ZDOTDIR": rivenZdotdir,
            // Where `riven-hook` posts lifecycle events. Hook processes are descendants
            // of this surface, so they inherit both this and RIVEN_PANE_SESSION — that
            // pair is the whole routing mechanism (docs/agent-hooks-design.md).
            "RIVEN_HOOK_SOCKET": AgentHookServer.socketPath,
        ]
        if let claude = AgentDiscovery.claudeCmd() { env["RIVEN_REAL_CLAUDE"] = claude }
        // An agent panel runs the CLI directly (no shell). For a session-capable agent
        // (Claude Code) attach `--session-id <paneSession>` — idempotent: creates the
        // session on first launch, resumes it on restore. Plain terminals run the shell,
        // where the shim's `claude` function applies the same id to typed invocations.
        var cmd = agent?.cmd
        if let a = agent, a.sessionFlag != nil { cmd = "\(a.cmd) --session-id \(paneSession)" }
        // Hand the agent riven's hook config on the command line rather than writing to
        // the user's own settings. Verified: --settings DEEP-MERGES `hooks`, so a user's
        // own hooks keep firing alongside ours.
        if agent?.name == "Claude Code", let settings = AgentHooksInstall.claudeSettingsPath() {
            cmd = "\(cmd ?? "claude") --settings \(shellQuote(settings))"
        } else if agent?.name == "Codex" {
            let overrides = AgentHooksInstall.codexLaunchOverrides()
            if !overrides.isEmpty { cmd = ([cmd ?? "codex"] + overrides.map(shellQuote)).joined(separator: " ") }
        }
        // The shim needs the same file for a hand-typed `claude` in a plain terminal.
        if let settings = AgentHooksInstall.claudeSettingsPath() { env["RIVEN_HOOKS_SETTINGS"] = settings }
        let tv = TerminalView(frame: dockHost.bounds, workdir: st.url.path, command: cmd, env: env)
        tv.autoresizingMask = [.width, .height]
        let title = agent.map { "\($0.name)" } ?? t("title.terminal")
        let icon = NSImage(systemSymbolName: agent?.symbol ?? "terminal", accessibilityDescription: nil)
        let p = DockPanel(id: "term-\(abs(st.url.path.hashValue))-\(st.terminalSeq)", title: title,
            icon: icon, content: tv, closable: true)
        p.agentName = agent?.name          // 세션 복원 때 같은 에이전트로 다시 띄우기 위해
        p.sessionId = paneSession          // 이 패널의 세션 id (복원 때 --resume 대상)
        // Reverse index so an incoming hook event can find this pane.
        PaneSessionRegistry.shared.register(session: paneSession, workspace: st.url.path, paneId: p.id)
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
        p.onClose = { [weak tv] in
            tv?.dispose()
            WorkspaceStatus.shared.clearPane(ws: wsPath, pane: paneId)
            PaneSessionRegistry.shared.unregister(session: paneSession)
            AgentActivity.shared.forget(pane: paneSession)
        }
        // A bell or desktop-notification means the agent FINISHED a turn / needs input
        // (riven's pty:bell + pty:done). This is the authoritative "done" signal —
        // long-running agents never emit a shell COMMAND_FINISHED, so busy would
        // otherwise stay stuck. Always clear busy; then raise the attention ember
        // ring UNLESS you're already watching this exact pane (then it's just seen).
        // Passive fallbacks (bell / OSC notification / OSC 133) for panes that have NOT
        // proven they deliver lifecycle hooks. Once a pane is hook-backed these are
        // ignored: hooks know the difference between "paused mid-turn" and "done", and
        // letting a stray bell also drive state would fight the authoritative source.
        let hookBacked = { PaneSessionRegistry.shared.isHookBacked(paneSession) }
        tv.onActivity = { [weak self, weak tv, weak p] in
            guard let self, let p, let tv, !hookBacked() else { return }
            self.markAgentSession()   // agent activity (bell/notification) → track its edits
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, busy: false)
            let watching = self.window?.firstResponder === tv && self.window?.isKeyWindow == true
            if watching {
                p.badge = nil; tv.setRingState(nil)
                WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: false)
            } else {
                p.badge = "attn"; tv.setRingState("attn")
                WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: true)
            }
            self.refreshDockTabs()
            // The bell / agent notification is the AUTHORITATIVE "done / needs input" signal.
            // Post one completion banner per user turn (armed by Enter), only when unwatched.
            if !watching, tv.turnArmed {
                tv.turnArmed = false
                let wsName = (wsPath as NSString).lastPathComponent
                Notifications.post(title: wsName, body: "\(p.title) · \(t("term.done"))")
            }
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
        // Return pressed in a plain shell → working until OSC 133 says otherwise.
        tv.onBusy = { [weak self, weak p] in
            guard !hookBacked() else { return }
            self?.markAgentSession()   // something is working in the terminal → track its edits
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, busy: true)
            guard let p, p.badge != "attn" else { return }   // attn (needs-attention) outranks busy
            if p.badge != "busy" { p.badge = "busy" }
        }
        // Shell command finished (OSC 133) or the child exited → clear busy. Attention is
        // raised separately (bell / OSC notification), so this alone doesn't ping.
        tv.onIdle = { [weak self, weak tv, weak p] in
            guard !hookBacked() else { return }
            self?.refreshChangesAndGit()   // a command finished → an agent may have edited files
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, busy: false)
            guard let p, p.badge == "busy" else { return }
            p.badge = nil; tv?.setRingState(nil); self?.refreshDockTabs()
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
        dock.detach(panel, normalize: true)   // remove from the dock WITHOUT disposing the content
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
        let key = ["search": "title.search", "git": "title.git", "preview": "title.preview", "api": "title.api", "changes": "title.changes"]
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
    // FSEvents fires repeatedly while an agent streams a file out. Coalesce a burst into
    // ONE read per path (#60: "avoid re-reading on rapid FSEvents churn") — each read
    // otherwise allocated the file's full text again.
    private var pendingFileChanges = Set<String>()
    private var fileChangeTimer: Timer?
    // File I/O (stat + full read) and the git-baseline lookup for a change batch run
    // here, off the main thread, so a large batch never blocks the UI (#65).
    private let fileChangeQueue = DispatchQueue(label: "com.riven.filechange", qos: .utility)
    private func handleFileChange(_ path: String) {
        pendingFileChanges.insert(path)
        fileChangeTimer?.invalidate()
        fileChangeTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
            guard let self else { return }
            let paths = self.pendingFileChanges
            self.pendingFileChanges.removeAll()
            self.processFileChanges(Array(paths))
        }
    }

    // Process a whole change batch off the main thread, then apply the results on main
    // in one coalesced update (#65). Previously this ran per file ON the main thread —
    // stat + full read + a `git show` subprocess per new file + an O(N²) panel rebuild
    // (a notify() per file) — so a branch switch / bulk agent edit froze the UI for
    // seconds. Now: cheap filtering + baseline snapshot on main → all I/O and a single
    // batched `git cat-file` off main → one coalesced store mutation + panel refresh.
    private func processFileChanges(_ paths: [String]) {
        guard let ws = workspace else { return }
        let wsPath = ws.path
        guard agentSessionWorkspaces.contains(wsPath) else { return }   // only during an agent session
        // Cheap main-thread pass: filter to in-workspace, non-ignored paths and snapshot
        // the in-memory session baselines (AgentEdits is main-only; these are dict reads).
        let candidates = paths.filter { $0.hasPrefix(wsPath + "/") && !AgentEdits.isIgnored($0) }
        guard !candidates.isEmpty else { return }
        var memBaseline: [String: String] = [:]
        for p in candidates { if let b = AgentEdits.shared.baselineContent(p) { memBaseline[p] = b } }

        fileChangeQueue.async { [weak self] in
            // (path, rel, after, memBaseline?) — memBaseline nil means we must resolve the
            // git HEAD version for this file below.
            var items: [(path: String, rel: String, after: String, mem: String?)] = []
            var needGit: [String] = []
            for p in candidates {
                // Size cap BEFORE reading (#60): skip files bigger than the tracked cap so
                // an agent churning large/generated files can't push memory into the GBs.
                let attrs = try? FileManager.default.attributesOfItem(atPath: p)
                if let size = attrs?[.size] as? Int, size > AgentEdits.maxTrackedFileSize { continue }
                guard let after = try? String(contentsOfFile: p, encoding: .utf8) else { continue }  // deleted/unreadable
                let rel = String(p.dropFirst(wsPath.count + 1))
                let mem = memBaseline[p]
                if mem == nil { needGit.append(rel) }
                items.append((p, rel, after, mem))
            }
            // One process for every new-file baseline instead of one `git show` each.
            let gitBaseline = Git.showFilesBatch(cwd: wsPath, rels: needGit)

            DispatchQueue.main.async {
                guard let self, self.workspace?.path == wsPath else { return }  // workspace switched mid-flight
                var touched = false
                AgentEdits.shared.batch {
                    for it in items {
                        // `before` is the SESSION baseline and stays fixed, so the diff is
                        // cumulative (first add + later edit both show).
                        let before = it.mem ?? gitBaseline[it.rel]
                        if before == it.after { AgentEdits.shared.resolve(path: it.path); touched = true; continue }
                        // Seed the baseline once (first time we see the file) so it's fixed.
                        if AgentEdits.shared.baselineContent(it.path) == nil {
                            AgentEdits.shared.updateBaseline(it.path, before ?? "")
                        }
                        AgentEdits.shared.record(path: it.path, workspace: wsPath,
                                                 before: before ?? "", after: it.after, isNew: before == nil)
                        touched = true
                    }
                }
                if touched { self.ensureChangesPanel() }
            }
        }
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
        // Split the FOCUSED group (the pane you're looking at), not the first terminal.
        dock.addPanel(p, reference: dock.activeGroup ?? currentTerminalPanel()?.group, direction: dir)
        (p.content as? TerminalView)?.focusTerminal()
    }
    // ⌃1..9 — 활성 패널 그룹 안의 N번째 탭으로 이동한다. 예전에는 모든 그룹의 터미널을
    // 통틀어 N번째를 골라서, 단축키가 그룹 사이를 건너뛰어 버렸다.
    private func selectTerminal(_ n: Int) {
        guard let g = activeDock?.activeGroup, g.panels.indices.contains(n - 1) else { return }
        let p = g.panels[n - 1]
        g.select(id: p.id)
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
        let p = ensureEditorPanel()
        if p.group == nil || p.group?.manager !== dock {
            // 이 워크스페이스에서 마지막으로 있던 자리로 복원 (#4); 기록이 없거나
            // 그 자리가 사라졌으면 기존 기본 위치로:
            // Append to the rightmost group so the editor sits to the right of the
            // terminals and BEFORE right-side aux panels are restored (stable order).
            if !dock.restorePlacement(p) {
                // No saved spot for this workspace → default. The editor is the dominant
                // content surface: hint it to half the dock regardless of how many
                // terminal columns exist (a bare 1/N share would make the editor a
                // sliver next to 2-3 terminals).
                dock.addPanel(p, reference: dock.groups.last, direction: .right,
                              sizeHint: dock.container.bounds.width * 0.5)
            }
        } else {
            p.group?.select(id: "editor")
        }
    }
    // 공유 에디터 패널(싱글턴)을 만들거나 돌려준다 — 배치는 호출자 몫 (showEditorPane
    // 의 기본 배치 또는 레이아웃 복원의 스냅샷 자리).
    private func ensureEditorPanel() -> DockPanel {
        if editorDockPanel == nil {
            let p = DockPanel(id: "editor", title: t("title.editor"),
                icon: NSImage(systemSymbolName: "curlybraces", accessibilityDescription: nil),
                content: editorPane, closable: true)
            p.onClose = { [weak self] in self?.closeAllEditorTabs() }
            editorDockPanel = p
        }
        return editorDockPanel!
    }
    private func closeAllEditorTabs() {
        guard let ws = workspace else { return }
        let st = state(for: ws)
        for p in st.openTabs { editor.close(path: p) }
        st.openTabs = []; st.activeTab = nil
        tabBar.closeAll(); editor.showEmpty()
        editorDockPanel = nil
        // 사용자가 에디터 패널을 직접 닫았으니 남은 자리 기록은 지운다 — 다음에
        // 열 때는 기본 위치로 (#4).
        activeDock?.savedPlacements["editor"] = nil
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
            // Only revert a file we're actually tracking an agent edit for — bounds this
            // web-bridge write to known workspace files (edits are recorded from FSEvents
            // gated on the workspace root), rejecting any injected arbitrary path.
            guard let e = AgentEdits.shared.edit(for: path) else { return }
            try? newAfter.write(toFile: path, atomically: true, encoding: .utf8)
            AgentEdits.shared.updateBaseline(path, newAfter)
            AgentEdits.shared.record(path: path, workspace: self?.workspace?.path ?? "", before: e.before, after: newAfter, isNew: e.hasBaseline ? false : true)
            ed?.agentDiff(path: path, before: e.before, after: newAfter)
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
        // A WKWebView reload (dock reparent / WebKit recycle) wipes every Monaco model,
        // but native still lists all open tabs. The ready handler re-pushes only the
        // active file, so the others became native-open / web-missing — reopening one hit
        // the "already open → send empty content" path and Monaco showed a blank buffer.
        // Re-push the whole set here. Primary editor only (it owns the workspace tabs).
        if !secondary { ed.onReady = { [weak self, weak ed] in self?.resyncOpenTabs(to: ed) } }
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

    // Re-push every open tab to the editor after a WKWebView reload wiped its models.
    // Active tab is already restored by EditorView's own re-push; this fills in the rest
    // (inactive tabs) so reopening any of them doesn't land on a blank buffer. Files are
    // read off-main (a big workspace can have many tabs); openBackground is idempotent,
    // so a redundant call on the initial load is harmless.
    private func resyncOpenTabs(to ed: EditorView?) {
        guard let ed, let ws = workspace else { return }
        let st = state(for: ws)
        let inactive = st.openTabs.filter { $0 != st.activeTab }
        guard !inactive.isEmpty else { return }
        RLog.log("editor onReady: re-syncing \(inactive.count) inactive tab(s) after WebView (re)load")
        DispatchQueue.global(qos: .userInitiated).async {
            let loaded = inactive.map { ($0, (try? String(contentsOfFile: $0, encoding: .utf8)) ?? "") }
            DispatchQueue.main.async {
                guard self.workspace == ws else { return }   // workspace switched meanwhile
                let cur = self.state(for: ws)
                for (p, content) in loaded where cur.openTabs.contains(p) {
                    ed.openBackground(path: p, content: content)
                }
            }
        }
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

        // Snapshot the OUTgoing workspace's FULL dock layout (split tree + pane sizes% +
        // panel types, incl. editor/aux still in place) so returning restores it EXACTLY —
        // not just "which aux were open". Must run BEFORE detaching the singletons below.
        if let old = workspace, old != url {
            state(for: old).openAux = Set(auxDockPanels.keys)
            state(for: old).pendingLayout = activeDock?.snapshot()
        }

        // 전환하면 공유 에디터 웹뷰의 모델을 정리하므로(#7, rebuildTabs), 저장 안 된
        // 탭은 먼저 디스크에 보존한다. 저장이 도착하면 save()가 스테일 디스크 내용으로
        // 다시 열린 모델을 새 내용으로 갈아 끼운다.
        if workspace != nil {
            for p in tabBar.tabs where tabBar.isDirty(p) {
                pendingSwitchSaves.insert(p)
                editor.requestSave(path: p)
            }
        }

        // Detach the shared editor + aux panels from the OUTgoing workspace's dock
        // (their views are singletons; only one dock can hold them at a time).
        // 분리 전에 각 싱글턴이 있던 자리를 그 독에 기록해 두고, 돌아올 때 기본
        // 위치가 아니라 그 자리로 복원한다 (#4).
        if let old = activeDock {
            if let ep = editorDockPanel, ep.group?.manager === old {
                old.recordPlacement(of: ep); old.detach(ep)
            }
            for (_, ap) in auxDockPanels where ap.group?.manager === old {
                old.detach(ap)   // singleton view leaves this workspace's dock; re-tabs into focus on return
            }
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
        // Invariant: a non-empty dock must have a LIVE activeGroup. Detaching the outgoing
        // workspace's aux panels can leave activeGroup (a weak ref) dangling → nil, which
        // makes the next addPanel fall through to setRoot() and wipe the terminals. Re-point
        // it at a live pane before anything restores. Also protects the ⌘T/agent add paths.
        if dock.activeGroup == nil, let g = dock.groups.first(where: { !$0.panels.isEmpty }) { dock.setActive(g) }
        // 이전 세션의 독 레이아웃 전체(스플릿 트리/팬 크기/탭 구성)를 재현한다 — 독을
        // 처음 만들 때 한 번. 서술자 → 패널: 터미널은 새로 만들고(에이전트는 이름으로
        // 되찾음), 에디터/aux 싱글턴은 공유 인스턴스를 스냅샷의 자리에 부착한다.
        // 지워진 에이전트는 nil → 그 패널만 빠지고 나머지 레이아웃은 그대로 선다.
        // Restore the EXACT saved layout — on first visit (session restore) AND on every
        // return (the snapshot taken on switch-away). Terminals already alive in this dock
        // are REUSED (their shells survive); only missing ones are freshly spawned.
        var restoredLayout = false
        if let snap = st.pendingLayout {
            st.pendingLayout = nil
            let agents = AgentDiscovery.available()
            var liveTerms = dock.groups.flatMap { $0.panels }.filter { $0.content is TerminalView }
            restoredLayout = dock.restore(snap) { [weak self] desc -> DockPanel? in
                guard let self else { return nil }
                if desc.hasPrefix("term:") {
                    // "term:<agent>" optionally "\t<sessionId>"
                    let rest = desc.dropFirst("term:".count).split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
                    let name = rest.first.map(String.init) ?? ""
                    let sid = rest.count > 1 ? String(rest[1]) : nil
                    if let i = liveTerms.firstIndex(where: { ($0.agentName ?? "") == name }) {
                        return liveTerms.remove(at: i)   // reuse the live terminal (keep its shell)
                    }
                    if name.isEmpty { return self.makeTerminalPanel(for: st, sessionId: sid) }
                    guard let agent = agents.first(where: { $0.name == name }) else { return nil }
                    return self.makeTerminalPanel(for: st, agent: agent, sessionId: sid)   // resume this pane's session
                }
                if desc == "editor" { return self.ensureEditorPanel() }
                return self.makeAuxPanel(desc)
            }
            if restoredLayout {
                st.pendingTerminals = nil                 // 구버전 폴백 기록은 더 필요 없다
                st.openAux = Set(auxDockPanels.keys)      // 레이아웃이 배치한 aux가 곧 열린 aux
                (dock.activeGroup?.activePanel?.content as? TerminalView)?.focusTerminal()
            }
        }
        // Add the default terminal now that the dock is in the window (a libghostty
        // surface must be created in-window with a real size to spawn its shell).
        if !restoredLayout, isNew, let g = dock.activeGroup, g.panels.isEmpty {
            // (레이아웃 기록이 없거나 복원이 실패한) 폴백: 구버전 세션의 터미널 구성을
            // 재현한다 (에이전트 패널은 그 에이전트로 다시 실행). 기록이 없으면 기본
            // 터미널 하나. 프로세스 자체는 되살릴 수 없고 새 셸로 뜬다.
            let wanted = st.pendingTerminals ?? [""]
            st.pendingTerminals = nil
            let agents = AgentDiscovery.available()
            var first: DockPanel?
            for (i, name) in wanted.enumerated() {
                let agent = name.isEmpty ? nil : agents.first { $0.name == name }
                let term = makeTerminalPanel(for: st, agent: agent)
                if i == 0 { g.add(term); first = term }
                else { dock.addPanel(term, reference: dock.groups.last, direction: .right) }
            }
            if let g0 = first?.group { dock.setActive(g0) }
            (first?.content as? TerminalView)?.focusTerminal()
        }

        // Restore the aux panels this workspace had open (search/git/preview/changes).
        // 에디터보다 먼저 (detach의 역순, LIFO): 에디터의 자리 기록이 aux 그룹을
        // 이웃으로 참조하는 경우가 많아, aux가 먼저 제자리에 있어야 에디터도
        // 기록된 자리로 복원된다 (#4). 레이아웃 복원이 이미 배치했다면 건너뛴다
        // (기본 가장자리에 또 붙이지 않게).
        if !restoredLayout {
            for id in ["search", "git", "preview", "changes", "api"] where st.openAux.contains(id) {
                if auxDockPanels[id] == nil { toggleDockPanel(id) }
            }
        }
        // Restore this workspace's editor tabs (adds the editor panel if needed).
        rebuildTabs(for: st)

        explorer.setRoot(url)
        searchPanel.setRoot(url); gitPanel.setRoot(url); changesPanel.setWorkspace(url)
        window.title = "riven — \(url.lastPathComponent)"
        statusBar.setWorkspaceName(url.lastPathComponent)
        // Header: folder name + dimmed path.
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let short = url.path.hasPrefix(home) ? "~" + url.path.dropFirst(home.count) : url.path
        let hs = NSMutableAttributedString(string: url.lastPathComponent,
            attributes: [.foregroundColor: Theme.fg, .font: UIScale.font(12, .medium)])
        hs.append(NSAttributedString(string: "   \(short)",
            attributes: [.foregroundColor: Theme.fgDim, .font: UIScale.font(11)]))
        headerLabel?.attributedStringValue = hs
        rail.setActive(url)   // keep the highlighted card in sync with the shown workspace
        refreshGit()

        // Agent-edit tracking: snapshot the session baseline + watch the tree so files
        // the agent writes appear in the Changes panel with before/after diffs.
        AgentEdits.shared.snapshot(workspace: url)
        agentWatch?.stop()
        agentWatch = AgentWatch(root: url) { [weak self] path in
            self?.handleFileChange(path)
            // Skip churn inside ignored dirs (.git/node_modules/.build/…) — those aren't
            // shown in the tree, so rebuilding on them just wasted work + risked flicker.
            if !FileNode.isIgnoredPath(path) { self?.scheduleExplorerRefresh() }
        }
    }

    // Debounced explorer reload: the FS watcher bursts on writes, so coalesce (0.4s) and
    // reload the tree once, preserving expansion.
    private var explorerRefreshTimer: Timer?
    private func scheduleExplorerRefresh() {
        DispatchQueue.main.async {
            self.explorerRefreshTimer?.invalidate()
            self.explorerRefreshTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                self?.explorer.refreshTree()
            }
        }
    }

    private func switchWorkspace(_ url: URL) { activate(url); persistSession() }

    // Close a workspace: tear down its dock + state, switch to another (or empty).
    private func closeWorkspace(_ url: URL) {
        if let st = states[url] {
            st.dock?.container.removeFromSuperview()
            for p in st.dock?.groups.flatMap({ $0.panels }) ?? [] { (p.content as? TerminalView)?.dispose() }
        }
        states[url] = nil
        lsp.stopClients(rootPath: url.path)   // don't leave orphaned language-server processes
        AgentEdits.shared.clearWorkspace(url.path)   // release retained file contents (#60)
        PaneSessionRegistry.shared.clearWorkspace(url.path)   // stop routing hooks to dead panes
        agentSessionWorkspaces.remove(url.path)
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

    // A plain terminal pane (`term:\t<uuid>`) whose Claude session file for <uuid> exists
    // in this workspace's dir was running `claude` (typed, via the shim) at save time →
    // rewrite it to a "Claude Code" agent pane so restore RE-LAUNCHES `claude --session-id
    // <uuid>` and the conversation comes back automatically (not just resumable on re-type).
    private func markClaudePanes(_ node: [String: Any], cwd: String) -> [String: Any] {
        var n = node
        if n["type"] as? String == "group", let panels = n["panels"] as? [String] {
            n["panels"] = panels.map { desc -> String in
                guard desc.hasPrefix("term:") else { return desc }
                let rest = desc.dropFirst("term:".count).split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
                let name = rest.first.map(String.init) ?? ""
                guard name.isEmpty, rest.count > 1 else { return desc }   // only plain panes carrying a uuid
                let uuid = String(rest[1])
                return claudeSessionExists(cwd: cwd, sessionId: uuid) ? "term:Claude Code\t\(uuid)" : desc
            }
        } else if n["type"] as? String == "split", let kids = n["children"] as? [[String: Any]] {
            n["children"] = kids.map { markClaudePanes($0, cwd: cwd) }
        }
        return n
    }
    // Claude stores transcripts at ~/.claude/projects/<encoded cwd>/<id>.jsonl, where the
    // encoding replaces every character outside [A-Za-z0-9] with '-'.
    //
    // The ASCII guard matters: Swift's isLetter/isNumber are true for 한글 and other
    // non-ASCII scripts, so without it a workspace at "…/한글폴더/proj" encoded to
    // "-…-한글폴더-proj" while Claude wrote "-…------proj" (one dash per character).
    // The paths never matched, so panes under any non-ASCII path silently failed to be
    // promoted back to Claude Code panes on restore. Verified against a real transcript
    // path on 2026-07-27.
    private func claudeSessionExists(cwd: String, sessionId: String) -> Bool {
        let enc = String(cwd.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
        let path = (NSHomeDirectory() as NSString)
            .appendingPathComponent(".claude/projects/\(enc)/\(sessionId).jsonl")
        return FileManager.default.fileExists(atPath: path)
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
        // 독 레이아웃 전체를 저장한다 — 스플릿 트리/각 팬의 크기/탭 묶음/활성 탭까지,
        // 재시작하면 패널 배치가 그대로 돌아온다. 이번 실행에서 방문하지 않은 워크스
        // 페이스는 이전 기록(pendingLayout)을 그대로 이월하고, 구버전 "terminals" 기록만
        // 있으면 그 구성을 레이아웃 형식으로 승격해 저장한다. (실행 중이던 프로세스
        // 자체는 riven의 자식이라 종료와 함께 죽는다 — 되살리는 건 패널 구성뿐이다.)
        var layouts: [String: Any] = [:]
        for url in workspaces {
            let st = state(for: url)
            if let snap = st.dock?.snapshot() {
                layouts[url.absoluteString] = markClaudePanes(snap, cwd: url.path)   // auto-resume typed claude
            } else if let pending = st.pendingLayout {
                layouts[url.absoluteString] = pending    // 아직 방문 전이면 기존 기록 유지
            } else if let terms = st.pendingTerminals, !terms.isEmpty {
                let groups: [[String: Any]] = terms.map {
                    ["type": "group", "panels": ["term:\($0)"], "active": 0]
                }
                layouts[url.absoluteString] = groups.count == 1 ? groups[0]
                    : ["type": "split", "vertical": true,
                       "extents": Array(repeating: Double(1), count: groups.count),
                       "children": groups]
            }
        }
        var names: [String: String] = [:]
        for url in workspaces { if let n = workspaceNames[url] { names[url.absoluteString] = n } }
        // Left fixed sidebar (workspace rail over explorer): remember the divider as a
        // fraction of the sidebar height so the split restores at the same proportion.
        var sidebarRail = 0.0
        if let sv = sidebarSplit, sv.bounds.height > 1, sv.arrangedSubviews.count >= 2 {
            sidebarRail = Double(sv.arrangedSubviews[0].frame.height / sv.bounds.height)
        }
        var session: [String: Any] = [
            "workspaces": workspaces.map { $0.absoluteString },
            "active": workspace?.absoluteString ?? "",
            "tabs": tabs,
            "activeTab": actives,
            "colors": colors,
            "names": names,
            "layout": layouts
        ]
        if sidebarRail > 0.05 { session["sidebarRail"] = sidebarRail }
        Settings.shared.set("session", session)
        activeDock?.dumpTree("persist")   // 레이아웃 이상 추적용 (디버그 로그에만)
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
        let names = s["names"] as? [String: String] ?? [:]
        let layouts = s["layout"] as? [String: Any] ?? [:]
        let terms = s["terminals"] as? [String: [String]] ?? [:]   // 구버전 세션 (하위 호환)
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
            st.pendingLayout = layouts[key] as? [String: Any]   // 독을 만들 때 이 레이아웃으로 재현
            st.pendingTerminals = terms[key]        // layout이 없는 구버전 세션의 폴백
            rail.addWorkspace(url)
            if let hex = colors[key] { workspaceColors[url] = hex; rail.setColor(url, Theme.hex(hex)) }   // restore card color
            if let n = names[key] { workspaceNames[url] = n; rail.setName(url, n) }                        // restore custom name
            restored.append(url)
        }
        guard !restored.isEmpty else { return }
        workspaces = restored
        let activeKey = s["active"] as? String
        let active = restored.first { $0.absoluteString == activeKey } ?? restored.first!
        activate(active)
        // Restore the left sidebar (rail/explorer) split proportion once it's laid out.
        if let frac = s["sidebarRail"] as? Double, frac > 0.05, frac < 0.95 {
            DispatchQueue.main.async { [weak self] in
                guard let self, let sv = self.sidebarSplit, sv.bounds.height > 1 else { return }
                sv.setPosition(CGFloat(frac) * sv.bounds.height, ofDividerAt: 0)
            }
        }
    }

    // Rebuild the tab bar + editor for a workspace's open tabs. 에디터 웹뷰는 모든
    // 워크스페이스가 공유하는 하나의 WKWebView라서, 전환 시 이전 워크스페이스의
    // 모델/탭이 그대로 남아 있었다(#7) — 먼저 전부 정리하고 이 워크스페이스의
    // 탭을 전부 다시 연다 (활성 탭을 마지막에 열어 그 탭이 보이게).
    private func rebuildTabs(for st: WorkspaceState) {
        tabBar.closeAll()
        editor.showEmpty()   // 이전 워크스페이스의 모델을 전부 dispose + 그룹 하나로 리셋
        // 디스크에서 사라진 파일은 건너뛴다 (restoreSession과 같은 필터).
        let fm = FileManager.default
        st.openTabs = st.openTabs.filter { fm.fileExists(atPath: $0) }
        if let a = st.activeTab, !st.openTabs.contains(a) { st.activeTab = nil }
        if st.activeTab == nil { st.activeTab = st.openTabs.last }
        for p in st.openTabs { tabBar.open(p) }
        guard let active = st.activeTab else {
            hideEditorPane()   // workspace has no open tabs → terminal full width
            statusBar.setFileInfo("")
            return
        }
        showEditorPane()
        showTabContent(active)   // 활성 탭은 동기 로드 → 즉시 보임
        tabBar.setActive(active)
        statusBar.setFileInfo(fileInfo(active))
        // 비활성 탭 복원: 파일 읽기를 메인 스레드에서 하면 탭이 많거나 큰 워크스페이스에서
        // 전환 때마다 UI가 멈춘다 — 백그라운드에서 읽고, 활성 뷰를 뺏지 않고 탭 칩만 추가한다.
        let inactive = st.openTabs.filter { $0 != active }
        guard !inactive.isEmpty, let ws = workspace else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let loaded = inactive.map { ($0, (try? String(contentsOfFile: $0, encoding: .utf8)) ?? "") }
            DispatchQueue.main.async {
                guard self.workspace == ws else { return }   // 그새 다른 워크스페이스로 전환됨 → 취소
                let cur = self.state(for: ws)
                for (p, content) in loaded where cur.openTabs.contains(p) {
                    self.editor.openBackground(path: p, content: content)
                }
            }
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

    // Monaco here runs on the MAIN THREAD (the editor WebView loads from file://, which
    // blocks its Web Workers — see EditorView), so a very large file tokenizes on the UI
    // thread and freezes the app: opening it looks like "nothing happens". Refuse past a
    // cap, matching how VSCode guards large files. Applies to both text and image opens
    // (an image is base64'd into a data: URL, ~1.33× its bytes in memory).
    private static let maxEditorFileSize = 10 * 1024 * 1024   // 10 MB

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
            if Self.imageMIME(path) != nil { editor.showImageTab(path: path) }
            else { editor.open(path: path, content: "") }   // Monaco reuses the existing model
            statusBar.setFileInfo(fileInfo(path))
            return
        }
        // Size guard (before any read): a huge file would freeze Monaco on the main
        // thread or balloon memory as a data: URL. Refuse with a clear message.
        if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
           let size = attrs[.size] as? Int, size > Self.maxEditorFileSize {
            let a = NSAlert()
            a.messageText = t("editor.tooLarge")
            a.informativeText = t("editor.tooLargeBody", [
                "name": url.lastPathComponent,
                "size": ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file),
                "limit": ByteCountFormatter.string(fromByteCount: Int64(Self.maxEditorFileSize), countStyle: .file)])
            a.alertStyle = .warning
            a.runModal()
            RLog.log("openFile: refused \(path) — \(size) bytes > cap")
            return
        }
        // 이미지는 Monaco가 못 그리므로 에디터 탭 안의 이미지 뷰어로 연다 (VS Code의
        // Image Preview와 같은 흐름 — 탭/닫기/분할이 다른 파일과 동일하게 동작).
        // 에디터 웹뷰는 리소스 폴더로 읽기 권한이 묶여 있어 임의 경로의 file:// 이미지를
        // 못 불러오므로, 바이트를 읽어 data: URL로 넘긴다. SVG는 VS Code처럼 텍스트로.
        if let mime = Self.imageMIME(path) {
            guard let data = try? Data(contentsOf: url) else {
                RLog.log("openFile: cannot read image \(path)"); return
            }
            st.openTabs.append(path)
            st.activeTab = path
            showEditorPane()
            tabBar.open(path)
            editor.openImage(path: path, src: "data:\(mime);base64,\(data.base64EncodedString())")
            statusBar.setFileInfo(fileInfo(path))
            persistSession()
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

    // 에디터에서 이미지 뷰어로 열 확장자 → MIME. SVG는 제외(텍스트로 편집하는 게 유용하고
    // VS Code도 기본은 텍스트다).
    static func imageMIME(_ path: String) -> String? {
        switch (path as NSString).pathExtension.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "bmp": return "image/bmp"
        case "ico": return "image/x-icon"
        case "avif": return "image/avif"
        case "heic": return "image/heic"
        case "tiff", "tif": return "image/tiff"
        default: return nil
        }
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

    // 워크스페이스 전환 직전에 자동 저장을 요청한 더티 탭들 (#7). 저장이 도착할
    // 때쯤이면 rebuildTabs가 스테일 디스크 내용으로 모델을 다시 열었을 수 있으므로,
    // 쓰기 후 그 모델을 새 내용으로 갈아 끼운다.
    private var pendingSwitchSaves: Set<String> = []
    private func save(path: String, content: String) {
        // A dirty tab we queued to flush during a workspace switch. This runs BEFORE the
        // tab-membership guard below: by the time the save round-trips, rebuildTabs may
        // have already swapped `tabBar.tabs` to the new workspace, so the guard would
        // wrongly reject it and drop the edit. These paths are trusted (we queued them
        // ourselves from the outgoing workspace's open, dirty tabs).
        if pendingSwitchSaves.remove(path) != nil {
            writeAndMark(path: path, content: content)
            reloadIfOpen(path)   // 현재 워크스페이스에 열려 있으면 저장본으로 갱신
            return
        }
        // Defense-in-depth: only write to a file that's actually open as a tab. `path` comes
        // from the WKWebView bridge; even though the editor content is our own local bundle,
        // this bounds a save to files the user opened (incl. out-of-workspace ⌘O files) and
        // rejects any arbitrary path a compromised web context might inject.
        guard tabBar.tabs.contains(path) else { RLog.log("save: rejected untracked path \(path)"); return }
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
        // Discard output to /dev/null — a noisy eslint (>64KB) would fill an unread pipe
        // and wedge waitUntilExit() on the save thread.
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
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
        let inPipe = Pipe(), outPipe = Pipe(); p.standardInput = inPipe; p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        // Write stdin on a background queue so we read stdout concurrently — otherwise a
        // large formatted output fills prettier's stdout pipe while we're still blocked
        // writing stdin → deadlock (save spins forever).
        let inData = content.data(using: .utf8) ?? Data()
        DispatchQueue.global(qos: .userInitiated).async {
            inPipe.fileHandleForWriting.write(inData)
            try? inPipe.fileHandleForWriting.close()
        }
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
        let updateItem = NSMenuItem(title: "업데이트 확인…", action: #selector(Updater.checkForUpdates(_:)), keyEquivalent: "")
        updateItem.target = Updater.shared
        appMenu.addItem(updateItem)
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
        addRemap(termMenu, t("run.title"), "run.script", #selector(runScriptMenu))
        addRemap(termMenu, t("menu.clearTerminal"), "term.clear", #selector(clearTerminalMenu))
        addRemap(termMenu, t("menu.splitRight"), "term.splitRight", #selector(splitRightMenu))
        addRemap(termMenu, t("menu.splitDown"), "term.splitDown", #selector(splitDownMenu))
        addRemap(termMenu, t("menu.nextTerminal"), "term.next", #selector(nextTerminalMenu))
        addRemap(termMenu, t("menu.prevTerminal"), "term.prev", #selector(prevTerminalMenu))
        termMenu.addItem(.separator())
        // Directional focus between split panes (⌃⌘←→↑↓) — riven focusGroupInDirection.
        addRemap(termMenu, t("menu.paneLeft"), "pane.left", #selector(focusPaneLeftMenu))
        addRemap(termMenu, t("menu.paneRight"), "pane.right", #selector(focusPaneRightMenu))
        addRemap(termMenu, t("menu.paneUp"), "pane.up", #selector(focusPaneUpMenu))
        addRemap(termMenu, t("menu.paneDown"), "pane.down", #selector(focusPaneDownMenu))
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
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
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
            QuickAction(title: t("menu.newTerminal"), hint: "⌘T", symbol: "terminal") { [weak self] in self?.newTerminal() }
        ]
        // Installed AI agents (scanned from PATH) — riven's AgentPicker entries.
        for a in AgentDiscovery.available() {
            actions.append(QuickAction(title: a.name, hint: t("agent.label"), symbol: a.symbol) { [weak self] in
                self?.launchAgent(a)
            })
        }
        actions.append(contentsOf: [
            QuickAction(title: t("title.editor"), hint: "", symbol: "doc.text") { [weak self] in self?.showEditorPane(); self?.editor.focusEditor() },
            QuickAction(title: t("title.search"), hint: "⌘⇧F", symbol: "magnifyingglass") { [weak self] in self?.toggleDockPanel("search") },
            QuickAction(title: t("title.git"), hint: "⌘⇧G", symbol: "arrow.triangle.branch") { [weak self] in self?.toggleDockPanel("git") },
            QuickAction(title: t("title.preview"), hint: "⌘⇧V", symbol: "safari") { [weak self] in self?.toggleDockPanel("preview") },
            QuickAction(title: t("api.test"), hint: "", symbol: "network") { [weak self] in self?.toggleDockPanel("api") },
            QuickAction(title: t("title.changes"), hint: "⌘⇧C", symbol: "clock.arrow.circlepath") { [weak self] in self?.toggleDockPanel("changes") },
            QuickAction(title: t("menu.newWorkspace"), hint: "⌘⇧N", symbol: "folder.badge.plus") { [weak self] in self?.openFolder() },
            QuickAction(title: t("menu.toggleSidebar"), hint: "⌘B", symbol: "sidebar.left") { [weak self] in self?.toggleSidebar() }
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
            Command(title: t("menu.openFolder"), hint: "⌘O") { [weak self] in self?.openFolder() },
            Command(title: t("menu.quickOpen"), hint: "⌘P") { [weak self] in self?.showQuickOpen() },
            Command(title: t("menu.save"), hint: "⌘S") { [weak self] in if let p = self?.tabBar.active { self?.editor.requestSave(path: p) } },
            Command(title: t("menu.newTerminal"), hint: "⌘T") { [weak self] in self?.newTerminal() },
            Command(title: t("menu.toggleSidebar"), hint: "⌘B") { [weak self] in self?.toggleSidebar() },
            Command(title: t("cmd.aiComplete"), hint: "⌃Space") { [weak self] in self?.editor.triggerAI() },
            Command(title: t("cmd.gitGraph"), hint: "⌘⇧G") { [weak self] in self?.toggleDockPanel("git") },
            Command(title: t("cmd.apiPanel"), hint: "") { [weak self] in self?.toggleDockPanel("api") },
            Command(title: t("cmd.distributeEvenly"), hint: "⌥⌘=") { [weak self] in self?.activeDock?.distributeEvenly() },
            Command(title: t("menu.splitRight"), hint: "⌘\\") { [weak self] in self?.editor.splitEditor("right") },
            Command(title: t("menu.splitDown"), hint: "⌥⌘\\") { [weak self] in self?.editor.splitEditor("down") },
            Command(title: t("menu.closeTab"), hint: "⌘W") { [weak self] in if let p = self?.tabBar.active { self?.closeTab(p) } }
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
                activeDock?.detach(panel, normalize: true)
                auxDockPanels[panel.id] = nil
                activeDock?.savedPlacements[panel.id] = nil   // 직접 닫음 → 자리 기록도 지움 (#4)
            }
            return
        }
        // A stray editor tab with no active dock panel → close it.
        if let p = tabBar.active { closeTab(p); return }
        // 여기까지 왔다는 건 "활성 그룹에 닫을 패널이 없다"는 뜻일 뿐, 독이 비었다는
        // 뜻이 아니다. 그룹이 비워지는 과정에서 활성 그룹이 빈 그룹이 되거나 참조가
        // 끊기면 다른 열에 패널이 멀쩡히 남아 있어도 여기로 떨어져 앱이 꺼져 버렸다.
        // 남아 있는 패널이 하나라도 있으면 절대 종료하지 않고 살아있는 패널로 포커스를
        // 옮긴다 (다음 ⌘W가 그 패널을 닫는다).
        if let dock = activeDock, dock.totalPanels > 0 {
            if let g = dock.groups.first(where: { !$0.panels.isEmpty }) { dock.setActive(g) }
            return
        }
        // 정말 아무것도 안 남았을 때만 종료 — 실수로 닫히지 않게 한 번 확인한다.
        confirmQuit()
    }

    // ⌘W로 마지막 패널까지 닫아 앱이 종료되는 경로에서 한 번 확인받는다.
    private func confirmQuit() {
        let a = NSAlert()
        a.messageText = t("quit.title")
        a.informativeText = t("quit.body")
        a.addButton(withTitle: t("quit.confirm"))   // 첫 버튼 = 기본(Return)
        a.addButton(withTitle: t("common.cancel"))
        a.alertStyle = .warning
        guard a.runModal() == .alertFirstButtonReturn else { return }
        window?.performClose(nil)
    }
    private func terminalHasFocus() -> Bool { window?.firstResponder is TerminalView }

    // ---- global UI zoom (⌘+ / ⌘- / ⌘0) — scales the WHOLE UI (editor + terminals +
    // all AppKit chrome), matching riven's browser page-zoom, via UIScale. ----
    @objc private func zoomInMenu() { applyZoom(UIScale.step(+1), delta: +1) }
    @objc private func zoomOutMenu() { applyZoom(UIScale.step(-1), delta: -1) }
    @objc private func zoomResetMenu() { applyZoom(UIScale.reset(), delta: 0) }
    private func applyZoom(_ baseFont: Int, delta: Int) {
        // ⌘+/⌘−/⌘0 scales EVERYTHING. The editor and terminal sizes are the user's chosen
        // Settings sizes multiplied by the zoom factor (UIScale.editorFontSize /
        // .terminalFontSize) — not a separate 12pt base — so zoom and the font-size setting
        // compose instead of overwriting each other.
        editor.setFontSize(UIScale.editorFontSize)
        // Terminals: rebuild the ghostty config with the new absolute font-size (the
        // relative increase/decrease bindings drifted and sometimes no-op'd).
        GhosttyApp.shared.reloadTheme()   // config carries font-size = UIScale.terminalFontSize
        TerminalView.liveSurfaces().forEach { TerminalView.view(for: $0)?.setFontSize(UIScale.terminalFontSize) }
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
        headerLabel?.font = UIScale.font(12, .medium)
        headerUsage?.font = UIScale.font(11)
        rebuildPinnedUsage()
        UIScale.broadcast()   // re-font every registered aux panel (changes/search/git/preview/api/…)
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
    // ⌘⇧] / ⌘⇧[ : context-sensitive. When the code editor holds focus, cycle its OPEN
    // TABS (so the same chord that moves between terminals also moves between open files,
    // and focus stays in the editor); otherwise cycle terminals. Fixes the old behavior
    // where the chord always jumped to a terminal and never came back to the editor (#8).
    @objc private func nextTerminalMenu() {
        if editor.isEditorFocused() { editor.nextTab() } else { cycleTerminal(1) }
    }
    @objc private func prevTerminalMenu() {
        if editor.isEditorFocused() { editor.prevTab() } else { cycleTerminal(-1) }
    }

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
        guard workspace != nil, let dock = activeDock else { return }
        if let existing = auxDockPanels[id] {
            dock.detach(existing, normalize: true); auxDockPanels[id] = nil
            return
        }
        if bodySplit.arrangedSubviews.first?.isHidden ?? false { toggleSidebar() }
        guard let panel = makeAuxPanel(id) else { return }
        // A panel is just an AREA in the dock tree; only its CONTENT differs by type.
        // So adding one splits the FOCUSED group to the right — exactly like ⌘D — for
        // every type (search/git/preview/api/changes). No per-type side/width, no fixed
        // edge, no tab. If the dock is empty, addPanel falls through to a full-size root.
        // `?? groups.last`: after a workspace switch `activeGroup` can be nil (its weak ref
        // died when the outgoing aux group was cleaned up). Without a live anchor, addPanel
        // would fall through to setRoot() and EJECT THE WHOLE TERMINAL TREE — the reported
        // "terminals disappear on workspace return" bug. groups.last is a live terminal group.
        dock.addPanel(panel, reference: dock.activeGroup ?? dock.groups.last, direction: .right)
        if id == "search" { searchPanel.focusQuery() }
        else if id == "preview" { previewPanel.focusURL() }
    }

    // aux 패널 생성만 분리 (toggleDockPanel과 레이아웃 복원이 공용): 제목·심볼·콘텐츠
    // 스위치 + onClose 핸들러 + auxDockPanels 등록까지. 독에 어디에 붙일지는 호출자가
    // 정한다 (토글은 기본 가장자리, 레이아웃 복원은 스냅샷의 자리).
    private func makeAuxPanel(_ id: String) -> DockPanel? {
        guard let ws = workspace else { return nil }
        let title: String; let symbol: String
        let content: NSView
        switch id {
        case "search":  title = t("title.search"); symbol = "magnifyingglass"; searchPanel.setRoot(ws); content = searchPanel
        case "git":     title = t("title.git"); symbol = "arrow.triangle.branch"; sourceControl.setRoot(ws); content = sourceControl
        case "preview": title = t("title.preview"); symbol = "safari"; content = previewPanel
        case "api":     title = t("title.api"); symbol = "network"; content = apiPanel
        case "changes": title = t("title.changes"); symbol = "clock.arrow.circlepath"; changesPanel.setWorkspace(ws); content = changesPanel
        default: return nil
        }
        let panel = DockPanel(id: id, title: title,
            icon: NSImage(systemSymbolName: symbol, accessibilityDescription: nil), content: content)
        panel.onClose = { [weak self] in
            self?.auxDockPanels[id] = nil
            self?.activeDock?.savedPlacements[id] = nil   // × 로 닫음 → 자리 기록도 지움 (#4)
        }
        auxDockPanels[id] = panel
        return panel
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
        title.font = UIScale.font(10, .semibold); title.textColor = Theme.fgDim
        title.translatesAutoresizingMaskIntoConstraints = false; box.addSubview(title)
        let unpin = NSButton(title: " 고정 해제", target: self, action: #selector(unpinUsageMenu))
        unpin.image = NSImage(systemSymbolName: "pin.slash", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .regular))
        unpin.imagePosition = .imageLeading; unpin.isBordered = false
        unpin.font = UIScale.font(10); unpin.contentTintColor = Theme.fgDim
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
    func applicationWillTerminate(_ n: Notification) { persistSession(); lsp.stopAll() }
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
        // 레일 높이에는 인위적인 상한을 두지 않는다 — 아래 탐색기가 사라지지 않을
        // 최소치(120pt)만 남기고 사이드바 거의 전체 높이까지 끌어올릴 수 있다.
        if sv === sidebarSplit && i == 0 { return max(96, sv.bounds.height - 120) }
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
