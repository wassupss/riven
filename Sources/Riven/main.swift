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
    // Re-assert focus on the ACTIVE panel when the app returns to front. The surface can
    // lose ghostty focus while the window is inactive; and the old version only handled
    // TerminalView, so returning while the editor/an aux panel was focused jumped focus to a
    // terminal instead (#2). Route through the active panel so focus returns where it was.
    func windowDidBecomeKey(_ notification: Notification) {
        focusActivePanel()
    }
    var window: NSWindow!
    var rail: WorkspaceRail!
    var explorer: FileTreeView! { workspace.map { explorer(for: $0) } }
    private let explorerHost = NSView()
    func debugExplorerHost() -> NSView { explorerHost }
    var searchPanel: SearchPanel! { workspace.map { search(for: $0) } }
    var gitPanel: GitPanel! { workspace.map { git(for: $0).changes } }
    /// 지금 보고 있는 워크스페이스의 브라우저 (없으면 만든다).
    var previewPanel: PreviewPanel! { workspace.map { preview(for: $0) } }
    var apiPanel: APIClientPanel! { workspace.map { api(for: $0) } }
    var changesPanel: ChangesPanel! { workspace.map { changes(for: $0) } }
    /// 지금 보고 있는 워크스페이스의 메모 패널 (없으면 만든다).
    var notesPanel: NotesPanel! { workspace.map { notes(for: $0) } }
    var teamPanel: AgentGroupPanel! { workspace.map { team(for: $0) } }
    private var chatSeq = 0                  // multi-instance chat panes: one session per pane
    var sourceControl: SourceControlView! { workspace.map { git(for: $0) } }
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
    private var subagentPanels: [String: DockPanel] = [:]  // sub-agent id → its dock panel
    // riven's own tools for the CLI running in TERMINAL panes (the native chat has a per-session
    // server). One app-level instance: these tools act on the app (open a file/panel/workspace,
    // run a request, ask the user), not on a particular chat.
    var terminalToolsForDebug: ChatAskServer? { terminalTools }
    private lazy var terminalTools: ChatAskServer? = {
        guard let srv = ChatAskServer() else { return nil }
        srv.onTool = { [weak self] id, tool, args, cwd in
            DispatchQueue.main.async { self?.handleTerminalTool(id, tool, args, srv, cwd: cwd) }
        }
        return srv
    }()
    // Shown over the dock while a workspace switch finishes. Some of the switch cost is irreducible
    // (the incoming dock's first layout), so tell the user something is happening instead of
    // freezing silently. It only helps if it actually PAINTS, which is why the heavy tail below runs
    // on the next runloop turn.
    static let launchedAt = Date()
    private lazy var switchOverlay: NSView = {
        let v = NSView(); v.wantsLayer = true
        v.layer?.backgroundColor = Theme.bg.withAlphaComponent(0.6).cgColor
        let spin = NSProgressIndicator()
        spin.style = .spinning; spin.controlSize = .small
        spin.translatesAutoresizingMaskIntoConstraints = false
        spin.startAnimation(nil)
        loadingLabel.font = UIScale.font(UIScale.small)
        loadingLabel.textColor = Theme.fgDim
        loadingLabel.alignment = .center
        loadingLabel.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(spin); v.addSubview(loadingLabel)
        NSLayoutConstraint.activate([
            spin.centerXAnchor.constraint(equalTo: v.centerXAnchor),
            spin.centerYAnchor.constraint(equalTo: v.centerYAnchor),
            loadingLabel.centerXAnchor.constraint(equalTo: v.centerXAnchor),
            loadingLabel.topAnchor.constraint(equalTo: spin.bottomAnchor, constant: 10),
        ])
        v.isHidden = true
        return v
    }()
    private func showLoadingOverlay(_ label: String? = nil) {
        loadingLabel.stringValue = label ?? ""
        loadingLabel.isHidden = (label == nil)
        showSwitchOverlay()
    }
    private let loadingLabel = NSTextField(labelWithString: "")
    private func showSwitchOverlay() {
        if switchOverlay.superview !== dockHost {
            switchOverlay.frame = dockHost.bounds
            switchOverlay.autoresizingMask = [.width, .height]
            dockHost.addSubview(switchOverlay, positioned: .above, relativeTo: nil)
        }
        dockHost.addSubview(switchOverlay, positioned: .above, relativeTo: nil)   // keep it on top
        switchOverlay.isHidden = false
        switchOverlay.displayIfNeeded()
    }
    private func hideSwitchOverlay() { switchOverlay.isHidden = true }
    private var lastSubagentPanel: [String: DockPanel] = [:]  // chat pane id → its most recent sub-agent panel
    private var editorVisible = false
    var workspace: URL?
    let lsp = LSPManager.shared

    func applicationDidFinishLaunching(_ n: Notification) {
        // RIVEN_BRDATA=1: 기록·북마크·자동완성 순위가 실제로 쓸 만한지.
        if ProcessInfo.processInfo.environment["RIVEN_BRDATA"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                BrowserStore.debugReset()
                let seed: [(String, String, Int)] = [
                    ("https://github.com/wassupss/riven", "riven", 30),
                    ("https://github.com/features/actions", "GitHub Actions", 2),
                    ("https://news.ycombinator.com", "Hacker News", 12),
                    ("https://developer.apple.com/documentation/appkit", "AppKit", 5),
                ]
                for (u, title, n) in seed {
                    for _ in 0..<n { BrowserStore.recordVisit(url: URL(string: u), title: title, isPrivate: false) }
                }
                BrowserStore.recordVisit(url: URL(string: "https://secret.example.com"), title: "몰래", isPrivate: true)
                BrowserStore.toggleBookmark(url: URL(string: "https://vercel.com/dashboard"), title: "Vercel")
                for q in ["git", "riven", "hacker", "vercel", "점심 메뉴"] {
                    let r = BrowserStore.suggest(q, openTabs: [("AppKit 문서", "https://developer.apple.com/documentation/appkit")])
                    let shown = r.prefix(3).map { "\($0.kind)/\($0.title)" }.joined(separator: " | ")
                    RLog.log("BRDATA \"\(q)\" → \(shown)")
                }
                let c = BrowserStore.debugCounts
                RLog.log("BRDATA 기록=\(c.history)건(시크릿 제외 4 기대) 북마크=\(c.bookmarks)건")
                RLog.log("BRDATA 북마크확인=\(BrowserStore.isBookmarked(URL(string: "https://vercel.com/dashboard")))")
            }
        }
        installCrashHandler()
        CrashReporter.reportPending()   // upload the previous run's crash (if any), then clear it
        maybeShowCrashReportingNotice()   // one-time opt-out disclosure
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
            SupabaseAuth.shared.flushOnQuit()
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
        if ProcessInfo.processInfo.environment["RIVEN_BOOTTIME"] != nil {
            RLog.log(String(format: "BOOT 창표시 %.0fms", Date().timeIntervalSince(AppDelegate.launchedAt) * 1000))
        }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        buildMenu()
        installKeybindings()
        startUsagePolling()
        Notifications.requestAuthorization()
        Notifications.onOpen = { [weak self] ws, panelId in self?.revealPane(wsPath: ws, panelId: panelId) }
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
        // Surface a found update as a clickable status-bar pill; clicking runs the check so
        // Sparkle presents its install flow. Restore the pill if one was already found.
        Updater.shared.onUpdateFound = { [weak self] version in self?.statusBar.setUpdateAvailable(version) }
        statusBar.onUpdate = { Updater.shared.checkForUpdates(nil) }
        Updater.shared.start()
        if let v = Updater.shared.availableVersion { statusBar.setUpdateAvailable(v) }
        // Probe the feed silently ~4s after launch so the update pill appears on its own,
        // without waiting for Sparkle's 24h scheduled check or a manual "Check for Updates".
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { Updater.shared.probeForUpdate() }
        // Debug/demo: force-show the update pill (real builds surface it only when Sparkle
        // finds a newer version on the feed — a dev/test build has no feed, so it never shows).
        if let fake = ProcessInfo.processInfo.environment["RIVEN_FAKE_UPDATE"] { statusBar.setUpdateAvailable(fake) }
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
            // RIVEN_TEAMLIVE=1: 채팅 입력창의 @동료 → 병렬 위임 → 조직도의 흐르는 선 / 상태 칩까지
            // 한 번에 훑는다. 애니메이션 타이머가 일이 있을 때만 돌고 끝나면 스스로 멈추는지도 본다.
            if ProcessInfo.processInfo.environment["RIVEN_TEAMLIVE"] != nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    guard let self else { return }
                    self.createAgentGroup("배포팀", [
                        (name: "리드", agent: nil, model: nil, parent: nil),
                        (name: "구현", agent: nil, model: "sonnet", parent: 0),
                        (name: "리뷰", agent: nil, model: "haiku", parent: 0),
                    ])
                    if self.auxDockPanels["team"] == nil { self.toggleDockPanel("team") }
                    self.teamPanel.show(group: "배포팀")
                    let lead: () -> ChatPanel? = { [weak self] in
                        self?.agentPanes().first { $0.chat.groupName == "배포팀" && $0.chat.parentName == nil }?.chat
                    }
                    let log: (String) -> Void = { [weak self] tag in
                        guard let self else { return }
                        RLog.log("LIVE \(tag) "
                               + "ticker=\(self.teamPanel.debugTickerRunning()) "
                               + "flows=\(self.teamPanel.debugFlowCount()) "
                               + "states=[\(self.teamPanel.debugStates())] "
                               + self.teamPanel.debugVisibility())
                    }
                    // RIVEN_MENTIONBENCH=1: 팝업·색칠·스킬 목록을 클릭 없이 확인한다 (토큰 안 씀).
                    if ProcessInfo.processInfo.environment["RIVEN_MENTIONBENCH"] != nil {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            guard let l = lead() else { RLog.log("MENTION no lead"); return }
                            RLog.log("MENTION cmds " + l.debugCommands())
                            for probe in ["@", "@구", "@리", "@없", "/", "/backup", "/deploy-check", "/nope", "/exam"] {
                                l.debugType(probe)
                                RLog.log("MENTION type=\(probe) popup=\(l.debugPopup()) spans=[\(l.debugSpans())]")
                            }
                            // 팝업에서 고르면 토큰 자리만 바뀌어야 한다 (문장 중간에서도).
                            l.debugType("이거 @구")
                            l.debugAcceptPopup()
                            RLog.log("MENTION accepted=\(l.debugInput()) spans=[\(l.debugSpans())]")
                            l.debugType("@구현 @리뷰 확인해 줘")
                            RLog.log("MENTION multi spans=[\(l.debugSpans())]")
                            // RIVEN_MENTIONSHOT=<path>: 팝업과 색칠을 눈으로 확인한다.
                            if let shot = ProcessInfo.processInfo.environment["RIVEN_MENTIONSHOT"] {
                                let snap: (String, NSView) -> Void = { tag, v in
                                    guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                                    v.cacheDisplay(in: v.bounds, to: rep)
                                    if let d = rep.representation(using: .png, properties: [:]) {
                                        try? d.write(to: URL(fileURLWithPath: "\(shot)-\(tag).png"))
                                    }
                                }
                                l.debugType("이 diff 를 @")
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                                    snap("popup", l)
                                    l.debugType("@구현 @리뷰 /backup 확인해 줘")
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                                        snap("tokens", l)
                                        snap("team", self.teamPanel)
                                    }
                                }
                                return
                            }
                            l.debugType("")
                            // 그룹이 아닌 팬에서는 @ 가 아무 뜻이 없어야 한다.
                            self.newChat()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                guard let solo = self.agentPanes().first(where: { $0.chat.groupName == nil })?.chat
                                else { RLog.log("MENTION solo (none open)"); return }
                                solo.debugType("@구현 테스트")
                                RLog.log("MENTION solo popup=\(solo.debugPopup()) spans=[\(solo.debugSpans())]")
                            }
                        }
                        return
                    }
                    // RIVEN_TEAMSHOT=<path>: 진행 중 / 완료 직후의 조직도를 그대로 떠서 눈으로
                    // 확인한다. 합성 위임이라 토큰을 쓰지 않고, 실제 렌더 경로는 똑같이 탄다.
                    if let shot = ProcessInfo.processInfo.environment["RIVEN_TEAMSHOT"] {
                        let snap: (String) -> Void = { [weak self] tag in
                            guard let self, let v = self.teamPanel,
                                  let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                            v.cacheDisplay(in: v.bounds, to: rep)
                            if let d = rep.representation(using: .png, properties: [:]) {
                                try? d.write(to: URL(fileURLWithPath: "\(shot)-\(tag).png"))
                            }
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                            let a = self.teamPanel.beginFlow(group: "배포팀", from: "리드", to: "구현",
                                                             summary: "로그 파서 리팩터링")
                            let b = self.teamPanel.beginFlow(group: "배포팀", from: nil, to: "리뷰",
                                                             summary: "이 diff 확인")
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { snap("live") }
                            // 애니메이션이 도는 동안 CPU 를 재려고 넉넉히 살려 둔다.
                            let hold = ProcessInfo.processInfo.environment["RIVEN_TEAMHOLD"]
                                .flatMap(Double.init) ?? 12.0
                            DispatchQueue.main.asyncAfter(deadline: .now() + hold) {
                                self.teamPanel.endFlow(a, ok: true)
                                self.teamPanel.endFlow(b, ok: false)
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { snap("done") }
                            }
                        }
                        return
                    }
                    // RIVEN_TEAMCYCLE=1: 위임 애니메이션을 15초 켜고 15초 끄기를 반복한다.
                    // 앱의 다른 주기 작업(사용량 폴링 등)이 섞여도 켠 구간과 끈 구간의 차이로
                    // 애니메이션 자체의 비용만 뽑아낼 수 있다.
                    if ProcessInfo.processInfo.environment["RIVEN_TEAMCYCLE"] != nil {
                        func cycle(_ n: Int) {
                            guard n < 8 else { RLog.log("CYCLE end"); return }
                            RLog.log("CYCLE \(n) on")
                            let a = self.teamPanel.beginFlow(group: "배포팀", from: "리드", to: "구현",
                                                             summary: "로그 파서 리팩터링")
                            let b = self.teamPanel.beginFlow(group: "배포팀", from: "리드", to: "리뷰",
                                                             summary: "이 diff 확인")
                            DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
                                self.teamPanel.endFlow(a, ok: true); self.teamPanel.endFlow(b, ok: true)
                                RLog.log("CYCLE \(n) off ticker=\(self.teamPanel.debugTickerRunning())")
                                DispatchQueue.main.asyncAfter(deadline: .now() + 15) { cycle(n + 1) }
                            }
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { cycle(0) }
                        return
                    }
                    // RIVEN_TEAMTOOL=1: 도구 실행 → 승인 대기까지 상태 칩이 따라오는지.
                    // 승인 카드는 일부러 누르지 않는다 (그 상태로 멈춰 있는 걸 봐야 한다).
                    if ProcessInfo.processInfo.environment["RIVEN_TEAMTOOL"] != nil {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                            self.mentionFromLead("@구현 readme.md 파일 끝에 test 한 줄만 추가해.")
                            for i in 0..<20 {
                                DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 2) { log("tool\(i)") }
                            }
                        }
                        return
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        log("idle")      // 아무 일도 없으면 타이머는 꺼져 있어야 한다
                        // 팀 입력줄로 두 명에게 동시에 — 실제 UI 경로(파싱 → askAgentPanes)를 탄다.
                        self.mentionFromLead("@구현 @리뷰 숫자 7만 답해. 설명 금지.")
                        log("sent")
                        for (i, at) in [0.4, 1.5, 4.0, 8.0, 16.0, 30.0].enumerated() {
                            DispatchQueue.main.asyncAfter(deadline: .now() + at) { log("t\(i)@\(at)s") }
                        }
                        // 보낸 쪽 대화에 "→ 누구에게 / ← 도착" 이 남는지 눈으로 확인.
                        if let shot = ProcessInfo.processInfo.environment["RIVEN_MENTIONSHOT"] {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 9) {
                                guard let v = lead(), let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds)
                                else { return }
                                v.cacheDisplay(in: v.bounds, to: rep)
                                if let d = rep.representation(using: .png, properties: [:]) {
                                    try? d.write(to: URL(fileURLWithPath: "\(shot)-sender.png"))
                                }
                            }
                        }
                        // 잘못된 이름은 보내지 않고 이유를 말해야 한다.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 34) {
                            self.mentionFromLead("@없는사람 테스트")   // 동료가 아니면 평범한 메시지다
                            log("badname")
                        }
                    }
                }
            }
                // RIVEN_NOTETEST=<png>: 메모 한 바퀴. 예전 JSON 이 .md 로 이사됐는지, 목록·편집·
                // 미리보기가 그려지는지, riven_note_* 도구가 에이전트가 부르는 그 경로 그대로
                // 도는지(만들기 → 이어붙이기 → 덮어쓰기 → 워크스페이스 파일로 저장)를 한 번에 본다.
                if let shot = ProcessInfo.processInfo.environment["RIVEN_NOTETEST"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                        RLog.log("NOTE hook fired ws=\(self?.workspace?.path ?? "-")")
                        guard let self, let ws = self.workspace else { return }
                        if self.auxDockPanels["notes"] == nil { self.toggleDockPanel("notes") }
                        self.notesPanel.setWorkspace(ws)
                        NSApp.activate(ignoringOtherApps: true)
                        self.window.makeKeyAndOrderFront(nil)
                        RLog.log("NOTE migrated=" + NoteStore.personal(ws).map { $0.url.lastPathComponent }
                            .joined(separator: ","))
                        // 에이전트가 쓰는 그 함수를 그대로 호출한다.
                        RLog.log("NOTE write=" + self.runNoteTool("riven_note_write",
                            ["title": "배포 체크리스트",
                             "body": "## 준비\n\n- [x] 빌드\n- [ ] 노터라이즈\n\n| 단계 | 상태 |\n|---|---|\n| 태그 | 대기 |\n\n```sh\nswift build\n```"]))
                        RLog.log("NOTE append=" + self.runNoteTool("riven_note_append",
                            ["note": "배포 체크리스트", "body": "\n추가된 줄."]))
                        RLog.log("NOTE list=\n" + self.runNoteTool("riven_note_list", [:]))
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                            self.notesPanel.open(NoteStore.find("배포 체크리스트", ws: ws)!.url)
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                                self.debugWindowSnapshot(to: shot)                 // 편집 화면
                                self.notesPanel.debugSetPreview(true)
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                                    self.debugWindowSnapshot(to: shot.replacingOccurrences(
                                        of: ".png", with: "-preview.png"))         // 미리보기
                                    RLog.log("NOTE overwrite=" + self.runNoteTool("riven_note_write",
                                        ["note": "배포 체크리스트", "title": "배포 체크리스트",
                                         "body": "에이전트가 통째로 갈아끼운 내용."]))
                                    RLog.log("NOTE backup=\(NoteStore.hasBackup(NoteStore.find("배포 체크리스트", ws: ws)!.url))")
                                    RLog.log("NOTE savefile=" + self.runNoteTool("riven_note_save_file",
                                        ["note": "배포 체크리스트", "path": "docs/plan.md"]))
                                    RLog.log("NOTE savefile2=" + self.runNoteTool("riven_note_save_file",
                                        ["note": "배포 체크리스트", "path": "docs/plan.md"]))
                                    RLog.log("NOTE escape=" + self.runNoteTool("riven_note_save_file",
                                        ["note": "배포 체크리스트", "path": "../escaped.md"]))
                                    RLog.log("NOTE read=" + self.runNoteTool("riven_note_read",
                                        ["note": "배포 체크리스트"]).prefix(40))
                                    // 목록(메모 탭 → 문서 탭)도 한 장씩. 에이전트가 쓴 메모에
                                    // 점이 찍혔는지, 워크스페이스 .md 가 문서 탭에 뜨는지 본다.
                                    self.notesPanel.debugShowList()
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                                        self.debugWindowSnapshot(to: shot.replacingOccurrences(
                                            of: ".png", with: "-list.png"))
                                        self.notesPanel.debugShowList(docs: true)
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                                            self.debugWindowSnapshot(to: shot.replacingOccurrences(
                                                of: ".png", with: "-docs.png"))
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // RIVEN_STATUSSHOT=<path>: 상태 언어를 한 화면에 세워 놓고 창을 통째로 떠서
                // 눈으로 대조한다 — 독 탭 제목 shimmer(작업 중) / 상태 점(승인 대기·완료) /
                // 레일 행 / 조직도 아바타가 서로 같은 색·의미인지. 상태를 합성해서 넣는 것이라
                // 에이전트를 돌리지 않는다(토큰 0). 창 자체를 컴포지터에서 뜨므로 애니메이션이
                // 실제로 걸려 있는지도 그림에 남는다.
                if let shot = ProcessInfo.processInfo.environment["RIVEN_STATUSSHOT"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        self.createAgentGroup("배포팀", [
                            (name: "리드", agent: nil, model: nil, parent: nil),
                            (name: "구현", agent: nil, model: "sonnet", parent: 0),
                            (name: "리뷰", agent: nil, model: "haiku", parent: 0),
                        ])
                        if self.auxDockPanels["team"] == nil { self.toggleDockPanel("team") }
                        self.teamPanel.show(group: "배포팀")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            // 창이 가려져 있으면 게이트가 애니메이션을 꺼 버려서(의도된 동작)
                            // 검증 자체가 안 된다. 확인용으로 앞으로 세운다.
                            NSApp.activate(ignoringOtherApps: true)
                            self.window.makeKeyAndOrderFront(nil)
                            // 팬마다 다른 상태를 심는다: 작업 중 / 승인 대기 / 완료.
                            let seq: [AgentStatus] = [.busy, .waiting, .done]
                            for (i, pane) in self.agentPanes().enumerated() {
                                pane.panel.status = seq[i % seq.count]
                            }
                            self.refreshDockTabs(); self.refreshRailAgents()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                RLog.log("STATUSSHOT panes=\(self.agentPanes().count) "
                                       + "live=\(ViewAnimationGate.liveCount)")
                                self.debugWindowSnapshot(to: shot)
                                // 0.45초 뒤 한 장 더 — 두 장의 같은 자리를 비교하면 제목이
                                // 정말 훑리고 있는지(정지 화면이 아닌지) 숫자로 확인된다.
                                // 렌더 트리 값도 같이 남겨서 "애니메이션은 도는데 캡처에만
                                // 안 잡히는" 경우와 구분한다.
                                for (i, at) in [0.0, 0.45].enumerated() {
                                    DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                                        let tabs = self.activeDock?.groups
                                            .map { $0.tabBar.debugStatusReport() }
                                            .filter { !$0.isEmpty }.joined(separator: "  ||  ") ?? ""
                                        RLog.log("STATUSANIM t\(i) live=\(ViewAnimationGate.liveCount) \(tabs)")
                                        if i == 1 {
                                            self.debugWindowSnapshot(to: shot.replacingOccurrences(
                                                of: ".png", with: "-b.png"))
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // RIVEN_BROWSEREVAL=1: eval 은 승인 카드를 거쳐야 한다 (자동 승인되면 안 된다).
                // 카드를 일부러 누르지 않고, 15초 뒤에도 실행되지 않았는지 확인한다.
                if ProcessInfo.processInfo.environment["RIVEN_BROWSEREVAL"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                        guard let self else { return }
                        if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                        _ = self.previewPanel.agentNavigate("http://localhost:8731/index.html", newTab: false)
                        self.newChat()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                            guard let chat = self.agentPanes().first?.chat else { RLog.log("EVAL no chat"); return }
                            chat.ask("riven_browser_eval 로 자바스크립트 `return document.title;` 를 실행하고 결과만 답해.") { a in
                                RLog.log("EVAL answer → " + a.replacingOccurrences(of: "\n", with: " | ").prefix(200))
                            }
                            for at in [8.0, 15.0] {
                                DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                                    RLog.log("EVAL t\(Int(at)) busy=\(chat.isBusy) panelLog=[\(self.previewPanel.debugAgentLog())]")
                                }
                            }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 16) { RLog.log("EVAL done") }
                        }
                    }
                }
                // RIVEN_BROWSERAGENT=1: MCP 경로 전체(도구 정의 → ChatAskServer → 패널)를
                // 실제 에이전트 턴으로 확인한다.
                if ProcessInfo.processInfo.environment["RIVEN_BROWSERAGENT"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                        guard let self else { return }
                        self.newChat()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                            guard let chat = self.agentPanes().first?.chat else { RLog.log("AGENT no chat"); return }
                            let ask = "riven_browser_open 으로 http://localhost:8731/index.html 을 열고, "
                                    + "riven_browser_read 로 selector '#para' 를 읽어서 그 텍스트만 그대로 답해. "
                                    + "그 다음 riven_browser_click 으로 '#btn' 을 누르고 riven_browser_read 로 "
                                    + "'#clicked' 를 읽어 마지막 줄에 적어. 설명은 최소로."
                            chat.ask(ask) { answer in
                                RLog.log("AGENT answer → " + answer.replacingOccurrences(of: "\n", with: " | ").prefix(400))
                                RLog.log("AGENT done")
                            }
                        }
                    }
                }
                // RIVEN_PROFILE=<url>: 프로필이 로그인(쿠키)을 정말로 갈라 놓는지.
                if let base = ProcessInfo.processInfo.environment["RIVEN_PROFILE"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self else { return }
                        if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                        let p = self.previewPanel!
                        func at(_ d: Double, _ b: @escaping () -> Void) {
                            DispatchQueue.main.asyncAfter(deadline: .now() + d, execute: b)
                        }
                        _ = p.agentNavigate(base, newTab: false)                       // 기본 계정: 쿠키 발급
                        at(2.5) { _ = p.agentGo("reload") }                            // 다시 오면 같은 쿠키여야
                        at(5) { p.debugEval("return document.body.innerText;") { r in
                            RLog.log("PROFILE 기본(재방문)=\(r.trimmingCharacters(in: .whitespacesAndNewlines))") } }
                        at(6) { _ = p.agentNavigate(base, newTab: true, profile: "A") } // 계정 A: 새 쿠키여야
                        at(8.5) { _ = p.agentGo("reload") }
                        at(11) { p.debugEval("return document.body.innerText;") { r in
                            RLog.log("PROFILE A(재방문)=\(r.trimmingCharacters(in: .whitespacesAndNewlines))") } }
                        at(12) { RLog.log("PROFILE 상태\n" + p.agentState()) ; RLog.log("PROFILE done") }
                    }
                }
                // RIVEN_PROFILE2=1: 재기동 뒤 복원된 탭이 각자 계정을 유지하는지.
                if ProcessInfo.processInfo.environment["RIVEN_PROFILE2"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self else { return }
                        if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                        let p = self.previewPanel!
                        func at(_ d: Double, _ b: @escaping () -> Void) {
                            DispatchQueue.main.asyncAfter(deadline: .now() + d, execute: b)
                        }
                        at(3) { RLog.log("PROFILE 복원상태\n" + p.agentState()) }
                        at(4) { _ = p.agentTab("select", index: 0) }
                        at(6) { p.debugEval("return document.body.innerText;") { r in
                            RLog.log("PROFILE 복원 기본=\(r.trimmingCharacters(in: .whitespacesAndNewlines))") } }
                        at(7) { _ = p.agentTab("select", index: 1) }
                        at(9) { p.debugEval("return document.body.innerText;") { r in
                            RLog.log("PROFILE 복원 A=\(r.trimmingCharacters(in: .whitespacesAndNewlines))")
                            RLog.log("PROFILE done") } }
                    }
                }
                // RIVEN_CWDSCOPE=1: 터미널 CLI 가 부른 riven 도구가 그 CLI 의 폴더가 속한
                // 워크스페이스에서 처리되는지 (보고 있는 워크스페이스가 아니라).
                if ProcessInfo.processInfo.environment["RIVEN_CWDSCOPE"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                        guard let self else { return }
                        // 벤치용 두 번째 워크스페이스를 연다 (RIVEN_OPEN 은 하나만 준다).
                        if let extra = ProcessInfo.processInfo.environment["RIVEN_CWDSCOPE2"] {
                            self.activate(URL(fileURLWithPath: extra))
                        }
                        let other = self.workspaces.first { $0 != self.workspace }
                        if let other { self.activate(other) }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                            if let first = self.workspaces.first { self.activate(first) }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                                RLog.log("CWD 워크스페이스들=\(self.workspaces.map { $0.lastPathComponent })")
                                guard let there = self.workspaces.first(where: { $0 != self.workspace }) else {
                                    RLog.log("CWD 다른 워크스페이스 없음"); return
                                }
                                guard let srv = self.terminalToolsForDebug else {
                                    RLog.log("CWD 터미널 도구 서버 없음"); return
                                }
                                RLog.log("CWD 보고있는곳=\(self.workspace?.lastPathComponent ?? "?")")
                                // 다른 워크스페이스의 하위 폴더에서 부른 것처럼 흉내낸다.
                                let sub = there.appendingPathComponent("sub").path
                                try? FileManager.default.createDirectory(atPath: sub, withIntermediateDirectories: true)
                                RLog.log("CWD 매칭=\(self.workspaceContaining(sub)?.lastPathComponent ?? "없음") (하위폴더로 찾기)")
                                srv.debugTool(tool: "riven_open_browser", args: ["url": "https://example.com"], cwd: sub)
                                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                    RLog.log("CWD 저쪽 브라우저=\(self.state(for: there).preview?.debugURL() ?? "(없음)")")
                                    RLog.log("CWD 이쪽 브라우저=\(self.workspace.flatMap { self.state(for: $0).preview?.debugURL() } ?? "(없음)")")
                                    // 탭 도구
                                    if let ws = self.workspace {
                                        self.ensureAux("preview", in: ws)
                                        let p = self.preview(for: ws)
                                        _ = p.agentNavigate("https://example.org", newTab: false)
                                        _ = p.agentNavigate("https://developer.apple.com", newTab: true)
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                            RLog.log("CWD 탭선택=\(p.agentTab("select", index: 0))")
                                            RLog.log("CWD 탭닫기=\(p.agentTab("close", index: 1))")
                                            RLog.log("CWD 마지막탭닫기=\(p.agentTab("close", index: 0))")
                                            RLog.log("CWD done")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // RIVEN_GHOSTTY=1: ghostty 설정 읽기·적용이 실제로 되는지.
                if ProcessInfo.processInfo.environment["RIVEN_GHOSTTY"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        for p in GhosttyImport.candidatePaths {
                            let exists = FileManager.default.fileExists(atPath: p.path)
                            let size = ((try? FileManager.default.attributesOfItem(atPath: p.path))?[.size] as? Int) ?? -1
                            RLog.log("GH 후보: \(exists ? "있음(\(size)B)" : "없음  ") \(p.path)")
                        }
                        guard let f = GhosttyImport.read() else { RLog.log("GH 설정 파일 없음"); return }
                        RLog.log("GH 찾음: \(f.path.path)")
                        RLog.log("GH 읽은 값: 글꼴=\(f.fontFamily ?? "-") 크기=\(f.fontSize.map(String.init) ?? "-")"
                                 + " 테마=\(f.theme ?? "-") 배경=\(f.background ?? "-")")
                        RLog.log("GH 요약: \(f.summary)")
                        RLog.log("GH 적용: \(GhosttyImport.apply(f))")
                        RLog.log("GH 적용 후 설정: 글꼴=\(Settings.shared.string("terminalFontFamily", "-"))"
                                 + " 크기=\(Settings.shared.int("terminalFontSize", 0))")
                        RLog.log("GH 터미널 설정줄: \(GhosttyApp.fontFamilyLine)")
                        RLog.log("GH done")
                    }
                }
                // RIVEN_INSPSURFACE=<url>: 인스펙터를 패널 안에 붙일 수 있는지 확인.
                if let target = ProcessInfo.processInfo.environment["RIVEN_INSPSURFACE"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self, let ws = self.workspace else { return }
                        self.ensureAux("preview", in: ws)
                        let p = self.preview(for: ws)
                        _ = p.agentNavigate(target, newTab: false)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                            p.debugOpenDevTools()
                            RLog.log("INSP 열기 시도 → " + p.debugInspectorState())
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                RLog.log("INSP 3초 뒤 " + p.debugConsoleState())
                                if let shot = ProcessInfo.processInfo.environment["RIVEN_INSPSHOT"],
                                   let rep = p.bitmapImageRepForCachingDisplay(in: p.bounds) {
                                    p.cacheDisplay(in: p.bounds, to: rep)
                                    if let d = rep.representation(using: .png, properties: [:]) {
                                        try? d.write(to: URL(fileURLWithPath: shot))
                                    }
                                }
                            }
                            RLog.log("INSP done")
                        }
                    }
                }
                // RIVEN_CHATSHOT=<png>: 채팅 팬을 실제 대화로 채우고 그 모습을 찍는다.
                // 답을 기다리지 않고 정해진 시각에 찍는다 — 스트리밍 중간 모습도 봐야 한다.
                if let shot = ProcessInfo.processInfo.environment["RIVEN_CHATSHOT"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        self.newChat()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            guard let pane = self.agentPanes().first else { RLog.log("CHATSHOT 팬 없음"); return }
                            RLog.log("CHATSHOT 팬 준비됨")
                            pane.chat.ask("riven 브라우저의 탭 복원 방식을 세 줄로 설명하고, "
                                          + "작은 표 하나와 짧은 swift 코드 블록을 포함해 줘.") { _ in }
                            for (i, at) in [12.0, 30.0, 50.0].enumerated() {
                                DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                                    let v = pane.chat
                                    guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                                    v.cacheDisplay(in: v.bounds, to: rep)
                                    let path = i == 0 ? shot : shot.replacingOccurrences(of: ".png", with: "-\(i).png")
                                    if let d = rep.representation(using: .png, properties: [:]) {
                                        try? d.write(to: URL(fileURLWithPath: path))
                                    }
                                    RLog.log("CHATSHOT \(Int(at))초 → \(path) (\(Int(v.bounds.width))x\(Int(v.bounds.height)))")
                                }
                            }
                        }
                    }
                }
                // RIVEN_SEARCH=<질의>: 주소창에 검색어를 쳤을 때 어디로 가는지.
                if let q = ProcessInfo.processInfo.environment["RIVEN_SEARCH"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self, let ws = self.workspace else { return }
                        self.ensureAux("preview", in: ws)
                        let p = self.preview(for: ws)
                        RLog.log("SEARCH 해석: \(q) → \(BrowserTab.resolve(q)?.absoluteString ?? "실패")")
                        RLog.log("SEARCH 자동완성 마지막줄: \(BrowserStore.suggest(q).last.map { "\($0.kind) \($0.url)" } ?? "없음")")
                        _ = p.agentNavigate(q, newTab: false)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                            RLog.log("SEARCH 실제 이동: \(p.debugURL())")
                            RLog.log("SEARCH done")
                        }
                    }
                }
                // RIVEN_CONBENCH=<url>: 콘솔 서랍이 열린 뒤 상태가 흔들리는지 (비었다/깜빡인다).
                if let target = ProcessInfo.processInfo.environment["RIVEN_CONBENCH"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self, let ws = self.workspace else { return }
                        self.ensureAux("preview", in: ws)
                        let p = self.preview(for: ws)
                        _ = p.agentNavigate(target, newTab: false)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                            p.debugToggleConsole(true)
                            for at in [0.2, 1.0, 2.0, 3.0, 5.0, 8.0] {
                                DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                                    RLog.log("CON +\(at)초 " + p.debugConsoleState())
                                }
                            }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 9) { RLog.log("CON done") }
                        }
                    }
                }
                // RIVEN_GITSHOT=<png>: 소스 컨트롤 패널 현재 모습.
                if let shot = ProcessInfo.processInfo.environment["RIVEN_GITSHOT"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self, let ws = self.workspace else { return }
                        self.ensureAux("git", in: ws)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                            let v = self.git(for: ws)
                            guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                            v.cacheDisplay(in: v.bounds, to: rep)
                            if let d = rep.representation(using: .png, properties: [:]) {
                                try? d.write(to: URL(fileURLWithPath: shot))
                            }
                            RLog.log("GITSHOT done \(Int(v.bounds.width))x\(Int(v.bounds.height))")
                            RLog.log("GITSHOT 변경사항=\(Int(v.changes.frame.minY))~\(Int(v.changes.frame.maxY))"
                                     + " 그래프=\(Int(v.graph.frame.minY))~\(Int(v.graph.frame.maxY))")
                            RLog.log("GITSHOT 그래프안: " + v.graph.debugFrames())
                        }
                    }
                }
                // RIVEN_DEVTOOLS=<url>: 콘솔이 페이지 출력·오류를 잡고, 그 페이지에서 코드를
                // 실행하고, 캐시 지우기·강제 새로고침이 도는지.
                if let target = ProcessInfo.processInfo.environment["RIVEN_DEVTOOLS"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self, let ws = self.workspace else { return }
                        self.ensureAux("preview", in: ws)
                        let p = self.preview(for: ws)
                        p.debugToggleConsole(true)
                        _ = p.agentNavigate(target, newTab: false)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                            let lines = p.debugConsole().debugLines()
                            RLog.log("DEV 콘솔 \(lines.count)줄")
                            for l in lines.prefix(8) { RLog.log("DEV   | " + l.replacingOccurrences(of: "\n", with: " ").prefix(90)) }
                            p.debugConsole().debugRun("window.__mark + 1")
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                let after = p.debugConsole().debugLines()
                                RLog.log("DEV 실행 결과=\(after.suffix(2).joined(separator: " / "))")
                                p.hardReload()
                                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                    RLog.log("DEV 강제 새로고침 뒤 콘솔=\(p.debugConsole().debugLines().count)줄")
                                    p.clearCache()
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                        if let shot = ProcessInfo.processInfo.environment["RIVEN_DEVSHOT"],
                                           let rep = p.bitmapImageRepForCachingDisplay(in: p.bounds) {
                                            p.cacheDisplay(in: p.bounds, to: rep)
                                            if let d = rep.representation(using: .png, properties: [:]) {
                                                try? d.write(to: URL(fileURLWithPath: shot))
                                            }
                                        }
                                        RLog.log("DEV done")
                                    }
                                }
                            }
                        }
                    }
                }
                // RIVEN_CLOSEW=1: ⌘W 가 탭을 닫고, 마지막 탭이면 패널까지 닫는지.
                if ProcessInfo.processInfo.environment["RIVEN_CLOSEW"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self, let ws = self.workspace else { return }
                        self.ensureAux("preview", in: ws)
                        let p = self.preview(for: ws)
                        _ = p.agentNavigate("https://example.com", newTab: false)
                        _ = p.agentNavigate("https://example.org", newTab: true)
                        func open() -> Bool { self.states[ws]?.auxPanels["preview"] != nil }
                        func focusBrowser() {
                            guard let panel = self.states[ws]?.auxPanels["preview"], let g = panel.group else { return }
                            g.select(id: panel.id); self.states[ws]?.dock?.setActive(g)
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                            focusBrowser()
                            RLog.log("CLOSEW 시작 탭=\(p.debugTabURLs().count)개 패널열림=\(open()) 활성=\(self.states[ws]?.dock?.activeGroup?.activePanel?.id ?? "-")")
                            self.debugCloseTabMenu()   // 실제 ⌘W 메뉴 경로
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                                RLog.log("CLOSEW ⌘W 1회 → 탭=\(p.debugTabURLs().count)개 패널열림=\(open())")
                                self.debugCloseTabMenu()
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                    RLog.log("CLOSEW ⌘W 2회(마지막 탭) → 패널열림=\(open()) (거짓이어야 정상)")
                                    // 다시 열면 마지막 주소가 살아 있어야 한다.
                                    self.ensureAux("preview", in: ws)
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                        RLog.log("CLOSEW 다시 열기 → 탭=\(self.preview(for: ws).debugTabURLs())")
                                        RLog.log("CLOSEW done")
                                    }
                                }
                            }
                        }
                    }
                }
                // RIVEN_SUBBENCH=1: 서브에이전트가 도구를 돌린 뒤 그 팬에 결과가 오는지.
                if ProcessInfo.processInfo.environment["RIVEN_SUBBENCH"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        self.newChat()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            guard let chat = self.agentPanes().first?.chat else { RLog.log("SUB 팬 없음"); return }
                            chat.ask("Task 도구로 general-purpose 서브에이전트를 하나 띄워서, "
                                     + "Bash 로 `echo hello-riven-sub` 를 실행하고 그 출력만 그대로 보고하게 해. "
                                     + "너는 서브에이전트가 보고한 문자열만 한 줄로 답해.") { answer in
                                RLog.log("SUB 메인 답=\(answer.replacingOccurrences(of: "\n", with: " ").prefix(120))")
                                RLog.log("SUB done")
                            }
                        }
                    }
                }
                // RIVEN_SYMLINK=<경로>: 심볼릭 링크로 걸린 폴더가 탐색기에서 폴더로 보이고
                // 안까지 읽히는지 (.claude/skills 를 공용 폴더로 링크해 둔 구성).
                if let target = ProcessInfo.processInfo.environment["RIVEN_SYMLINK"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self, let ws = self.workspace else { return }
                        let ex = self.explorer(for: ws)
                        let root = FileNode.make(URL(fileURLWithPath: target))
                        RLog.log("SYM 대상=\(target) 폴더로 인식=\(root.isDir) 링크=\(root.isLink)")
                        let kids = root.loadChildren()
                        RLog.log("SYM 안의 항목 \(kids.count)개: " + kids.prefix(6).map {
                            "\($0.name)\($0.isDir ? "/" : "")\($0.isLink ? "(링크)" : "")"
                        }.joined(separator: ", "))
                        // 링크된 하위 폴더도 열리는지
                        if let linked = kids.first(where: { $0.isLink && $0.isDir }) {
                            let inner = linked.loadChildren()
                            RLog.log("SYM 링크폴더 '\(linked.name)' 안 \(inner.count)개: "
                                     + inner.prefix(5).map { $0.name }.joined(separator: ", "))
                        } else {
                            RLog.log("SYM 링크된 하위 폴더 없음")
                        }
                        _ = ex
                        RLog.log("SYM done")
                    }
                }
                // RIVEN_CHIPBENCH=1: 그룹 조직도의 상태 칩이 실제로 따라오는지.
                if ProcessInfo.processInfo.environment["RIVEN_CHIPBENCH"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        self.createAgentGroup("상태팀", [(name: "리드", agent: nil, model: nil, parent: nil),
                                                        (name: "멤버1", agent: nil, model: nil, parent: 0)])
                        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                            if self.auxDockPanels["team"] == nil { self.toggleDockPanel("team") }
                            guard let ws = self.workspace else { return }
                            let team = self.team(for: ws)
                            team.show(group: "상태팀")
                            guard let member = self.agentPanes().first(where: { $0.chat.agentRole == "멤버1" })
                            else { RLog.log("CHIP 멤버 없음"); return }
                            func snap(_ l: String) {
                                RLog.log("CHIP \(l): 팬=\(member.chat.runState) 칩=[\(team.debugStates())] 타이머=\(team.debugTickerRunning())")
                            }
                            snap("시작 전")
                            member.chat.ask("1부터 5까지 세어. 다른 말 금지.") { _ in }
                            for (i, at) in [0.5, 2.0, 4.0, 8.0, 14.0].enumerated() {
                                DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                                    snap("샘플 \(i + 1)")
                                    if i == 4 { RLog.log("CHIP done") }
                                }
                            }
                        }
                    }
                }
                // RIVEN_STATEBENCH=1: 에이전트가 도는 동안 상태가 세 곳(팬·독 탭·레일)에
                // 제때 반영되는지. "돌고 있는데 안 도는 것처럼 보인다" 를 쫓기 위한 것.
                if ProcessInfo.processInfo.environment["RIVEN_STATEBENCH"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        self.newChat()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            guard let ws = self.workspace,
                                  let pane = self.agentPanes().first else { RLog.log("STATE 팬 없음"); return }
                            func snap(_ label: String) {
                                let railRows = self.railAgents(for: ws)
                                let railState = railRows.first.map { "\($0.activity)" } ?? "-"
                                RLog.log("STATE \(label): 팬=\(pane.chat.runState) 배지=\(pane.panel.badge ?? "-")"
                                         + " 상태=\(pane.panel.status)"
                                         + " 레일=\(railState)")
                            }
                            snap("시작 전")
                            pane.chat.ask("1부터 5까지 한 줄에 하나씩 세어. 다른 말은 하지 마.") { _ in
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                                    snap("답 온 뒤")
                                    RLog.log("STATE done")
                                }
                            }
                            for (i, at) in [0.4, 1.5, 3.0, 6.0].enumerated() {
                                DispatchQueue.main.asyncAfter(deadline: .now() + at) { snap("도는 중 \(i + 1)") }
                            }
                            // 대기열: 도는 중에 하나 더 넣으면 그 사이에도 계속 busy 여야 한다.
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                                pane.chat.ask("6부터 8까지 세어. 다른 말 금지.") { _ in
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { snap("두 번째 답 뒤") }
                                }
                            }
                            for (i, at) in [8.0, 10.0, 12.0, 15.0, 18.0].enumerated() {
                                DispatchQueue.main.asyncAfter(deadline: .now() + at) { snap("대기열 \(i + 1)") }
                            }
                        }
                    }
                }
                // RIVEN_EXPIRE=1: 선택지가 만료됐을 때 카드가 그 자리에서 만료로 바뀌는지.
                if ProcessInfo.processInfo.environment["RIVEN_EXPIRE"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        self.newChat()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            guard let chat = self.agentPanes().first?.chat else { RLog.log("EXPIRE 팬 없음"); return }
                            chat.ask("ask_user 로 '점심 뭐 먹지?' 를 묻고 선택지는 김밥, 국수 두 개만 줘. 다른 말은 하지 마.") { _ in }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                                RLog.log("EXPIRE 물어본 직후 \(chat.debugAskState()) 카드=\(chat.debugCardStatus())")
                                chat.debugExpireAll(t("chat.expired.session"))
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                                    RLog.log("EXPIRE 만료 처리 뒤 카드=\(chat.debugCardStatus())")
                                    RLog.log("EXPIRE done")
                                }
                            }
                        }
                    }
                }
                // RIVEN_SHIPCHECK=1: 배포 전 핵심 경로 — 에이전트 팬이 실제로 한 턴을 돌리는지.
                if ProcessInfo.processInfo.environment["RIVEN_SHIPCHECK"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        self.newChat()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            guard let chat = self.agentPanes().first?.chat else {
                                RLog.log("SHIPCHECK 채팅 팬 없음"); RLog.log("SHIPCHECK done"); return
                            }
                            chat.ask("숫자 42만 답해. 설명 금지.") { answer in
                                RLog.log("SHIPCHECK 답=\(answer.replacingOccurrences(of: "\n", with: " ").prefix(80))")
                                RLog.log("SHIPCHECK done")
                            }
                        }
                    }
                }
                // RIVEN_CODEXCHECK=1: Codex 페인이 실제로 훅을 흘려보내는지 (배지·상태의 근거).
                // riven 의 터미널(libghostty) 안에서 돌려야 의미가 있다 — pty 밖에서 codex TUI 는
                // 터미널 질의 응답을 기다리다 아무것도 그리지 않는다.
                if ProcessInfo.processInfo.environment["RIVEN_CODEXCHECK"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        guard let codex = AgentDiscovery.available().first(where: { $0.name == "Codex" }) else {
                            RLog.log("CODEX 설치 안 됨"); RLog.log("CODEX done"); return
                        }
                        RLog.log("CODEX 훅인자=\(AgentHooksInstall.codexLaunchOverrides().count)개")
                        self.launchAgent(codex)
                        // TUI 가 뜰 시간을 준 뒤 한 턴 돌린다. 페인은 이름으로 찾는다 —
                        // currentTerminalPanel() 은 먼저 있던 빈 터미널을 가리킬 수 있다.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                            let tv = self.activeDock?.groups.flatMap { $0.panels }
                                .first { $0.agentName == "Codex" }?.content as? TerminalView
                            RLog.log("CODEX 입력대상=\(tv == nil ? "없음" : "찾음")")
                            // Codex 는 처음 보는 훅을 그냥 실행하지 않는다 — "Hooks need review" 를
                            // 띄우고 고르게 한다. 2번(Trust all and continue)을 골라야 그 다음이 있다.
                            // "Hooks need review" → Enter 로 목록을 열고, 거기서 t (trust all).
                            tv?.sendEnter()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { tv?.sendText("t") }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                                tv?.sendText("숫자 42만 답해. 설명 금지.")
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { tv?.sendEnter() }
                            }
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
                            let sessions = PaneSessionRegistry.shared.sessions(inWorkspace: self.workspace?.path ?? "")
                            for s in sessions {
                                RLog.log("CODEX 페인 \(s.prefix(8)) 훅수신=\(PaneSessionRegistry.shared.isHookBacked(s))"
                                         + " codex세션=\(CodexSessions.sessionId(forPane: s)?.prefix(8) ?? "-")")
                            }
                            if let shot = ProcessInfo.processInfo.environment["RIVEN_CODEXSHOT"],
                               let v = self.window?.contentView,
                               let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                v.cacheDisplay(in: v.bounds, to: rep)
                                if let d = rep.representation(using: .png, properties: [:]) {
                                    try? d.write(to: URL(fileURLWithPath: shot))
                                }
                            }
                            RLog.log("CODEX done")
                        }
                    }
                }
                // RIVEN_CXUSAGE=1: Codex 사용량을 자기 로그에서 제대로 읽어 오는지.
                if ProcessInfo.processInfo.environment["RIVEN_CXUSAGE"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                        let r = CodexUsage.scan()
                        RLog.log("CXUSAGE 오늘 토큰=\(r.today.totalTokens) 턴=\(r.today.turns)")
                        if let l = r.limits {
                            RLog.log("CXUSAGE 남은=\(l.remainingPercent)% 창=\(CodexUsage.windowLabel(l.windowMinutes))"
                                     + " 리셋=\(l.resetsAt.map { ISO8601DateFormatter().string(from: $0) } ?? "-")"
                                     + " 플랜=\(l.planType ?? "-")")
                        } else {
                            RLog.log("CXUSAGE 한도 없음 (오늘 Codex 를 안 썼거나 로그가 없다)")
                        }
                        RLog.log("CXUSAGE done")
                    }
                }
                // RIVEN_TERMBUSY=1: 평범한 셸에서 Return 을 눌렀을 때 "작업 중" 이 풀리는지.
                if ProcessInfo.processInfo.environment["RIVEN_TERMBUSY"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                        guard let self, let p = self.currentTerminalPanel(),
                              let tv = p.content as? TerminalView else {
                            RLog.log("TERMBUSY 터미널 없음"); RLog.log("TERMBUSY done"); return
                        }
                        tv.sendText("echo hi")
                        tv.debugPressReturn()      // keyDown 과 같은 경로
                        tv.sendEnter()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                            RLog.log("TERMBUSY 엔터 직후 badge=\(p.badge ?? "없음")")
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                            RLog.log("TERMBUSY 6초 후 badge=\(p.badge ?? "없음")")
                            RLog.log("TERMBUSY done")
                        }
                    }
                }
                // RIVEN_SAVEDSHOT=<path>: 설정을 하나 바꿨을 때 "저장됨" 이 뜨는지.
                if let shot = ProcessInfo.processInfo.environment["RIVEN_SAVEDSHOT"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                        guard let self else { return }
                        self.settingsMenu()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            // 실제 저장을 일으킨다 (설정 창이 알림을 듣고 신호를 띄운다).
                            Settings.shared.set("editorMinimap", !Settings.shared.bool("editorMinimap", true))
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                                if let v = self.settingsWin?.contentView,
                                   let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                    v.cacheDisplay(in: v.bounds, to: rep)
                                    if let d = rep.representation(using: .png, properties: [:]) {
                                        try? d.write(to: URL(fileURLWithPath: shot))
                                    }
                                }
                                RLog.log("SAVEDSHOT done")
                            }
                        }
                    }
                }
                // RIVEN_GITFRAMES=1: 소스 컨트롤 아래 여백의 정체를 프레임 숫자로.
                if ProcessInfo.processInfo.environment["RIVEN_GITFRAMES"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                        guard let self, let ws = self.workspace, let win = self.window else { return }
                        // 사용자가 본 화면은 2열(넓은 배치)이다. 창을 넓혀 같은 조건으로 만든다.
                        var f = win.frame; f.size.width = 1800; f.size.height = 1100
                        win.setFrame(f, display: true)
                        self.toggleDockPanel("git")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                            let sc = self.git(for: ws)
                            sc.layoutSubtreeIfNeeded()
                            // 맨 위 커밋을 골라 상세를 채운다 (본문이 긴 커밋이라 잘림이 드러난다).
                            sc.debugSelectFirstCommit()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            sc.layoutSubtreeIfNeeded()
                            RLog.log("GITFRAMES " + sc.debugFrames())
                            if let shot = ProcessInfo.processInfo.environment["RIVEN_GITSHOT2"],
                               let v = self.window?.contentView,
                               let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                v.cacheDisplay(in: v.bounds, to: rep)
                                if let d = rep.representation(using: .png, properties: [:]) {
                                    try? d.write(to: URL(fileURLWithPath: shot))
                                }
                            }
                            RLog.log("GITFRAMES done")
                            }

                        }
                    }
                }
                // RIVEN_THEMESHOT=<prefix>: 어두운 테마에서 한 장, 밝은 테마로 바꾼 뒤 한 장.
                // 바뀌지 않은 영역이 곧 "테마를 따라가지 않는 곳" 이다.
                if let prefix = ProcessInfo.processInfo.environment["RIVEN_THEMESHOT"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                        guard let self, let v = self.window?.contentView else { return }
                        func shot(_ name: String) {
                            guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                            v.cacheDisplay(in: v.bounds, to: rep)
                            if let d = rep.representation(using: .png, properties: [:]) {
                                try? d.write(to: URL(fileURLWithPath: prefix + name + ".png"))
                            }
                        }
                        // 사용량을 사이드바에 고정해 둔다 (제보된 부분이라 비교에 꼭 넣는다).
                        Settings.shared.set("usagePinned", true)
                        self.pinUsage()
                        self.statusBar.setUpdateAvailable("0.1.99")   // 업데이트 알약도 보이게
                        // 패널을 두루 열어 둔다 — 안 열린 패널은 비교에 잡히지 않는다.
                        for id in ["search", "git", "changes", "notes", "api", "team", "preview"] {
                            self.toggleDockPanel(id)
                        }
                        self.newChat()
                        // RIVEN_THEMESTART 가 있으면 그 테마로 시작한 화면만 찍는다 (기준선).
                        // 없으면 ember 로 시작해 daylight 로 "바꾼" 화면을 찍는다.
                        // 두 장을 비교하면, 바뀌긴 했지만 끝까지 따라오지 않은 곳까지 드러난다.
                        // 설정 창도 함께 찍는다 — 테마를 바꾸는 바로 그 창이라, 여기가
                        // 안 따라오면 사용자가 가장 먼저 본다.
                        func shotSettings(_ name: String) {
                            guard let sv = self.settingsWin?.contentView,
                                  let rep = sv.bitmapImageRepForCachingDisplay(in: sv.bounds) else { return }
                            sv.cacheDisplay(in: sv.bounds, to: rep)
                            if let d = rep.representation(using: .png, properties: [:]) {
                                try? d.write(to: URL(fileURLWithPath: prefix + name + ".png"))
                            }
                        }
                        self.settingsMenu()
                        if let startTheme = ProcessInfo.processInfo.environment["RIVEN_THEMESTART"] {
                            self.switchTheme(startTheme)
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                shot("-ref"); shotSettings("-set-ref"); RLog.log("THEMESHOT done")
                            }
                        } else {
                            self.switchTheme("ember")
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                self.switchTheme("daylight")
                                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                    shot("-switched"); shotSettings("-set-switched"); RLog.log("THEMESHOT done")
                                }
                            }
                        }
                    }
                }
            // RIVEN_TERMENV=1: 일반 터미널에서 ghostty 셸 통합이 실제로 로드되는지.
                // (OSC 133 이 안 오면 "작업 중" 이 영영 안 꺼진다.)
                if ProcessInfo.processInfo.environment["RIVEN_TERMENV"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                        guard let self, let tv = self.currentTerminalPanel()?.content as? TerminalView else {
                            RLog.log("TERMENV 터미널 없음"); RLog.log("TERMENV done"); return
                        }
                        let out = "/private/tmp/termenv.txt"
                        tv.sendText("{ echo ZDOTDIR=$ZDOTDIR; echo GHOSTTY_RESOURCES_DIR=$GHOSTTY_RESOURCES_DIR; "
                                    + "echo GHOSTTY_SHELL_FEATURES=$GHOSTTY_SHELL_FEATURES; "
                                    + "echo precmd=$(typeset -f precmd >/dev/null && echo yes || echo no); "
                                    + "echo hooks=${(j:,:)precmd_functions}; } > \(out) 2>&1\n")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            RLog.log("TERMENV " + ((try? String(contentsOfFile: out, encoding: .utf8))?
                                .replacingOccurrences(of: "\n", with: " | ") ?? "(파일 없음)"))
                            RLog.log("TERMENV done")
                        }
                    }
                }
                // RIVEN_CODEXPANE=1: Codex 를 네이티브 챗 "패널" 로 열어 한 턴 도는지 (배선 전체).
                if ProcessInfo.processInfo.environment["RIVEN_CODEXPANE"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        self.newChat(kind: .codex)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            guard let pane = self.agentPanes().first(where: { $0.chat.agentKind == .codex }) else {
                                RLog.log("CXPANE Codex 팬 없음"); RLog.log("CXPANE done"); return
                            }
                            RLog.log("CXPANE 팬 제목=\(pane.panel.title) 종류=\(pane.panel.chatKind.rawValue)")
                            pane.chat.debugOnApproval = { name, detail in
                                RLog.log("CXPANE 승인카드 \(name) · \(detail.prefix(60))")
                            }
                            let prompt = ProcessInfo.processInfo.environment["RIVEN_CODEXPROMPT"]
                                ?? "숫자 42만 답해. 설명 금지."
                            pane.chat.ask(prompt) { answer in
                                RLog.log("CXPANE 답=\(answer.replacingOccurrences(of: "\n", with: " ").prefix(60))")
                                RLog.log("CXPANE 세션=\(pane.panel.sessionId?.prefix(8) ?? "-")")
                                if let shot = ProcessInfo.processInfo.environment["RIVEN_CODEXPANESHOT"],
                                   let v = self.window?.contentView,
                                   let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                    v.cacheDisplay(in: v.bounds, to: rep)
                                    if let d = rep.representation(using: .png, properties: [:]) {
                                        try? d.write(to: URL(fileURLWithPath: shot))
                                    }
                                }
                                // 사용량 팝오버를 그려서 눈으로 확인한다 (새 섹션이 붙는 자리).
                                if let shot = ProcessInfo.processInfo.environment["RIVEN_USAGESHOT"] {
                                    let cx = CodexUsage.scan()
                                    self.lastCodexLimits = cx.limits; self.lastCodexToday = cx.today
                                    let v = UsageUI.content(limits: self.lastLimits, today: self.lastToday,
                                                            freshness: self.usageFreshness(),
                                                            codexLimits: cx.limits, codexToday: cx.today,
                                                            onReload: {}, onPin: {})
                                    v.layoutSubtreeIfNeeded()
                                    v.setFrameSize(v.fittingSize)
                                    v.wantsLayer = true
                                    v.layer?.backgroundColor = Theme.bg2.cgColor
                                    if let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                        v.cacheDisplay(in: v.bounds, to: rep)
                                        if let d = rep.representation(using: .png, properties: [:]) {
                                            try? d.write(to: URL(fileURLWithPath: shot))
                                        }
                                    }
                                }
                                if let shot = ProcessInfo.processInfo.environment["RIVEN_USAGESHOT2"] {
                                    let cx = CodexUsage.scan()
                                    self.lastCodexLimits = cx.limits; self.lastCodexToday = cx.today
                                    for (i, used) in [false, true].enumerated() {
                                        Settings.shared.set("usageShowUsed", used)
                                        let v = UsageUI.content(limits: self.lastLimits, today: self.lastToday,
                                                                freshness: self.usageFreshness(),
                                                                codexLimits: cx.limits, codexToday: cx.today,
                                                                onReload: {}, onPin: {})
                                        v.layoutSubtreeIfNeeded(); v.setFrameSize(v.fittingSize)
                                        v.wantsLayer = true; v.layer?.backgroundColor = Theme.bg2.cgColor
                                        if let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                            v.cacheDisplay(in: v.bounds, to: rep)
                                            if let d = rep.representation(using: .png, properties: [:]) {
                                                try? d.write(to: URL(fileURLWithPath: shot + "-\(i).png"))
                                            }
                                        }
                                    }
                                    Settings.shared.set("usageShowUsed", false)
                                }
                                // 사이드바 고정 스트립도 떠 본다 (좁은 폭에서 CLI 구분이 되는지).
                                if let shot = ProcessInfo.processInfo.environment["RIVEN_PINSHOT"] {
                                  // 한도 조회(네트워크)가 끝난 뒤에 떠야 Claude 묶음이 들어 있다.
                                  DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                                    guard let self else { return }
                                    let cx = CodexUsage.scan()
                                    let v = UsageUI.pinnedContent(limits: self.lastLimits, today: self.lastToday,
                                                                  codexLimits: cx.limits, codexToday: cx.today) { }
                                    v.translatesAutoresizingMaskIntoConstraints = false
                                    let host = NSView(frame: NSRect(x: 0, y: 0, width: 220, height: 400))
                                    host.wantsLayer = true; host.layer?.backgroundColor = Theme.bg2.cgColor
                                    host.addSubview(v)
                                    NSLayoutConstraint.activate([
                                        v.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                                        v.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                                        v.topAnchor.constraint(equalTo: host.topAnchor),
                                    ])
                                    host.layoutSubtreeIfNeeded()
                                    host.setFrameSize(NSSize(width: 220, height: v.fittingSize.height + 12))
                                    host.layoutSubtreeIfNeeded()
                                    if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                                        host.cacheDisplay(in: host.bounds, to: rep)
                                        if let d = rep.representation(using: .png, properties: [:]) {
                                            try? d.write(to: URL(fileURLWithPath: shot))
                                        }
                                    }
                                    RLog.log("PINSHOT done claude=\(self.lastLimits?.sessionRemaining.map(String.init) ?? "-")")
                                  }
                                }
                                // Codex 페인 안에서 /cost·/status·세션 목록이 Codex 것을 쓰는지.
                                if ProcessInfo.processInfo.environment["RIVEN_CXCHATUSAGE"] != nil {
                                    let cwd = self.workspace?.path ?? ""
                                    RLog.log("CXCHAT /cost·세션 확인: 세션목록=\(CodexUsage.sessions(cwd: cwd).count)개")
                                    pane.chat.debugRunSlash("cost")
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                                        pane.chat.debugRunSlash("status")
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                                            if let shot = ProcessInfo.processInfo.environment["RIVEN_CXCHATSHOT"],
                                               let v = self.window?.contentView,
                                               let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                                v.cacheDisplay(in: v.bounds, to: rep)
                                                if let d = rep.representation(using: .png, properties: [:]) {
                                                    try? d.write(to: URL(fileURLWithPath: shot))
                                                }
                                            }
                                        }
                                    }
                                }
                                let r2 = CodexUsage.scan()
                                RLog.log("CXPANE 사용량 토큰=\(r2.today.totalTokens) 턴=\(r2.today.turns)"
                                         + " 남은=\(r2.limits.map { "\($0.remainingPercent)%" } ?? "-")"
                                         + " 창=\(r2.limits.map { CodexUsage.windowLabel($0.windowMinutes) } ?? "-")")
                                RLog.log("CXPANE done")
                            }
                        }
                    }
                }
                // RIVEN_CODEXCHAT=1: 네이티브 챗용 Codex 세션(app-server)이 실제로 한 턴을 도는지.
                if ProcessInfo.processInfo.environment["RIVEN_CODEXCHAT"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                        guard let self, let cmd = AgentDiscovery.codexCmd() else {
                            RLog.log("CXCHAT codex 없음"); RLog.log("CXCHAT done"); return
                        }
                        let ws = self.workspace?.path ?? NSTemporaryDirectory()
                        guard let s = CodexChatSession(command: cmd, cwd: ws) else {
                            RLog.log("CXCHAT 세션 시작 실패"); RLog.log("CXCHAT done"); return
                        }
                        self.codexChatBench = s
                        var text = ""
                        s.onInit = { tid, model in
                            RLog.log("CXCHAT init thread=\(tid.prefix(8)) model=\(model ?? "-")")
                            s.send("숫자 42만 답해. 설명 금지.")
                        }
                        s.onTextDelta = { text += $0 }
                        s.onMainTool = { n, d, _, _ in RLog.log("CXCHAT 도구 \(n) \(d.prefix(40))") }
                        s.onPermissionRequest = { id, n, d, _, _ in
                            RLog.log("CXCHAT 승인요청 \(n) \(d.prefix(40)) → 허용")
                            s.respond(id, allow: true)
                        }
                        s.onTurnDone = { _, sid, usage, err in
                            RLog.log("CXCHAT 답=\(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))"
                                     + " 세션=\(sid?.prefix(8) ?? "-")"
                                     + " 토큰=\(usage?.newTokens ?? -1) 오류=\(err ?? "-")")
                            RLog.log("CXCHAT done")
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                            if !text.isEmpty || true { RLog.log("CXCHAT 시간초과 확인용 텍스트=\(text.prefix(40))") }
                        }
                    }
                }
                // RIVEN_USAGEFIX=1: 토큰이 만료됐을 때 갱신이 되살아나는지, 실패가 보이는지.
                if ProcessInfo.processInfo.environment["RIVEN_USAGEFIX"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        guard let self else { return }
                        Usage.limits { first in
                            RLog.log("USAGEFIX 1차 결과=\(first.outcome) 세션=\(first.sessionRemaining.map(String.init) ?? "-")")
                            // 만료 상황 재현: 토큰을 못 쓰게 만들어 둔 채 부른다.
                            Usage.debugPoisonToken()
                            Usage.limits { second in
                                RLog.log("USAGEFIX 만료후=\(second.outcome) 세션=\(second.sessionRemaining.map(String.init) ?? "-") 토큰재시도=\(Usage.debugAuthRetries)회")
                                DispatchQueue.main.async {
                                    self.lastUsageOutcome = second.outcome
                                    RLog.log("USAGEFIX 안내문=\(self.usageFreshness())")
                                    RLog.log("USAGEFIX done")
                                }
                            }
                        }
                    }
                }
                // RIVEN_BRFIX=1: 점검에서 나온 치명 항목들이 실제로 고쳐졌는지.
                if ProcessInfo.processInfo.environment["RIVEN_BRFIX"] != nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self else { return }
                        if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                        let p = self.previewPanel!
                        func step(_ at: Double, _ body: @escaping () -> Void) {
                            DispatchQueue.main.asyncAfter(deadline: .now() + at, execute: body)
                        }
                        // 재기동 뒤 탭이 그대로 살아났는지 (RIVEN_BRFIX=restore)
                        if ProcessInfo.processInfo.environment["RIVEN_BRFIX"] == "restore" {
                            step(3) {
                                RLog.log("BRFIX 복원된탭=\(p.debugTabURLs().joined(separator: " , ")) 활성=\(p.debugActiveTab())")
                                RLog.log("BRFIX done")
                            }
                            return
                        }
                        // 0) 자체 서명 인증서
                        if let cert = ProcessInfo.processInfo.environment["RIVEN_CERTURL"] {
                            _ = p.agentNavigate(cert, newTab: false)
                            step(4.5) { RLog.log("BRFIX 인증서 결과=\(p.debugError()) 주소=\(p.debugURL())") }
                            step(5) { p.debugEval("return document.body.innerText.trim();") { r in
                                RLog.log("BRFIX 인증서 페이지내용=\(r.prefix(40))") } }
                            // 카메라·마이크: Info.plist 문구가 있어야 mediaDevices 가 생긴다.
                            step(6) { p.debugEval("return typeof navigator.mediaDevices + '/' + typeof (navigator.mediaDevices||{}).getUserMedia;") { r in
                                RLog.log("BRFIX 미디어장치=\(r)") } }
                            step(7) { RLog.log("BRFIX done") }
                            return
                        }
                        // 1) 없는 도메인 → 오류가 화면에 남아야 한다 (예전엔 아무 표시도 없었다)
                        _ = p.agentNavigate("https://이런도메인은없다.example.invalid", newTab: false)
                        step(4) { RLog.log("BRFIX DNS실패 표시=\(p.debugError())") }
                        // 2) file:// 열기
                        step(5) { _ = p.agentNavigate("file:///private/tmp/brfix/local.html", newTab: false) }
                        step(8) { p.debugEval("return document.body.innerText.trim();") { r in
                            RLog.log("BRFIX file:// 내용=\(r.prefix(60))") } }
                        // 3) 전체화면 API 존재
                        step(9) { p.debugEval("return typeof document.documentElement.requestFullscreen;") { r in
                            RLog.log("BRFIX 전체화면 API=\(r)") } }
                        // 4) UA 에 Safari 토큰
                        step(10) { p.debugEval("return navigator.userAgent;") { r in
                            RLog.log("BRFIX UA Safari포함=\(r.contains("Safari")) / \(r.suffix(40))") } }
                        // 5) 탭 여러 개 → 저장
                        step(11) {
                            _ = p.agentNavigate("https://example.com", newTab: true)
                            _ = p.agentNavigate("https://developer.apple.com", newTab: true)
                        }
                        step(16) {
                            RLog.log("BRFIX 탭들=\(p.debugTabURLs().joined(separator: " , ")) 활성=\(p.debugActiveTab())")
                            RLog.log("BRFIX done")
                        }
                    }
                }
                // RIVEN_BRDL=<url>: 내려받기 목록·사이트별 확대·탭 메뉴가 실제로 동작하는지.
                if let dl = ProcessInfo.processInfo.environment["RIVEN_BRDL"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self else { return }
                        if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                        let p = self.previewPanel!
                        _ = p.agentNavigate(dl + "/page.html", newTab: false)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                            p.debugSetZoom(1.4)
                            RLog.log("BRDL 확대 설정=\(p.debugZoom())")
                            _ = p.agentNavigate("https://example.com", newTab: false)
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                            _ = p.agentNavigate(dl + "/page.html", newTab: false)   // 돌아오면 확대가 살아 있어야
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 9) {
                            RLog.log("BRDL 되돌아온 확대=\(p.debugZoom()) (1.4 기대)")
                            RLog.log("BRDL 탭메뉴=\(p.debugTabMenu(0).joined(separator: ", "))")
                            _ = p.agentNavigate(dl + "/big.bin", newTab: false)     // 내려받기
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 14) {
                            RLog.log("BRDL 내려받기=\(p.debugDownloads())")
                            if let shot = ProcessInfo.processInfo.environment["RIVEN_BRDLSHOT"] {
                                p.debugDownloadsShot(shot)
                            }
                            RLog.log("BRDL done")
                        }
                    }
                }
                // RIVEN_BRSHOT=<png>: 파비콘 탭 줄과 주소창 자동완성이 실제로 어떻게 보이는지.
                if let shot = ProcessInfo.processInfo.environment["RIVEN_BRSHOT"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self else { return }
                        if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                        let p = self.previewPanel!
                        for (u, title, n) in [("https://github.com/wassupss/riven", "riven · GitHub", 30),
                                              ("https://news.ycombinator.com", "Hacker News", 12),
                                              ("https://developer.apple.com/documentation", "Apple Developer 문서", 5)] {
                            for _ in 0..<n { BrowserStore.recordVisit(url: URL(string: u), title: title, isPrivate: false) }
                        }
                        BrowserStore.toggleBookmark(url: URL(string: "https://vercel.com/dashboard"), title: "Vercel 대시보드")
                        _ = p.agentNavigate("https://github.com", newTab: false)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            _ = p.agentNavigate("https://news.ycombinator.com", newTab: true)
                            _ = p.agentNavigate("https://developer.apple.com/documentation", newTab: true)
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                            p.debugType("ri")     // 자동완성 목록이 뜨는 상태로 찍는다
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                                guard let rep = p.bitmapImageRepForCachingDisplay(in: p.bounds) else { return }
                                p.cacheDisplay(in: p.bounds, to: rep)
                                if let d = rep.representation(using: .png, properties: [:]) {
                                    try? d.write(to: URL(fileURLWithPath: shot))
                                }
                                RLog.log("BRSHOT 배치 \(p.debugFrames())")
                                RLog.log("BRSHOT 메뉴=\(p.debugMenu())")
                                // 웹 내용은 cacheDisplay 로 안 잡힌다 (원격 레이어) — 스냅샷으로 확인.
                                p.capture { path in RLog.log("BRSHOT 페이지스냅=\(path ?? "실패")") }
                                RLog.log("BRSHOT done \(p.debugSuggestions())")
                                // 두 번째 장면: 기록·북마크 보기 (⌘Y)
                                p.debugShowLibrary()
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                                    guard let win = self.window,
                                          let cv = win.contentView,
                                          let rep2 = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) else { return }
                                    cv.cacheDisplay(in: cv.bounds, to: rep2)
                                    if let d2 = rep2.representation(using: .png, properties: [:]) {
                                        try? d2.write(to: URL(fileURLWithPath: shot + ".lib.png"))
                                    }
                                    p.debugLibraryShot(shot + ".lib2.png")
                                    RLog.log("BRSHOT lib done")
                                }
                            }
                        }
                    }
                }
                // RIVEN_BROWSERBENCH=<url>: 브라우저 패널과 riven_browser_* 를 클릭 없이 훑는다.
                if let target = ProcessInfo.processInfo.environment["RIVEN_BROWSERBENCH"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                        guard let self else { return }
                        if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                        let p = self.previewPanel!
                        func step(_ name: String, _ at: Double, _ body: @escaping () -> Void) {
                            DispatchQueue.main.asyncAfter(deadline: .now() + at) {
                                RLog.log("BROWSER ▶ \(name)"); body()
                            }
                        }
                        func tool(_ name: String, _ at: Double,
                                  _ body: @escaping (@escaping (String) -> Void) -> Void) {
                            step(name, at) { body { r in RLog.log("BROWSER \(name) → \(r.prefix(220))") } }
                        }
                        step("open", 0) { RLog.log("BROWSER open → " + p.agentNavigate(target, newTab: false)) }
                        step("state", 2.0) { RLog.log("BROWSER state → " + p.agentState().replacingOccurrences(of: "\n", with: " | ")) }
                        tool("read", 2.3) { p.agentRead(selector: "#para", html: false, $0) }
                        tool("readHtml", 2.5) { p.agentRead(selector: "#head", html: true, $0) }
                        tool("click", 2.7) { p.agentClick("#btn", $0) }
                        tool("clickCheck", 3.0) { p.agentRead(selector: "#clicked", html: false, $0) }
                        tool("fill", 3.2) { p.agentFill("#q", "riven-test", submit: true, $0) }
                        tool("fillCheck", 3.6) { p.agentRead(selector: "#out", html: false, $0) }
                        tool("wait", 3.8) { p.agentWait("#late", timeoutMs: 5000, $0) }
                        tool("scrollSel", 5.4) { p.agentScroll(selector: "#bottom", y: nil, $0) }
                        tool("scrollY", 5.7) { p.agentScroll(selector: nil, y: 0, $0) }
                        tool("eval", 5.9) { p.agentEval("return document.title + ' / ' + document.querySelectorAll('div').length;", $0) }
                        tool("missing", 6.1) { p.agentClick("#nope", $0) }
                        // target=_blank → 새 탭이 생겨야 한다.
                        tool("newTabLink", 6.3) { p.agentClick("#ext", $0) }
                        step("tabs", 7.6) { RLog.log("BROWSER tabs → " + p.agentState().replacingOccurrences(of: "\n", with: " | ")) }
                        tool("back", 7.9) { done in done(p.agentGo("back")) }
                        step("shot", 8.6) {
                            guard let shot = ProcessInfo.processInfo.environment["RIVEN_BROWSERSHOT"],
                                  let rep = p.bitmapImageRepForCachingDisplay(in: p.bounds) else { return }
                            p.cacheDisplay(in: p.bounds, to: rep)
                            if let d = rep.representation(using: .png, properties: [:]) {
                                try? d.write(to: URL(fileURLWithPath: shot))
                            }
                            RLog.log("BROWSER done")
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
        // RIVEN_AVATARTEST=<png>: 아바타 고르기 한 바퀴. 첫 실행은 그룹을 만들고
        // 편집 팝오버를 연 뒤(고르는 줄이 실제로 보이는지) 팝오버와 같은 경로로
        // 아바타를 심는다. 같은 데이터 디렉터리로 다시 띄우면 이미 심어져 있으므로
        // 아무것도 고르지 않고 복원된 값만 찍는다 — 재기동 후에도 남는지 확인.
        if let shot = ProcessInfo.processInfo.environment["RIVEN_AVATARTEST"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                guard let self else { return }
                RLog.log("AVATAR atStart=" + self.agentPanes().map {
                    "\($0.chat.agentRole):\($0.panel.chatAvatar ?? "auto")"
                }.joined(separator: ","))
                if self.agentPanes().filter({ $0.chat.groupName == "배포팀" }).isEmpty {
                    self.createAgentGroup("배포팀", [
                        (name: "리드", agent: nil, model: nil, parent: nil),
                        (name: "구현", agent: nil, model: "sonnet", parent: 0),
                    ])
                }
                if self.auxDockPanels["team"] == nil { self.toggleDockPanel("team") }
                self.teamPanel.show(group: "배포팀")
                NSApp.activate(ignoringOtherApps: true)
                self.window.makeKeyAndOrderFront(nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    let target = "구현"
                    let pane = self.agentPanes().first { $0.chat.agentRole == target }
                    let restored = pane?.panel.chatAvatar
                    if restored == nil {
                        // 팝오버를 열어 아바타 줄이 보이는 상태로 한 장 뜬다.
                        self.teamPanel.debugOpenEdit(target)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                            self.debugPopoverSnapshot(to: shot)
                            // 팝오버가 저장할 때와 같은 경로로 심는다.
                            self.editAgentPane("배포팀", target, name: target,
                                               model: pane?.chat.preferredModel,
                                               parent: pane?.chat.parentName, avatar: "5.3")
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                                self.logAvatarState(target, tag: "set")
                                self.debugWindowSnapshot(to: shot.replacingOccurrences(
                                    of: ".png", with: "-picked.png"))
                            }
                        }
                    } else {
                        self.logAvatarState(target, tag: "restored")
                        self.debugWindowSnapshot(to: shot.replacingOccurrences(
                            of: ".png", with: "-restored.png"))
                        // "자동으로 되돌리기"도 같은 경로다 — 고른 값을 지우면 이름 해시로 돌아가야 한다.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                            self.editAgentPane("배포팀", target, name: target,
                                               model: pane?.chat.preferredModel,
                                               parent: pane?.chat.parentName, avatar: nil)
                            self.logAvatarState(target, tag: "reset")
                        }
                    }
                }
            }
        }
        if ProcessInfo.processInfo.environment["RIVEN_OPEN"] == nil {
            // Reopening restores workspaces, dock layouts, editor tabs and chat transcripts — enough
            // work to look like a freeze. Show the overlay FIRST and force a paint, then restore on
            // the next runloop turn so the spinner is actually on screen while it happens.
            let willRestore = (Settings.shared.object("session")?["workspaces"] as? [String])?.isEmpty == false
            if ProcessInfo.processInfo.environment["RIVEN_BOOTTIME"] != nil {
                RLog.log(String(format: "BOOT 오버레이표시 %.0fms (창표시 이후 이만큼 지나서야 나온다)",
                                Date().timeIntervalSince(AppDelegate.launchedAt) * 1000))
            }
            if willRestore { showLoadingOverlay(t("app.restoring")) }
            if ProcessInfo.processInfo.environment["RIVEN_BOOTTIME"] != nil {
                RLog.log("BOOT 오버레이 frame=\(NSStringFromRect(switchOverlay.frame)) "
                       + "dockHost=\(NSStringFromRect(dockHost.bounds)) "
                       + "숨김=\(switchOverlay.isHidden) 창보임=\(window.isVisible)")
                // 복원 직전 화면을 그대로 떠서 실제로 보이는지 확인한다.
                if let v = window.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                    v.cacheDisplay(in: v.bounds, to: rep)
                    if let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: "/tmp/boot-overlay.png"))
                    }
                }
            }
            DispatchQueue.main.async {
                self.restoreSession()
                // 복원이 자리를 잡은 뒤에 띄운다. 복원 중에 창을 올리면 그 위로 세션이
                // 그려지면서 깜빡이고, 첫인상이 "업데이트하면 화면이 튄다" 가 된다.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    let shown = ReleaseNotes.showIfUpdated(over: self?.window)
                    // RIVEN_SIDEBARFIX=1: 창 크기를 바꿨을 때 사이드바 폭이 따라 변하는지.
            if ProcessInfo.processInfo.environment["RIVEN_SIDEBARFIX"] != nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    guard let self, let body = self.bodySplit, let win = self.window else { return }
                    func sbw() -> CGFloat { body.arrangedSubviews.first?.frame.width ?? -1 }
                    RLog.log("SBFIX 스플릿자식=\(body.arrangedSubviews.map { type(of: $0) })")
                    RLog.log("SBFIX sidebarView 가 스플릿 자식인가=\(body.arrangedSubviews.contains { $0 === self.debugSidebarView })")
                    let before = sbw()
                    var f = win.frame; f.size.width += 400
                    win.setFrame(f, display: true)
                    body.layoutSubtreeIfNeeded()
                    RLog.log("SBFIX 창 +400 → 사이드바 \(Int(before)) → \(Int(sbw()))")
                    f.size.width -= 400
                    win.setFrame(f, display: true)
                    body.layoutSubtreeIfNeeded()
                    RLog.log("SBFIX 창 원복 → 사이드바 \(Int(sbw()))  (저장값=\(Int(Settings.shared.double("sidebarWidth", 220))))")
                    // 구분선이 실제로 마우스를 받는지. 받지 못하면 아무리 끌어도 안 움직인다.
                    let dv = body.dividerThickness
                    let x = sbw() + dv / 2
                    let mid = NSPoint(x: x, y: body.bounds.midY)
                    let hit = body.hitTest(body.convert(mid, to: body.superview))
                    RLog.log("SBFIX 구분선두께=\(dv) 구분선x=\(Int(x)) 그 지점을 받는 뷰=\(hit.map { String(describing: type(of: $0)) } ?? "없음")")
                    RLog.log("SBFIX 그 뷰가 스플릿인가=\(hit === body)")
                    for dx in [CGFloat(-4), -2, 2, 4] {
                        let pt = NSPoint(x: x + dx, y: body.bounds.midY)
                        let h = body.hitTest(body.convert(pt, to: body.superview))
                        RLog.log("SBFIX 구분선에서 \(Int(dx))pt → 스플릿이 받나=\(h === body)")
                    }
                    RLog.log("SBFIX done")
                }
            }
            if ProcessInfo.processInfo.environment["RIVEN_RELNOTES"] != nil {
                        RLog.log("RELNOTES 띄움=\(shown) 버전=\(ReleaseNotes.currentVersion)"
                                 + " 기록=\(Settings.shared.string("lastSeenVersion", "-"))")
                        if let shot = ProcessInfo.processInfo.environment["RIVEN_RELSHOT"], shown {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                                if let v = ReleaseNotes.debugWindow?.contentView,
                                   let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                    v.cacheDisplay(in: v.bounds, to: rep)
                                    if let d = rep.representation(using: .png, properties: [:]) {
                                        try? d.write(to: URL(fileURLWithPath: shot))
                                    }
                                }
                                RLog.log("RELNOTES done")
                            }
                        } else { RLog.log("RELNOTES done") }
                    }
                }
            }
            // RIVEN_RAILDUP=1: 저장된 세션에 같은 폴더가 두 형태로 들어 있을 때 레일이 어떻게
            // 되는지 (베타테스터 제보: 왼쪽 워크스페이스 클릭이 이상하다). 복원 경로에서만
            // 의미가 있으므로 RIVEN_OPEN 분기 밖에 둔다.
            if ProcessInfo.processInfo.environment["RIVEN_RAILDUP"] != nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                    guard let self else { return }
                    RLog.log("RAILDUP 워크스페이스 \(self.workspaces.count)개")
                    for w in self.workspaces {
                        RLog.log("RAILDUP   absoluteString=\(w.absoluteString) path=\(w.path)")
                    }
                    RLog.log("RAILDUP 레일카드=\(self.rail.debugCardCount())개")
                    RLog.log("RAILDUP done")
                }
            }
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
                        if let sub = ProcessInfo.processInfo.environment["RIVEN_KBSUB"].flatMap(Int.init) {
                            self.settingsWin?.debugSetKbSubtab(sub)
                        }
                        self.settingsWin?.openTab(t)
                    }
                    if let shot = ProcessInfo.processInfo.environment["RIVEN_SETTINGSSHOT"] {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                            guard let v = self.settingsWin?.contentView,
                                  let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                            v.cacheDisplay(in: v.bounds, to: rep)
                            if let d = rep.representation(using: .png, properties: [:]) {
                                try? d.write(to: URL(fileURLWithPath: shot))
                            }
                            RLog.log("SETSHOT done \(Int(v.bounds.width))x\(Int(v.bounds.height))")
                        }
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

    // One-time disclosure for opt-out crash reporting (shown once ever). Deferred so it
    // doesn't block launch; a plain sheet with a link to the Settings toggle.
    private func maybeShowCrashReportingNotice() {
        guard SupabaseConfig.isConfigured, !Settings.shared.bool("crashNoticeShown", false) else { return }
        Settings.shared.set("crashNoticeShown", true)
        DispatchQueue.main.async { [weak self] in
            let a = NSAlert()
            a.messageText = t("crash.noticeTitle")
            a.informativeText = t("crash.noticeBody")
            a.addButton(withTitle: t("common.ok"))
            a.addButton(withTitle: t("crash.turnOff"))
            if let win = self?.window { a.beginSheetModal(for: win) { resp in
                if resp == .alertSecondButtonReturn { Settings.shared.set("crashReporting", false) }
            } } else if a.runModal() == .alertSecondButtonReturn {
                Settings.shared.set("crashReporting", false)
            }
        }
    }

    // Write crash stacks to a per-user, owner-only file under Application Support
    // (not world-readable /tmp — stacks can contain workspace paths). Raw binary
    // won't produce a normal crash report. Covers Obj-C exceptions + fatal signals.
    private func installCrashHandler() {
        // NSSetUncaughtExceptionHandler needs a context-free C function pointer, so the
        // version/time are looked up INSIDE the closure (no captures allowed).
        NSSetUncaughtExceptionHandler { ex in
            let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
            let hdr = "v\(ver) \(Date())\n"   // version + time so a report has context
            let s = hdr + "EXCEPTION: \(ex.name.rawValue): \(ex.reason ?? "")\n\(ex.callStackSymbols.joined(separator: "\n"))"
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
    /// 상단 헤더 띠와 그 아래 실선. 지역 변수로만 두면 테마가 바뀔 때 다시 칠할 수가 없어,
    /// 밝은 테마로 바꿔도 이 띠만 어두운 채로 남아 있었다.
    private var headerStrip: NSView?
    private var headerHairline: NSView?
    /// 사이드바 위쪽 "패널 추가" 띠. 같은 이유로 들고 있어야 다시 칠할 수 있다.
    private var sidebarHeadStrip: NSView?
    private var sidebarHeadButton: NSButton?
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
        statusBar.onAccount = { [weak self] in self?.showAccountPopover() }
        statusBar.moveControlsToHeader()   // usage + settings now live in the app header (top-right)

        // Body split: [sidebar | right area], full height above the status bar. The
        // header lives ONLY inside the right area (see rightContainer below); the left
        // sidebar just reserves a matching top inset for the macOS traffic lights.
        let bodyH = H - statusH - titleH   // dock/editor content height, below the header
        let body = PersistingSplitView(frame: NSRect(x: 0, y: statusH, width: W, height: H - statusH))
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
        let sidebarSplitV = PersistingSplitView(frame: NSRect(x: 0, y: 0, width: 220, height: bodyH))
        sidebarSplitV.isVertical = false
        sidebarSplitV.dividerStyle = .thin
        sidebarSplitV.delegate = self          // enforce a min rail height (see extension)
        sidebarSplit = sidebarSplitV
        sidebarView = sidebarSplitV

        rail = WorkspaceRail(frame: NSRect(x: 0, y: 0, width: 220, height: 150))
        rail.onOpen = { [weak self] in self?.openFolder() }
        rail.onSelect = { [weak self] url in self?.switchWorkspace(url) }
        rail.onSelectAgent = { [weak self] url, paneId in self?.revealPane(wsPath: url.path, panelId: paneId) }
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
            if url == self.workspace { self.updateWorkspaceHeader(url) }   // reflect in header/title now
            self.persistSession()
        }
        WorkspaceStatus.shared.onChange = { [weak self] ws in
            guard let self else { return }
            let a = WorkspaceStatus.shared.rollup(ws)
            self.rail.setActivity(URL(fileURLWithPath: ws), a)
            self.rail.setAgents(URL(fileURLWithPath: ws), self.railAgents(for: URL(fileURLWithPath: ws)))  // refresh per-agent rows
            if self.workspace?.path == ws {   // reflect the active workspace's status in the header icon
                self.headerIcon?.contentTintColor = a.color   // 상태 색은 한 군데(AgentStatus)에서만 정한다
            }
        }


        sidebarSplitV.addArrangedSubview(rail)
        // 탐색기는 워크스페이스마다 다른 인스턴스라, 사이드바에는 빈 자리만 두고
        // 활성 워크스페이스의 것을 끼운다 (에디터를 옮겨 붙이는 방식과 같다).
        explorerHost.autoresizingMask = [.width, .height]
        sidebarSplitV.addArrangedSubview(explorerHost)
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
        headerStrip = dockHeader
        dockHeader.autoresizingMask = [.width, .minYMargin]
        let dhair = NSView(); dhair.wantsLayer = true; dhair.layer?.backgroundColor = Theme.hairline.cgColor
        headerHairline = dhair
        dhair.frame = NSRect(x: 0, y: 0, width: rightW, height: 1); dhair.autoresizingMask = [.width, .maxYMargin]
        dockHeader.addSubview(dhair)
        // Active workspace info (folder + branch) so the header isn't empty.
        let hIcon = NSImageView(); hIcon.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        hIcon.contentTintColor = Theme.fgDim; hIcon.translatesAutoresizingMaskIntoConstraints = false
        let hLabel = NSTextField(labelWithString: ""); hLabel.font = UIScale.font(UIScale.body, .medium)
        hLabel.textColor = Theme.fg; hLabel.translatesAutoresizingMaskIntoConstraints = false
        headerLabel = hLabel; headerIcon = hIcon
        dockHeader.addSubview(hIcon); dockHeader.addSubview(hLabel)

        // Right side of the header: usage widget + settings gear (moved here from the
        // bottom status bar per the app-header layout).
        let uIcon = NSImageView()
        uIcon.image = NSImage(systemSymbolName: "gauge.with.dots.needle.33percent", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        uIcon.contentTintColor = Theme.fgDim; uIcon.translatesAutoresizingMaskIntoConstraints = false
        let uLabel = NSTextField(labelWithString: ""); uLabel.font = UIScale.font(UIScale.small)
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
            // Restore the user's saved sidebar width + rail height (default 220 / 190).
            // Guard persistence until AFTER this restore so the transient initial layout
            // can't clobber the saved value before we apply it. CLAMP to sane ranges — an
            // earlier bug saved the MAX (480 / 693), which then reopened the sidebar full-wide.
            let sw = CGFloat(Settings.shared.double("sidebarWidth", 220))
            let sr = CGFloat(Settings.shared.double("railHeight", 190))
            let w = (sw >= 160 && sw <= 400) ? sw : 220     // out of range = corrupt (480 artifact) → default
            let rh = (sr >= 96 && sr <= 500) ? sr : 190     // (693 artifact) → default
            // Clean a corrupt stored value in place so it stops reverting every launch — otherwise
            // a stuck 480 keeps failing the range check and restoring 220 forever.
            if w != sw { Settings.shared.set("sidebarWidth", Double(w)) }
            if rh != sr { Settings.shared.set("railHeight", Double(rh)) }
            self.sidebarWidth = w
            body.setPosition(w, ofDividerAt: 0)
            sidebarSplitV.setPosition(rh, ofDividerAt: 0)   // rail shows ~2 cards + a bit
            RLog.log("sidebar: restored width=\(Int(w)) railHeight=\(Int(rh))")
            self.sidebarLayoutRestored = true
        }
    }
    // Set once the saved sidebar geometry has been applied; before that we don't persist
    // divider drags (initial-layout resize events would otherwise overwrite saved values).
    private var sidebarLayoutRestored = false
    var debugSidebarRestored: Bool { sidebarLayoutRestored }

    // The sidebar head (riven's .sidebar-head): draggable like a native titlebar
    // (window move + double-click zoom), reserves the traffic-light zone on the left,
    // and hosts the "패널 추가" button just to their right — in the left fixed area.
    private var sidebarView: NSView!
    var debugSidebarView: NSView? { sidebarView }
    private func makeSidebarHead(width: CGFloat, height: CGFloat) -> NSView {
        let strip = DraggableStrip(frame: NSRect(x: 0, y: 0, width: width, height: height))
        strip.wantsLayer = true
        strip.layer?.backgroundColor = Theme.bg2.cgColor
        sidebarHeadStrip = strip
        let addBtn = NSButton(title: " 패널 추가", target: self, action: #selector(quickPanelMenu))
        addBtn.image = NSImage(systemSymbolName: "rectangle.split.2x1", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
        addBtn.imagePosition = .imageLeading
        addBtn.isBordered = false
        addBtn.contentTintColor = Theme.fgDim
        sidebarHeadButton = addBtn
        addBtn.font = UIScale.font(UIScale.body, .medium)
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
        dock.onActivePanel = { [weak self, weak dock] p in
            self?.dockActivePanelChanged(p, click: dock?.activationFromClick ?? false)
        }
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
                  (*)
                    # Reap a claude from a previous riven still holding this session (it
                    # ignores SIGHUP, so quitting riven orphans it). Match by id so it hits
                    # a --session-id OR --resume launch. The interactive shell's own cmdline
                    # never contains the id, so this can't kill the shell running it.
                    pkill -f -- "$RIVEN_PANE_SESSION" 2>/dev/null
                    # RESUME if a transcript already exists (id globbed across project dirs,
                    # so it's encoding/CLAUDE_CONFIG_DIR independent); CREATE otherwise.
                    # --session-id refuses an id that already has state ("already in use").
                    if [ -n "$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -name "$RIVEN_PANE_SESSION.jsonl" 2>/dev/null | head -1)" ]; then
                      rv+=(--resume "$RIVEN_PANE_SESSION")
                    else
                      rv+=(--session-id "$RIVEN_PANE_SESSION")
                    fi
                    ;;
                esac
                # riven's agent hooks (deep-merged, so the user's own hooks still fire).
                [ -n "$RIVEN_HOOKS_SETTINGS" ] && rv+=(--settings "$RIVEN_HOOKS_SETTINGS")
                # riven's OWN tools (ask_user / open file / preview / API / panels / workspaces),
                # so a CLI typed in a riven terminal can drive the IDE just like the native chat.
                if [ -n "$RIVEN_MCP_CONFIG" ]; then
                  rv+=(--mcp-config "$RIVEN_MCP_CONFIG")
                  [ -n "$RIVEN_MCP_PROMPT" ] && rv+=(--append-system-prompt "$RIVEN_MCP_PROMPT")
                fi
                command "${RIVEN_REAL_CLAUDE:-claude}" "${rv[@]}" "$@"
              }
              # riven: 손으로 친 `codex` 도 상태 훅을 달고, 이 페인의 대화를 이어 간다.
              # Codex 는 세션 id 를 골라 줄 수 없어 방향이 반대다 — 지난 실행의 SessionStart
              # 훅이 적어 둔 id 를 읽어 `resume` 로 되돌아간다 (파일이 없으면 새 대화).
              codex() {
                local -a rv
                case " $* " in
                  (*" resume "*|*" fork "*|*" exec "*|*" -h "*|*" --help "*) ;;
                  (*)
                    if [ -n "$RIVEN_CODEX_SESSION_FILE" ] && [ -s "$RIVEN_CODEX_SESSION_FILE" ]; then
                      rv+=(resume "$(cat "$RIVEN_CODEX_SESSION_FILE")")
                    fi
                    # 훅 설정은 riven 이 통째로 만들어 넘긴다 (사용자의 ~/.codex 는 건드리지 않는다).
                    if [ -n "$RIVEN_CODEX_HOOK_ARGS" ]; then
                      local -a ha; eval "ha=($RIVEN_CODEX_HOOK_ARGS)"; rv+=("${ha[@]}")
                    fi
                    ;;
                esac
                command "${RIVEN_REAL_CODEX:-codex}" "${rv[@]}" "$@"
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
                // Set the pane badge BEFORE WorkspaceStatus.setPane — setPane fires onChange,
                // which rebuilds the rail from p.badge; if the badge weren't set yet the rail
                // would read the STALE value and busy never showed (esp. other workspaces).
                if let p = self?.panel(pane) {
                    // attn (needs input) outranks busy, exactly as the old poller decided.
                    if busy { if p.badge != "attn" { p.badge = "busy" } }
                    else if p.badge == "busy" { p.badge = nil; (p.content as? TerminalView)?.setRingState(nil) }
                }
                WorkspaceStatus.shared.setPane(ws: pane.workspace, pane: pane.paneId, busy: busy)
                self?.refreshDockTabs()
            },
            setAttention: { [weak self] pane, attn in
                if let p = self?.panel(pane) {
                    p.badge = attn ? "attn" : nil
                    (p.content as? TerminalView)?.setRingState(attn ? "attn" : nil)
                }
                WorkspaceStatus.shared.setPane(ws: pane.workspace, pane: pane.paneId, attn: attn)
                self?.refreshDockTabs()
            },
            isWatched: { [weak self] pane in
                guard let self, let p = self.panel(pane), let tv = p.content as? TerminalView else { return false }
                return self.window?.firstResponder === tv && self.window?.isKeyWindow == true
            },
            notify: { [weak self] pane, body in
                let title = self?.displayName(for: URL(fileURLWithPath: pane.workspace))
                    ?? (pane.workspace as NSString).lastPathComponent
                let name = self?.panel(pane)?.title ?? t("title.terminal")
                Notifications.post(title: title, body: "\(name) · \(body)", wsPath: pane.workspace, panelId: pane.paneId)
            }
        )
        AgentHookServer.shared.onEvent = { [weak self] event in
            self?.routeAgentEvent(event)
            AgentActivity.shared.handle(event)
        }
        AgentHookServer.shared.start()
        _ = terminalTools?.mcpConfigPath()   // write the config now so the first terminal already has it
    }

    // Workspaces with an agent turn currently in flight (UserPromptSubmit → Stop), keyed
    // by workspace path. This is what gates the FSEvents backstop for hook-backed panes:
    // record shell-driven edits (sed / redirects the agent runs via Bash) ONLY while a
    // turn is active, so a `git checkout` or build run OUTSIDE a turn no longer pollutes
    // the Changes panel — the coarse "ever had an agent session" gate did.
    /// 벤치가 붙잡아 두는 Codex 챗 세션 (놓으면 프로세스가 바로 죽는다).
    private var codexChatBench: CodexChatSession?
    private var turnActiveWorkspaces: Set<String> = []

    // Change-tracking half of the hook stream. Edit/Write/MultiEdit give a precise,
    // per-pane "the agent changed THIS file" signal — far better than guessing from
    // FSEvents. Turn boundaries drive the FSEvents backstop gate above.
    private func routeAgentEvent(_ event: AgentEvent) {
        guard let pane = PaneSessionRegistry.shared.pane(for: event.pane) else { return }
        // Codex 는 세션 id 를 riven 이 정해 줄 수 없다 (`--session-id` 가 없다). 대신 여기서
        // 받아 적어 두면 다음 실행 때 `codex resume <id>` 로 같은 대화가 이어진다.
        if event.agent == "codex", event.kind == .sessionStart, let sid = event.sessionId {
            CodexSessions.record(pane: event.pane, sessionId: sid)
        }
        switch event.kind {
        case .userPromptSubmit:
            turnActiveWorkspaces.insert(pane.workspace)
        case .stop, .stopFailure:
            // Clear only when no other pane in this workspace is still mid-turn.
            let stillBusy = PaneSessionRegistry.shared.sessions(inWorkspace: pane.workspace)
                .contains { $0 != event.pane && AgentActivity.shared.hasActiveTurn($0) }
            if !stillBusy { turnActiveWorkspaces.remove(pane.workspace) }
        case .postToolUse:
            if let path = event.filePath { recordAgentFileEdit(workspace: pane.workspace, path: path) }
        default: break
        }
        // Learn the agent KIND for a hand-typed pane (agentName nil) and give its tab the
        // matching glyph — so a plain terminal running `claude` shows the Claude icon, not the
        // generic terminal icon (#9). Refresh the rail so the row appears with the right icon.
        if let p = panel(pane) {
            p.agentExited = false   // a hook means an agent is running in this pane again
            if p.hookAgentKind != event.agent { p.hookAgentKind = event.agent }
            if p.agentName == nil, let sym = agentGlyph(kind: event.agent) {
                let img = NSImage(systemSymbolName: sym, accessibilityDescription: nil)
                if p.icon?.name() != img?.name() { p.icon = img; refreshDockTabs() }
            }
        }
        rail.setAgents(URL(fileURLWithPath: pane.workspace), railAgents(for: URL(fileURLWithPath: pane.workspace)))
    }
    // SF-symbol glyph for an agent kind string (hook `agent` field or DockPanel.agentName).
    private func agentGlyph(kind: String?) -> String? {
        switch kind?.lowercased() {
        case "claude", "claude code": return "asterisk"
        case "codex": return "camera.aperture"
        default: return nil
        }
    }

    // Kill a claude left over from a previous riven that still holds this pane's session id
    // (claude ignores SIGHUP, so it survives quit and otherwise blocks restore with "Session
    // ID already in use"). Run from riven's OWN process — never from the pane's shell, whose
    // cmdline carries "--session-id <id>" and would be matched and killed by an in-shell
    // pkill before claude could exec. UUIDs contain only [0-9a-f-], so the argument is safe.
    private func reapOrphanSession(_ session: String) {
        guard UUID(uuidString: session) != nil else { return }
        // Match by the session UUID alone, so it catches the orphan whether the previous
        // launch used `--session-id <id>` or `--resume <id>`. The id is globally unique and
        // only appears in that session's claude args, so this can't hit anything else.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        p.arguments = ["-f", "--", session]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); p.waitUntilExit() } catch { RLog.log("reapOrphanSession: pkill failed \(error)") }
    }

    // Record one agent file edit against its pane's workspace (not necessarily the active
    // one). Mirrors processFileChanges for a single file: before = session baseline / git
    // HEAD, after = disk, size-capped. This is the precise path; FSEvents is the backstop.
    private func recordAgentFileEdit(workspace: String, path: String) {
        guard path.hasPrefix(workspace + "/"), !AgentEdits.isIgnored(path) else { return }
        let memBefore = AgentEdits.shared.baselineContent(path)
        fileChangeQueue.async { [weak self] in
            let attrs = try? FileManager.default.attributesOfItem(atPath: path)
            if let size = attrs?[.size] as? Int, size > AgentEdits.maxTrackedFileSize { return }
            guard let after = try? String(contentsOfFile: path, encoding: .utf8) else { return }  // deleted/binary
            let rel = String(path.dropFirst(workspace.count + 1))
            let before = memBefore ?? Git.showFilesBatch(cwd: workspace, rels: [rel])[rel]
            DispatchQueue.main.async {
                guard let self else { return }
                if before == after { AgentEdits.shared.resolve(path: path); return }
                if AgentEdits.shared.baselineContent(path) == nil {
                    AgentEdits.shared.updateBaseline(path, before ?? "")
                }
                AgentEdits.shared.record(path: path, workspace: workspace,
                                         before: before ?? "", after: after, isNew: before == nil)
                RLog.log("changes: hook-recorded agent edit \(rel)")
                if self.workspace?.path == workspace { self.ensureChangesPanel() }
            }
        }
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
        // NOTE: this pane resumes ONLY its OWN session (paneSession). We deliberately do NOT
        // adopt "the folder's latest conversation" when this pane's id has no transcript:
        // that made any plain terminal in a claude-touched folder — including a brand-new one
        // opened after the user closed a claude pane — resurrect an unrelated old conversation
        // (observed: "restore reconnect: pane X → folder latest Y"). A closed pane's session
        // must stay closed; a new pane must start fresh. The fixed shim (v0.1.16+) keeps the
        // pane id and the conversation id in sync, so precise per-pane matching is correct.
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
        // 셸 심이 손으로 친 `codex` 에도 같은 것을 붙일 수 있도록.
        if let codex = AgentDiscovery.codexCmd() { env["RIVEN_REAL_CODEX"] = codex }
        if let f = CodexSessions.path(forPane: paneSession) { env["RIVEN_CODEX_SESSION_FILE"] = f }
        let codexHookArgs = AgentHooksInstall.codexLaunchOverrides()
        if !codexHookArgs.isEmpty {
            env["RIVEN_CODEX_HOOK_ARGS"] = codexHookArgs.map(shellQuote).joined(separator: " ")
        }
        if let srv = terminalTools, let cfg = srv.mcpConfigPath() {
            env["RIVEN_MCP_CONFIG"] = cfg
            env["RIVEN_MCP_PROMPT"] = srv.systemPrompt()
        }
        // An agent panel runs the CLI directly (no shell). For a session-capable agent
        // (Claude Code): CREATE with `--session-id <id>` the first time, but RESUME with
        // `--resume <id>` once a transcript exists. `--session-id` REFUSES an id that
        // already has state on disk ("Session ID already in use"), so using it on restore
        // was why the conversation never came back after a quit. Verified: --session-id
        // fails on an existing transcript; --resume accepts it.
        var cmd = agent?.cmd
        if let a = agent, let sessionFlag = a.sessionFlag {
            let exists = a.resumeFlag != nil && claudeSessionExists(sessionId: paneSession)
            let flag = exists ? a.resumeFlag! : sessionFlag
            cmd = "\(a.cmd) \(flag) \(paneSession)"
            RLog.log("agent launch: \(a.name) \(flag) \(paneSession) (transcript=\(exists ? "yes" : "no"))")
        }
        // Hand the agent riven's hook config on the command line rather than writing to
        // the user's own settings. Verified: --settings DEEP-MERGES `hooks`, so a user's
        // own hooks keep firing alongside ours.
        if agent?.name == "Claude Code", let settings = AgentHooksInstall.claudeSettingsPath() {
            cmd = "\(cmd ?? "claude") --settings \(shellQuote(settings))"
            if let srv = terminalTools, let cfg = srv.mcpConfigPath() {
                cmd = "\(cmd ?? "claude") --mcp-config \(shellQuote(cfg)) --append-system-prompt \(shellQuote(srv.systemPrompt()))"
            }
        } else if agent?.name == "Codex" {
            // `resume <id>` 는 서브커맨드라 반드시 옵션보다 앞에 온다. 이전 실행에서 받아 적은
            // 세션이 있으면 그 대화로 돌아가고, 없으면 새로 시작한다.
            var argv = [cmd ?? "codex"]
            if let sid = CodexSessions.sessionId(forPane: paneSession) {
                argv += ["resume", sid]
                RLog.log("agent launch: Codex resume \(sid)")
            }
            argv += AgentHooksInstall.codexLaunchOverrides().map(shellQuote)
            cmd = argv.joined(separator: " ")
        }
        // Reap an orphaned agent from a previous riven still holding this session id before
        // relaunching. claude ignores SIGHUP, so quitting riven leaves it running instead of
        // closing it; on restore `--session-id` then fails with "Session ID already in use"
        // and the conversation never comes back. Lossless: the transcript is on disk.
        //
        // This MUST run from the app, NOT wrapped into the pane's shell command: the launch
        // string contains "--session-id <id>", so the login/shell that runs it carries that
        // in its own cmdline — an in-shell `pkill -f -- '--session-id <id>'` matches and kills
        // that very shell before `exec claude` runs (v0.1.14 regression: agent panes showed
        // only the login line). Reaping from riven's own process avoids the self-match; no
        // pane shell exists for this session yet, so only the real orphan matches.
        if let a = agent, a.sessionFlag != nil { reapOrphanSession(paneSession) }
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
        // When the agent process exits and the pane falls back to a shell, it's no longer an
        // agent → drop it from the rail's agent list (and revert its tab icon to a terminal).
        tv.onCommandExited = { [weak self, weak p] in
            guard let self, let p else { return }
            p.agentExited = true
            if p.agentName == nil { p.icon = NSImage(systemSymbolName: "terminal", accessibilityDescription: nil) }
            self.refreshDockTabs()
            self.refreshRailAgents()
        }
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
            // 닫은 대화는 닫힌 채로 둔다 — 새 페인이 남의 옛 Codex 대화를 이어받으면 안 된다.
            CodexSessions.forget(pane: paneSession)
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
                // Honor the user's custom rail name (was always the raw folder name).
                let wsName = self.displayName(for: URL(fileURLWithPath: wsPath))
                Notifications.post(title: wsName, body: "\(p.title) · \(t("term.done"))", wsPath: wsPath, panelId: paneId)
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
        // Record the panel's exact spot (host group / split index / sibling extents) BEFORE
        // detaching so re-docking on window-close returns it to the SAME area+size instead of
        // dumping it as a tab on the active group. Mirrors the workspace-switch flow; no
        // normalize on detach so sibling pane sizes are preserved for the restore.
        dock.recordPlacement(of: panel)
        dock.detach(panel)                    // remove from the dock WITHOUT disposing the content
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
        // Return to the recorded spot+size; fall back to the active group only if that spot
        // is gone (e.g. its whole split was closed while popped out).
        if !entry.dock.restorePlacement(entry.panel) {
            entry.dock.addPanel(entry.panel, reference: entry.dock.activeGroup, direction: nil)
        }
    }

    // User snippets stored as prefix→body in Settings["snippets"].
    private func loadSnippets() -> [[String: String]] {
        let d = (Settings.shared.object("snippets") as? [String: String]) ?? [:]
        return d.map { ["prefix": $0.key, "body": $0.value] }
    }

    // Re-title open singleton/aux panels for the current language, then repaint tabs.
    private func relocalizeOpenPanels() {
        let key = ["search": "title.search", "git": "title.git", "preview": "title.preview", "api": "title.api", "changes": "title.changes", "notes": "title.notes", "team": "title.team"]
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

    // Off-main queue for the hook-driven change recorder (recordAgentFileEdit): file read +
    // git-baseline lookup run here so a large edit never blocks the UI. FSEvents no longer
    // feeds the Changes panel — only agent hooks do — so there's no batch path anymore.
    private let fileChangeQueue = DispatchQueue(label: "com.riven.filechange", qos: .utility)

    // Open the Changes panel (240px, right) WITHOUT stealing keyboard focus from the
    // terminal (riven's ensureChanges → restore prev active panel).
    private func ensureChangesPanel() {
        if auxDockPanels["changes"] != nil { changesPanel?.refresh(); return }
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

    // ---- native chat panes (PoC): ONE ClaudeChatSession per pane, like terminals ----
    // A new pane = a new independent agent session (the model the user asked for). Resume
    // reopens a past session id in a fresh pane.
    private func makeChatPanel(for st: WorkspaceState, resume: String? = nil, agent: String? = nil,
                               model: String? = nil, kind: ChatAgentKind = .claude) -> DockPanel {
        chatSeq += 1
        // 이 팬이 속한 워크스페이스. MCP 로 하는 일은 전부 여기에 종속된다 — 사용자가 지금
        // 어느 워크스페이스를 보고 있든 상관없이. 예전에는 활성 워크스페이스를 썼기 때문에
        // 다른 워크스페이스의 에이전트가 연 페이지가 보고 있던 화면에 떴다.
        let owner = st.url
        let chat = ChatPanel(frame: dockHost.bounds)
        chat.autoresizingMask = [.width, .height]
        chat.agentKind = kind              // 어느 CLI 로 굴릴지 — 세션을 만들기 전에 정해져 있어야 한다
        chat.agentPersona = agent
        chat.preferredModel = model        // 팬별 모델 고정 (그룹 카드에서 고른 값)
        chat.onOpenFile = { [weak self] url in self?.openFileAt(url, line: 1, column: 1) }
        chat.onOpenFileAt = { [weak self] url, line in self?.openFileAt(url, line: line, column: 1) }
        chat.onEditedFile = { [weak self] path in
            guard let self else { return }
            self.recordAgentFileEdit(workspace: st.url.path, path: path)
            // 에이전트가 마크다운을 쓰면 그 문서를 메모 패널에 띄운다. 도구로 만든 메모만
            // 보여주고 파일로 쓴 문서는 안 보여주면, 정작 결과물을 어디서 봐야 할지 알 수 없다.
            self.surfaceAgentMarkdown(path, ws: st.url)
        }
        chat.onListAgents = { [weak self] in self?.chatAgents() ?? [] }
        chat.onAgentPanes = { [weak self, weak chat] in self?.agentPanesReport(near: chat) ?? "(unavailable)" }
        chat.onAskAgent = { [weak self, weak chat] target, message, done in
            self?.askAgentPane(target, message, from: chat, done)
        }
        chat.onAskAgents = { [weak self, weak chat] tasks, done in
            self?.askAgentPanes(tasks, from: chat, done)
        }
        // 그룹 인원 조절 (MCP). 줄이는 쪽은 ChatPanel 이 확인 카드를 받은 뒤에만 부른다.
        chat.onGroupAddAgent = { [weak self] group, name, persona, model, parent in
            guard let self else { return "unavailable" }
            guard self.liveAgentGroups().contains(where: { $0.group == group }) else {
                return "no such group: \(group). Open groups: " + self.liveAgentGroups().map { $0.group }.joined(separator: ", ")
            }
            self.addAgentToGroup(group, name: name, persona: persona, model: model, parent: parent)
            return "added \(name) to \(group)"
        }
        chat.onGroupRemoveAgent = { [weak self] group, name in
            guard let self else { return "unavailable" }
            self.removeAgentFromGroup(group, name)
            return "removed \(name) from \(group)"
        }
        chat.onGroupDelete = { [weak self] group in self?.deleteGroup(group) ?? "unavailable" }
        chat.onAgentExists = { [weak self, weak chat] name in
            guard let self else { return false }
            let q = name.trimmingCharacters(in: .whitespaces).lowercased()
            return self.agentPanes(near: chat).contains {
                $0.chat !== chat && ($0.chat.agentRole.lowercased() == q
                                     || ($0.chat.agentPersona ?? "").lowercased() == q
                                     || $0.panel.id.lowercased() == q)
            }
        }
        // 입력창의 @동료: 같은 그룹의 다른 팬 이름만 준다. 그룹이 아니면 빈 배열이라 @ 가
        // 아무 뜻도 갖지 않는다. 닫힌 멤버는 프로세스가 없으므로 빼고(부를 수 없다) 보여준다.
        chat.onPeers = { [weak self, weak chat] in
            guard let self, let chat, let g = chat.groupName else { return [] }
            return self.agentPanes()
                .filter { $0.chat.groupName == g && $0.chat !== chat }
                .map { $0.chat.agentRole }
        }
        chat.onPeerDesc = { [weak self, weak chat] name in
            guard let self, let chat, let g = chat.groupName else { return "" }
            guard let peer = self.agentPanes().first(where: { $0.chat.groupName == g && $0.chat.agentRole == name })
            else { return "" }
            return [peer.chat.agentPersona, peer.chat.preferredModel.map { ChatPanel.modelLabel($0) }]
                .compactMap { $0 }.joined(separator: " · ")
        }
        // 여러 명이면 한 번에 던진다. from: chat 이라 조직도에도 보낸 사람 → 받는 사람으로
        // 위임선이 흐르고, 그룹 안에서만 이름을 찾는다.
        chat.onAskPeers = { [weak self, weak chat] tasks, each, all in
            guard let self else { return }
            self.askAgentPanes(tasks, from: chat, inGroup: chat?.groupName,
                               each: { name in each(name) }, { answers in all(answers) })
        }
        chat.onOpenAgentChat = { [weak self] name in self?.newChat(agent: name) }
        chat.onFocused = { [weak self, weak chat] in self?.focusGroup(containing: chat) }
        chat.onShowEdit = { [weak self] url, old, new in self?.showChatEdit(url, oldString: old, newString: new) }
        chat.onResumeRequest = { [weak self] in self?.resumeChatSession() }
        chat.onOpenSettings = { [weak self] in self?.settingsMenu() }
        // riven tools: open a URL / capture the preview panel for the agent.
        chat.onOpenBrowser = { [weak self] url in
            guard let self else { return }
            self.ensureAux("preview", in: owner)
            self.preview(for: owner).openURLString(url)
        }
        // riven_browser_*: 한 곳에서 처리하고 결과를 콜백으로 돌려준다.
        chat.onBrowser = { [weak self] verb, args, done in
            self?.handleBrowserTool(verb, args, in: owner, done)
        }
        chat.onBrowserOrigin = { [weak self] in self?.preview(for: owner).currentOrigin ?? "" }
        chat.onScreenshot = { [weak self] url, done in
            guard let self else { done(nil); return }
            self.ensureAux("preview", in: owner)
            let p = self.preview(for: owner)
            if let url { p.openURLString(url) }
            // give the page a moment to load before snapshotting
            DispatchQueue.main.asyncAfter(deadline: .now() + (url == nil ? 0.2 : 1.6)) {
                p.capture(done)
            }
        }
        chat.onApiRequest = { [weak self] method, url, headers, body in
            guard let self else { return }
            self.ensureAux("api", in: owner)
            self.api(for: owner).run(method: method, url: url, headers: headers, body: body)
        }
        // riven layout introspection + control for the agent.
        chat.onPanels = { [weak self] in
            guard let self, let dock = self.state(for: owner).dock else { return "(no dock)" }
            var out: [String] = []
            for g in dock.groups { for p in g.panels { out.append("- id=\(p.id) kind=\(self.panelKind(p)) title=\(p.title)") } }
            return "workspace: \(owner.path)\npanels:\n" + out.joined(separator: "\n")
        }
        chat.onOpenPanel = { [weak self] kind in
            guard let self else { return "unavailable" }
            switch kind {
            case "editor": self.showEditorPane()
            case "terminal": self.newTerminal()
            case "chat": self.newChat()
            case "search", "git", "preview", "api", "changes", "notes", "team":
                guard self.ensureAux(kind, in: owner) else { return "\(kind) 을(를) 열 수 없습니다" }
            default: return "unknown kind: \(kind)"
            }
            return "opened \(kind)"
        }
        chat.onClosePanel = { [weak self] pid in
            guard let self, let dock = self.state(for: owner).dock else { return "unavailable" }
            for g in dock.groups { for p in g.panels where p.id == pid { dock.removePanel(p); self.refreshRailAgents(); return "closed \(pid)" } }
            return "no panel with id \(pid)"
        }
        chat.onWorkspaces = { [weak self] in
            guard let self else { return "(none)" }
            return self.workspaces.map { ($0 == self.workspace ? "* " : "- ") + $0.path }.joined(separator: "\n")
        }
        chat.onNoteTool = { [weak self] tool, args in
            self?.runNoteTool(tool, args, in: owner) ?? "notes unavailable"
        }
        chat.onOpenWorkspace = { [weak self] path in
            guard let self else { return "unavailable" }
            let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            if let existing = self.workspaces.first(where: { $0.path == url.path }) { self.activate(existing); return "switched to \(url.path)" }
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                let ws = self.uniqueWorkspaceURL(for: url); self.rail.addWorkspace(ws); self.activate(ws); return "opened \(url.path)"
            }
            return "not a folder: \(path)"
        }
        queueBind(chat, ws: st.url, resume: resume)
        // 아이콘·이름은 어느 CLI 인지 한눈에 보여야 한다 — 같은 워크스페이스에 Claude 챗과
        // Codex 챗이 나란히 뜨는데 둘 다 "Claude" 라고 적혀 있으면 구분할 방법이 없다.
        let icon = NSImage(systemSymbolName: kind == .codex ? kind.symbol : "bubble.left.and.text.bubble.right",
                           accessibilityDescription: nil)
        let p = DockPanel(id: "chat-\(abs(st.url.path.hashValue))-\(chatSeq)",
                          title: agent ?? (kind == .codex ? "Codex" : "Claude"),
                          icon: icon, content: chat, closable: true)
        p.chatKind = kind
        p.agentName = agent ?? kind.displayName                  // → appears in the workspace rail
        p.chatAgent = agent                                      // persisted so a restore keeps the role
        p.sessionId = resume                                     // persisted for resume-on-relaunch
        chat.onSessionId = { [weak p] sid in p?.sessionId = sid }
        let wsPath = st.url.path, paneId = p.id
        // Clear the "done" ember/attn badge — call whenever the user looks at or focuses the pane.
        let clearAttn: () -> Void = { [weak self, weak chat, weak p] in
            guard p?.badge == "attn" else { return }
            p?.badge = nil; chat?.setRingState(nil)
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: false)
            self?.refreshDockTabs(); self?.refreshRailAgents()
        }
        // Sub-agents open as REAL dock panels next to THIS chat (in its own workspace's dock, so a
        // background turn doesn't drop them into the wrong workspace). Full resize/move/tab for free.
        chat.onOpenSubagentPane = { [weak self, weak p, weak chat] id, view, title in
            guard let self, let p, let group = p.group, let dock = group.manager else { return }
            view.autoresizingMask = [.width, .height]
            let icon = NSImage(systemSymbolName: "sparkles.rectangle.stack", accessibilityDescription: nil)
            let panel = DockPanel(id: "sub-\(id)", title: title, icon: icon, content: view, closable: true)
            panel.onClose = { [weak self, weak chat] in self?.subagentPanels[id] = nil; chat?.clearSubagentRef(id) }
            // First sub-agent of this chat → open to the RIGHT of the chat. Additional ones stack
            // BELOW the previous sub-agent (split the sub-agent column vertically) instead of pushing
            // ever further right. `activate: false` so the sub-agent NEVER steals focus from the chat.
            let ref: DockGroup; let dir: DockDir
            if let last = self.lastSubagentPanel[p.id], let lg = last.group, lg.manager === dock {
                ref = lg; dir = .down
            } else {
                ref = group; dir = .right
            }
            dock.addPanel(panel, reference: ref, direction: dir, activate: false)
            self.subagentPanels[id] = panel
            self.lastSubagentPanel[p.id] = panel
        }
        chat.onCloseSubagentPanes = { [weak self, weak p] ids in
            guard let self else { return }
            for id in ids {
                if let panel = self.subagentPanels.removeValue(forKey: id), let dock = panel.group?.manager {
                    dock.removePanel(panel)
                }
            }
            if let pid = p?.id { self.lastSubagentPanel[pid] = nil }   // column reset for the next turn
        }
        p.onActivate = { [weak chat] in chat?.focusInput(); clearAttn() }   // tab/group activation
        // Clicking INTO the pane also clears it — even when it's already the active panel, where
        // focusGroup/setActive is a no-op so onActivate wouldn't fire (the lingering-完료 bug).
        chat.onFocused = { [weak self, weak chat] in self?.focusGroup(containing: chat); clearAttn() }
        p.onClose = { [weak self, weak chat, weak p] in
            // 그룹 팬이면 닫기 전에 명단에 마지막 상태(세션 id 포함)를 남긴다 — 조직도에서
            // 다시 열 때 그 세션을 --resume 으로 이어받는다.
            if let p, let g = p.chatGroup { self?.noteClosedAgent(g, p) }
            chat?.teardown()
            WorkspaceStatus.shared.clearPane(ws: wsPath, pane: paneId)
            self?.refreshRailAgents()
        }
        // Busy / done → rail + tab + completion notification (mirrors agent terminal panes).
        chat.onBusyChange = { [weak self, weak p, weak chat] busy in
            guard let self, let p else { return }
            if busy {
                if p.badge != "attn" { p.badge = "busy" }
                WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, busy: true)
            } else {
                WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, busy: false)
                // 턴이 끝났으니 사용량을 다시 읽는다 (60초 폴링만으로는 답을 받고도 한동안
                // 예전 수치가 그대로 남아 있었다).
                self.refreshUsageAfterTurn()
                // Done: if you're not watching THIS pane, raise the ember + post a banner.
                // "Watching" = the app is frontmost AND this pane is the visible/selected one in the
                // CURRENT workspace's dock (so clicking anywhere in it counts) — OR it holds focus.
                // Before, this hung on isKeyWindow + firstResponder only, so the notification kept
                // firing even while the user was looking right at the pane.
                var watching = false
                if NSApp.isActive, p.group?.manager === self.activeDock, p.group?.activePanel === p {
                    watching = true
                } else if let chat, chat.window?.isKeyWindow == true,
                          let fr = chat.window?.firstResponder as? NSView, fr.isDescendant(of: chat) {
                    watching = true
                }
                if watching {
                    p.badge = nil
                    WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: false)
                } else {
                    p.badge = "attn"
                    WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: true)
                    Notifications.post(title: self.displayName(for: URL(fileURLWithPath: wsPath)),
                                       body: "\(p.title) · \(t("term.done"))", wsPath: wsPath, panelId: paneId)
                }
            }
            chat?.setRingState(p.badge)                          // travelling-ember ring like agents
            self.refreshDockTabs(); self.refreshRailAgents()
            // 이 팬이 속한 워크스페이스의 조직도를 깨운다. teamPanel 은 "지금 보고 있는"
            // 워크스페이스의 것이라, 다른 워크스페이스의 팬이 돌기 시작하면 엉뚱한 조직도를
            // 깨우고 (없으면 새로 만들기까지) 정작 그 팬의 칩은 idle 로 남았다.
            self.state(for: URL(fileURLWithPath: wsPath)).team?.agentActivityChanged()
        }
        chat.onAttention = { [weak self, weak p, weak chat] attn in
            guard let self, let p else { return }
            // 승인 대기는 "완료"와 다른 상태다 — 문자열 badge 로는 둘 다 "attn" 이라 레일은
            // 초록 체크, 탭은 액센트 점으로 갈라졌다. 상태를 직접 넣어 세 군데가 같은 색을 쓴다.
            p.status = attn ? .waiting : .busy                   // still working after the prompt
            chat?.setRingState(p.badge)
            WorkspaceStatus.shared.setPane(ws: wsPath, pane: paneId, attn: attn)
            self.refreshDockTabs(); self.refreshRailAgents()
            self.state(for: URL(fileURLWithPath: wsPath)).team?.agentActivityChanged()   // 승인 대기 → 칩 색
        }
        chat.onTitle = { [weak self, weak p] title in
            guard let self, let p else { return }
            // 그룹 팬은 정체성이 먼저다 — "배포팀 · 구현"을 요약 제목으로 덮어쓰면 누가 누군지
            // 알 수 없다. 그룹/닉네임은 고정하고 요약은 뒤에 덧붙인다.
            if let g = p.chatGroup, let nick = p.chatNickname {
                let base = "\(g) · \(nick)"
                let short = title.trimmingCharacters(in: .whitespaces)
                p.title = short.isEmpty || short == nick ? base : "\(base) · \(short)"
            } else {
                p.title = title
            }
            self.refreshDockTabs(); self.refreshRailAgents()
        }
        return p
    }
    // Open a chat-originated edit as an inline before/after diff in the editor.
    private func showChatEdit(_ url: URL, oldString: String, newString: String) {
        openFile(url)
        guard let after = try? String(contentsOf: url, encoding: .utf8) else { return }
        let before = after.range(of: newString).map { after.replacingCharacters(in: $0, with: oldString) } ?? after
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.editor.agentDiff(path: url.path, before: before, after: after)
        }
    }
    // Human-readable kind of a dock panel (for the chat's riven_panels tool).
    private func panelKind(_ p: DockPanel) -> String {
        if p.id == "editor" { return "editor" }
        if p.content is TerminalView { return p.agentName != nil ? "agent" : "terminal" }
        if p.content is ChatPanel { return "chat" }
        if p.content is SourceControlView { return "git" }
        if p.content is SearchPanel { return "search" }
        // 워크스페이스마다 인스턴스가 따로라 종류로 본다 (=== 로 비교하면 다른 워크스페이스의
        // 패널이 "panel" 로 떨어져, 목록·복원에서 정체를 잃는다).
        if p.content is PreviewPanel { return "preview" }
        if p.content is APIClientPanel { return "api" }
        if p.content is ChangesPanel { return "changes" }
        if p.content is NotesPanel { return "notes" }
        if p.content is AgentGroupPanel { return "team" }
        return "panel"
    }
    private func newChat(agent: String? = nil, kind: ChatAgentKind = .claude) {   // 새 에이전트 대화 팬
        guard let dock = activeDock, let ws = workspace else { return }
        // 설정에서 고른 기본 모델로 시작한다. 예전에는 페인마다 ⌥메뉴로 고를 수는 있어도
        // 저장되지 않아서, 새 대화는 늘 계정 기본 모델이었다.
        // 그 CLI 의 기본을 쓴다 — Claude 모델 이름을 Codex 에 넘기면 거절당한다.
        let def = Settings.shared.string(kind == .codex ? "defaultModelCodex" : "defaultModel", "default")
        let p = makeChatPanel(for: state(for: ws), agent: agent,
                              model: def == "default" ? nil : def, kind: kind)
        // 터미널과 같은 규칙: 새 팬은 지금 그룹의 탭으로 붙인다 (예전에는 항상 오른쪽으로
        // 쪼개서, 대화를 하나 더 열 때마다 화면이 반으로 갈렸다). 그룹 생성처럼 일부러
        // 나눠야 하는 경우는 createAgentGroup 이 따로 방향을 준다.
        let host = agentPanes().first { $0.panel.group === dock.activeGroup }?.panel.group ?? dock.activeGroup
        dock.addPanel(p, reference: host, direction: nil)
        dock.setActive(p.group ?? dock.activeGroup!)
        p.content.window?.makeFirstResponder(p.content)
    }
    // Custom agents defined in .claude/agents (project + user) — usable as `claude --agent <name>`.
    private func chatAgents() -> [String] {
        guard let ws = workspace else { return [] }
        let fm = FileManager.default
        var names: [String] = []
        for dir in ["\(ws.path)/.claude/agents", "\(fm.homeDirectoryForCurrentUser.path)/.claude/agents"] {
            for f in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where f.hasSuffix(".md") {
                let n = String(f.dropLast(3)); if !names.contains(n) { names.append(n) }
            }
        }
        return names
    }
    // Pick a custom agent, then open a new native chat pane running it.
    private func newChatWithAgent() {
        let agents = chatAgents()
        guard !agents.isEmpty else {
            let a = NSAlert(); a.messageText = ".claude/agents 에 정의된 에이전트가 없습니다."
            a.informativeText = "프로젝트 또는 ~/.claude/agents 에 <이름>.md 로 에이전트를 정의하면 여기 나옵니다."; a.runModal(); return
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "Claude (기본)", action: #selector(pickAgent(_:)), keyEquivalent: "").representedObject = ""
        for name in agents {
            let item = NSMenuItem(title: name, action: #selector(pickAgent(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = name; menu.addItem(item)
        }
        menu.items.first?.target = self
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }
    @objc private func pickAgent(_ item: NSMenuItem) {
        let name = item.representedObject as? String ?? ""
        newChat(agent: name.isEmpty ? nil : name)
    }
    // Open a past session (from ~/.claude/projects/<cwd>/*.jsonl) in a NEW pane via a popup menu.
    private func resumeChatSession() {
        guard let dock = activeDock, let ws = workspace else { return }
        let sessions = claudeSessions(for: ws.path)
        guard !sessions.isEmpty else {
            let a = NSAlert(); a.messageText = "이어서 열 세션이 없습니다."; a.runModal(); return
        }
        let menu = NSMenu()
        let fmt = DateFormatter(); fmt.dateFormat = "MM/dd HH:mm"
        for s in sessions.prefix(20) {
            let title = s.title.isEmpty ? String(s.id.prefix(8)) : s.title
            let item = NSMenuItem(title: "\(title)   ·   \(fmt.string(from: s.modified))",
                                  action: #selector(pickResume(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = s.id
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)   // in:nil → screen coords
        _ = dock
    }
    @objc private func pickResume(_ item: NSMenuItem) {
        guard let sid = item.representedObject as? String, let dock = activeDock, let ws = workspace else { return }
        let p = makeChatPanel(for: state(for: ws), resume: sid)
        // 터미널과 같은 규칙: 새 팬은 지금 그룹의 탭으로 붙인다 (예전에는 항상 오른쪽으로
        // 쪼개서, 대화를 하나 더 열 때마다 화면이 반으로 갈렸다). 그룹 생성처럼 일부러
        // 나눠야 하는 경우는 createAgentGroup 이 따로 방향을 준다.
        let host = agentPanes().first { $0.panel.group === dock.activeGroup }?.panel.group ?? dock.activeGroup
        dock.addPanel(p, reference: host, direction: nil)
        dock.setActive(p.group ?? dock.activeGroup!)
    }
    // This workspace's Claude session transcripts, newest first — with a title from the first
    // user message so the user knows which conversation to resume.
    private struct ChatSessionInfo { let id: String; let modified: Date; let title: String }
    private func claudeSessions(for cwd: String) -> [ChatSessionInfo] {
        // Claude encodes the cwd as the project dir name: every non-alphanumeric → "-".
        let enc = cwd.map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects/\(enc)")
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir,
                includingPropertiesForKeys: [.contentModificationDateKey]) else { return [] }
        return files.filter { $0.pathExtension == "jsonl" }.compactMap { url in
            let m = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return ChatSessionInfo(id: url.deletingPathExtension().lastPathComponent, modified: m,
                                   title: Self.transcriptTitle(url))
        }.sorted { $0.modified > $1.modified }
    }
    // First user message text from a transcript jsonl (scans the first lines only).
    private static func transcriptTitle(_ url: URL) -> String {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        for line in text.split(separator: "\n").prefix(60) {
            guard let d = line.data(using: .utf8),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  o["type"] as? String == "user",
                  let msg = o["message"] as? [String: Any] else { continue }
            var s = ""
            if let str = msg["content"] as? String { s = str }
            else if let arr = msg["content"] as? [[String: Any]] {
                s = arr.compactMap { $0["text"] as? String }.joined(separator: " ")
            }
            s = s.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
            if s.hasPrefix("/") || s.hasPrefix("<") { continue }   // skip slash commands / injected context
            if !s.isEmpty { return String(s.prefix(48)) }
        }
        return ""
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
    /// ⌘⇧] / ⌘⇧[ — 지금 그룹의 패널 탭을 넘긴다. 예전에는 터미널 패널만 대상이라
    /// 채팅·에이전트 탭 사이에서는 아무 일도 일어나지 않았다.
    private func cycleTerminal(_ delta: Int) {
        if let g = activeDock?.activeGroup, g.panels.count > 1 {
            let panels = g.panels
            let idx = panels.firstIndex { $0.id == g.activePanel?.id } ?? 0
            let next = panels[(idx + delta + panels.count) % panels.count]
            g.select(id: next.id)
            focusPanelContent(next)
            return
        }
        // 탭이 하나뿐인 그룹이면 예전처럼 터미널 팬들 사이를 돈다.
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
        if let p = b.activePanel { focusPanelContent(p) }   // handles editor/terminal/chat uniformly
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
        guard let ws = workspace else { return editorDockPanel ?? DockPanel(id: "editor", title: t("title.editor"), content: NSView()) }
        let st = state(for: ws)
        if st.editorPanel == nil {
            let host = st.editorHost
            host.translatesAutoresizingMaskIntoConstraints = true
            host.autoresizingMask = [.width, .height]
            let p = DockPanel(id: "editor", title: t("title.editor"),
                icon: NSImage(systemSymbolName: "curlybraces", accessibilityDescription: nil),
                content: host, closable: true)
            p.onClose = { [weak self] in self?.closeAllEditorTabs() }
            st.editorPanel = p
        }
        editorDockPanel = st.editorPanel     // "the editor panel of the CURRENT workspace"
        adoptEditor(into: st)
        return st.editorPanel!
    }
    /// 이 워크스페이스의 브라우저. 필요할 때 만들고 그 뒤로는 이 워크스페이스에 붙어 있는다.
    /// 하나를 돌려 쓰면 다른 워크스페이스의 에이전트가 연 페이지가 지금 보고 있는
    /// 워크스페이스에 뜬다 (실제로 그렇게 남의 화면에 떴다).
    /// 이 워크스페이스의 API 패널. 요청 기록이 그 프로젝트의 것이라 따로 둔다.
    func api(for ws: URL) -> APIClientPanel {
        let st = state(for: ws)
        if let a = st.api { return a }
        let a = APIClientPanel(frame: .zero)
        st.api = a
        return a
    }

    /// 이 워크스페이스의 에이전트 그룹 패널.
    func team(for ws: URL) -> AgentGroupPanel {
        let st = state(for: ws)
        if let t = st.team { return t }
        let p = AgentGroupPanel(frame: .zero)
        p.agentsProvider = { [weak self] in self?.chatAgents() ?? [] }
        p.onCreate = { [weak self] group, specs in self?.createAgentGroup(group, specs) }
        // 활성 그룹 칩·조직도는 살아있는 팬에서 그대로 읽는다 (별도 상태를 두면 어긋난다).
        p.groupsProvider = { [weak self] in self?.liveAgentGroups() ?? [] }
        p.onFocusAgent = { [weak self] group, name in self?.focusAgentPane(group, name) }
        p.onEditAgent = { [weak self] group, old, name, model, parent, avatar in
            self?.editAgentPane(group, old, name: name, model: model, parent: parent, avatar: avatar)
        }
        p.onAddAgent = { [weak self] group, name, persona, model, parent, avatar in
            self?.addAgentToGroup(group, name: name, persona: persona, model: model,
                                  parent: parent, avatar: avatar)
        }
        p.onRemoveAgent = { [weak self] group, name in self?.removeAgentFromGroup(group, name) }
        p.onDeleteGroup = { [weak self] group in self?.deleteGroup(group) }
        // 팀 입력줄: 여러 명이면 한 번에 던진다 (askAgentPanes 는 전원을 같은 런루프 턴에
        // 출발시키므로 실제로 동시에 돈다). 답은 각 에이전트의 패널에 그대로 남는다.
        // 조직도 상태 칩이 읽는 값 — 살아 있는 팬만 훑는다 (명단/Settings 를 건드리지 않는다).
        p.statusProvider = { [weak self] group in
            guard let self else { return [:] }
            var out: [String: (state: AgentRunState, since: Date?)] = [:]
            for p in self.agentPanes() where p.chat.groupName == group {
                out[p.chat.agentRole] = (p.chat.runState, p.chat.runStateSince)
            }
            return out
        }
        st.team = p
        return p
    }

    /// 이 워크스페이스의 탐색기. 사이드바에 늘 보이는 뷰라, 그 워크스페이스를 한 번이라도
    /// 연 뒤에만 만든다. 펼쳐 둔 폴더와 스크롤 위치가 워크스페이스마다 유지된다.
    func explorer(for ws: URL) -> FileTreeView {
        let st = state(for: ws)
        if let e = st.explorer { return e }
        let e = FileTreeView(frame: NSRect(x: 0, y: 0, width: 220, height: 480))
        e.onOpenFile = { [weak self] url in self?.openFile(url) }
        e.onOpenAsNote = { [weak self] url in
            guard let self else { return }
            self.ensureAux("notes", in: ws)
            self.notes(for: ws).open(url)
        }
        e.onChanged = { [weak self] in self?.refreshGit() }
        e.onFileDeleted = { [weak self] url in
            guard let self else { return }
            if self.tabBar.tabs.contains(url.path) { self.closeTab(url.path) }
        }
        e.onFileRenamed = { [weak self] old, new in
            guard let self else { return }
            if self.tabBar.tabs.contains(old.path) {
                self.closeTab(old.path)
                self.openFile(new)
            }
        }
        e.setRoot(ws)
        st.explorer = e
        return e
    }

    /// 검색 패널 (워크스페이스마다). 검색어와 결과가 그대로 남는다.
    func search(for ws: URL) -> SearchPanel {
        let st = state(for: ws)
        if let p = st.search { return p }
        let p = SearchPanel(frame: .zero)
        p.onOpen = { [weak self] path, line, col in
            self?.openFileAt(URL(fileURLWithPath: path), line: line, column: col)
        }
        p.setRoot(ws)
        st.search = p
        return p
    }

    /// 소스 컨트롤 (워크스페이스마다). 고른 diff 와 그래프 위치가 유지된다.
    func git(for ws: URL) -> SourceControlView {
        let st = state(for: ws)
        if let g = st.git { return g }
        let changes = GitPanel(frame: .zero)
        changes.onOpenDiff = { [weak self] rel in self?.openGitDiff(rel) }
        let g = SourceControlView(changes: changes)
        g.graph.onOpenFile = { [weak self] rel in
            self?.openFile(URL(fileURLWithPath: ws.path).appendingPathComponent(rel))
        }
        g.setRoot(ws)
        st.git = g
        return g
    }

    /// 에이전트 변경 사항 (워크스페이스마다).
    func changes(for ws: URL) -> ChangesPanel {
        let st = state(for: ws)
        if let c = st.changes { return c }
        let c = ChangesPanel(frame: .zero)
        c.onOpen = { [weak self] path in self?.openAgentEdit(path) }
        c.onReverted = { [weak self] path in self?.reloadIfOpen(path) }
        c.setWorkspace(ws)
        st.changes = c
        return c
    }

    /// 이 워크스페이스의 메모 패널. 브라우저와 같은 이유로 워크스페이스마다 따로 둔다.
    func notes(for ws: URL) -> NotesPanel {
        let st = state(for: ws)
        if let n = st.notes { return n }
        let n = NotesPanel(frame: .zero)
        n.setWorkspace(ws)
        st.notes = n
        return n
    }

    func preview(for ws: URL) -> PreviewPanel {
        let st = state(for: ws)
        if let p = st.preview { return p }
        let p = PreviewPanel(frame: .zero)
        p.workspaceRoot = ws
        p.onFocused = { [weak self, weak p] in self?.focusGroup(containing: p) }
        // 캡처 → 그 워크스페이스에서 돌고 있는 에이전트에게 PNG 경로를 넣어 준다.
        p.onCapture = { [weak self] path in self?.deliverToAgent(" " + path + " ") }
        // 마지막 탭을 닫으면 이 워크스페이스의 브라우저 패널도 닫는다 (× 를 누른 것과 같다).
        p.onRequestClose = { [weak self] in
            guard let self, let st = self.states[ws],
                  let panel = st.auxPanels["preview"], let dock = st.dock else { return }
            dock.removePanel(panel)
        }
        st.preview = p
        p.restoreLastURL()
        return p
    }

    private func sharedAuxView(_ id: String, ws: URL) -> NSView {
        switch id {
        case "search": return search(for: ws)
        case "git": return git(for: ws)
        case "preview": return preview(for: ws)
        case "api": return api(for: ws)
        case "changes": return changes(for: ws)
        case "notes": return notes(for: ws)
        case "team": return team(for: ws)
        // 여기 빠진 id는 빈 NSView가 호스트에 덮여 패널이 통째로 클릭 불능이 된다
        // (team이 빠져 있어 에이전트 그룹의 모든 클릭이 먹혔다). 새 aux 패널을 추가하면
        // makeAuxPanel과 여기 둘 다 등록할 것.
        default: return NSView()
        }
    }
    /// Point a shared aux panel at this workspace (they hold per-workspace roots).
    private func refreshAuxRoot(_ id: String, ws: URL) {
        switch id {
        case "search": break
        case "git": break
        case "changes": break
        case "notes": break                    // 워크스페이스마다 따로라 다시 가리킬 것이 없다
        case "preview": break                  // 워크스페이스마다 따로라 다시 가리킬 것이 없다
        default: break
        }
    }
    /// Move a shared panel view into a workspace's host container (one view; cheap).
    private func adopt(_ view: NSView, into host: NSView) {
        // 호스트에는 하나만 있어야 한다. 예전 것을 안 걷으면 뷰가 쌓이고, 나중에 붙은 것이
        // 위를 덮는다 — 워크스페이스를 오갈 때 남의 탐색기가 그대로 보이던 원인이다
        // (돌아왔을 때는 이미 붙어 있어 early return 에 걸려 아무 일도 하지 않았다).
        for v in host.subviews where v !== view { v.removeFromSuperview() }
        guard view.superview !== host else { return }
        view.removeFromSuperview()
        view.frame = host.bounds
        view.autoresizingMask = [.width, .height]
        view.translatesAutoresizingMaskIntoConstraints = true
        host.addSubview(view)
    }
    /// Move the shared editor view into this workspace's host container (cheap: one view, and its
    /// subtree is a single hosted WKWebView).
    private func adoptEditor(into st: WorkspaceState) {
        guard editorPane.superview !== st.editorHost else { return }
        editorPane.removeFromSuperview()
        editorPane.frame = st.editorHost.bounds
        editorPane.autoresizingMask = [.width, .height]
        st.editorHost.addSubview(editorPane)
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
                // Tabs are APPENDED as their content arrives, and the active tab is re-pushed
                // separately by EditorView — so the strip ended up in load order (t2,t3,t1), not the
                // user's order. Re-assert the canonical order once every model exists.
                ed.setTabs(cur.openTabs, active: cur.activeTab) { _ in }
            }
        }
    }
    // Set while a workspace is being restored/activated: the layout code calls setActive on
    // several panels (editor tabs, aux) which would each steal keyboard focus — so the LAST
    // panel restored (usually the editor) ended up focused instead of the pane the user was
    // on. Suppress focus during activation; activate() applies the intended focus at the end.
    private var suppressAutoFocus = false
    private func dockActivePanelChanged(_ p: DockPanel?, click: Bool = false) {
        guard let p else { return }
        refreshRailAgents()   // pane added/closed/switched → keep the rail's agent rows in sync
        guard !suppressAutoFocus else { return }
        // 클릭으로 활성화된 경우엔 강제 포커스를 걸지 않는다 — 클릭 지점(트랜스크립트 본문,
        // 코드블록 등)이 스스로 포커스를 가져간다. 여기서 입력창을 잡아채면 드래그 선택이
        // 끊긴다. 클릭 지점이 포커스를 못 받는 여백이면 Dock 쪽에서 한 번 더 불러 보정한다.
        if click { return }
        // Terminals carry an onActivate (makeFirstResponder + clear attn). Editor/aux panels
        // don't, so without this fallback setActive would move the ring but leave the window
        // FIRST RESPONDER on the just-closed view (or nil) — focus "disappeared". Route every
        // panel type through a real focus so activation always lands somewhere.
        if p.onActivate != nil { p.onActivate?() } else { focusPanelContent(p) }
    }

    // Give keyboard focus to a panel's content, by type: terminal → ghostty focus, editor →
    // Monaco focus (JS), anything else → make it first responder. Used on activation, on
    // close-survivor, on workspace return, and on app re-activation so focus is never lost.
    private func focusPanelContent(_ p: DockPanel) {
        if p.id == "editor" { editor.focusEditor() }
        else if let tv = p.content as? TerminalView { tv.focusTerminal() }
        else if let chat = p.content as? ChatPanel { chat.focusPending() }  // 카드가 있으면 카드, 없으면 입력창
        else if p.id == "preview" { previewPanel.focusWeb() }               // 브라우저는 웹뷰가 포커스를 받아야 ⌘C 가 먹는다
        else { p.content.window?.makeFirstResponder(p.content) }
    }
    // Focus the active dock's active panel (the one the ring is on).
    private func focusActivePanel() {
        if let p = activeDock?.activeGroup?.activePanel { focusPanelContent(p) }
    }

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
    /// 저장된 키 하나를 워크스페이스 URL 한 형태로 모은다.
    ///
    /// 받아 주는 것: 맨 경로("/a/b"), 파일 URL("file:///a/b/"), 그리고 일부러 나눈 사본의
    /// 조각("file:///a/b/#2"). 조각은 살려 둔다 — 같은 폴더를 둘로 열어 둔 사람의 두 번째
    /// 카드가 사라지면 그건 고친 게 아니라 잃은 것이다.
    static func canonicalWorkspaceURL(_ key: String) -> URL {
        let parsed = URL(string: key)
        let fragment = parsed?.fragment
        let path = parsed?.isFileURL == true ? parsed!.path : (parsed?.scheme == nil ? (parsed?.path ?? key) : key)
        // standardizedFileURL 은 쓰지 않는다 — /private/tmp 를 /tmp 로 바꿔 버려서, 고쳐야 할
        // 것(끝 슬래시·scheme)이 아닌 경로까지 손댄다. 여기서 맞추려는 건 형태이지 위치가 아니다.
        let base = URL(fileURLWithPath: path, isDirectory: true)
        guard let fragment, !fragment.isEmpty,
              let withFrag = URL(string: base.absoluteString + "#" + fragment) else { return base }
        return withFrag
    }

    private func uniqueWorkspaceURL(for canon: URL) -> URL {
        if !workspaces.contains(canon) { return canon }
        var n = 2
        while let u = URL(string: canon.absoluteString + "#\(n)") {
            if !workspaces.contains(u) { return u }
            n += 1
        }
        return canon
    }

    /// 패널을 그대로 들고 있을 워크스페이스 수. 워크스페이스마다 패널을 따로 두면 편한
    /// 대신, 여러 곳을 오갈수록 메모리가 쌓인다 (12곳에 전부 열어 보니 199MB → 536MB 였다).
    /// 최근에 본 몇 곳만 남기고 나머지는 놓아준다 — 돌아가면 그 자리에 다시 만들어진다.
    private static let warmWorkspaces = Int(ProcessInfo.processInfo.environment["RIVEN_WARMWS"] ?? "") ?? 3

    /// 오래 안 본 워크스페이스의 패널을 놓아준다.
    private func trimColdWorkspaces() {
        let live = states.filter { $0.key != workspace && $0.value.hasPanels }
        guard live.count > Self.warmWorkspaces else { return }
        let cold = live.sorted { $0.value.lastUsed > $1.value.lastUsed }.dropFirst(Self.warmWorkspaces)
        for (url, st) in cold {
            st.releasePanels()
            RLog.log("workspace: released panels for \(url.lastPathComponent) (cold)")
        }
    }

    private func state(for url: URL) -> WorkspaceState {
        if let s = states[url] { return s }
        let s = WorkspaceState(url: url); states[url] = s; return s
    }

    // Make a workspace active: swap in this workspace's dock (its own terminals +
    // layout), move the shared editor into it, restore tabs, re-root explorer/git.
    // Build the agent-pane rows shown under a workspace in the rail (Orca-style). Only agent
    // panes (Claude Code / Codex) are listed; their status comes from the pane's badge, which
    // the hook/activity layer keeps current even for non-visible workspaces.
    private func railAgents(for url: URL) -> [WorkspaceRail.RailAgent] {
        guard let dock = states[url]?.dock else { return [] }
        var out: [WorkspaceRail.RailAgent] = []
        var seen = Set<String>()   // dedup by pane id (a pane must never yield two rows)
        for g in dock.groups {
            for p in g.panels {
                guard p.content is TerminalView || p.content is ChatPanel, !seen.contains(p.id) else { continue }
                // Skip panes whose agent has EXITED (now a plain shell) — a terminal must not
                // stay listed as an agent just because it once ran one.
                if p.agentExited { continue }
                // An "agent" is EITHER a pane launched as one (Claude Code / Codex button) OR a
                // plain terminal where the user typed `claude`/`codex` and it proved itself by
                // delivering a hook (hook-backed).
                let hookAgent = p.sessionId.map { PaneSessionRegistry.shared.isHookBacked($0) } ?? false
                guard p.agentName != nil || hookAgent else { continue }
                seen.insert(p.id)
                let title = p.title.isEmpty ? (p.agentName ?? "claude") : p.title
                let sub = (p.agentName != nil && p.title != p.agentName) ? p.agentName : nil
                // Glyph from the button agent name, else the hook-learned kind (hand-typed).
                let sym = agentGlyph(kind: p.agentName) ?? agentGlyph(kind: p.hookAgentKind)
                // 역할이 있는 채팅 팬만 아바타를 쓴다. 터미널 팬은 어떤 CLI 인지가 더 중요해서
                // 종류 글리프(sparkles/code)를 그대로 둔다.
                let avatar = p.content is ChatPanel ? p.avatarKey : nil
                out.append(.init(paneId: p.id, title: title, subtitle: sub, activity: p.status,
                                 iconSymbol: sym, avatarKey: avatar,
                                 avatarOverride: p.content is ChatPanel ? p.chatAvatar : nil))
            }
        }
        return out
    }
    // Push every workspace's agent rows + the focused-agent highlight to the rail. Cheap: the
    // rail no-ops when a workspace's list is unchanged.
    private func refreshRailAgents() {
        for ws in workspaces { rail.setAgents(ws, railAgents(for: ws)) }
        if let ws = workspace, let p = activeDock?.activeGroup?.activePanel, p.agentName != nil {
            rail.setActiveAgent(ws, p.id)
        } else {
            rail.setActiveAgent(workspace, nil)
        }
    }

    /// 디버그 전용: 한 멤버의 아바타가 세 군데(팬 / 명단 / 레일)에서 같은 값으로 읽히는지.
    private func logAvatarState(_ name: String, tag: String) {
        let pane = agentPanes().first { $0.chat.agentRole == name }
        let saved = workspace.flatMap { ws in
            savedRoster(ws, "배포팀").first { $0["name"] == name }?["avatar"]
        }
        let rail = workspace.flatMap { ws in railAgents(for: ws).first { $0.title.hasSuffix(name) } }
        let spec = AgentAvatar.spec(for: name, override: pane?.panel.chatAvatar)
        RLog.log("AVATAR \(tag) pane=\(pane?.panel.chatAvatar ?? "auto") roster=\(saved ?? "-") "
               + "rail=\(rail?.avatarOverride ?? "auto") "
               + "resolved=\(AgentAvatar.symbolName(index: spec.glyph))/\(spec.color)")
    }

    /// 디버그 전용: 창을 컴포지터에서 그대로 떠서 PNG 로 남긴다. 뷰를 다시 그리는
    /// cacheDisplay 와 달리 지금 걸려 있는 CALayer 애니메이션(shimmer 마스크·펄스)의 한
    /// 프레임이 그림에 남아서, 애니메이션이 실제로 붙었는지 눈으로 확인할 수 있다.
    /// 팝오버는 별도의 창이라 메인 창만 뜨면 안 잡힌다 — 지금 떠 있는 팝오버 창을 따로 뜬다.
    private func debugPopoverSnapshot(to path: String) {
        guard let pop = NSApp.windows.first(where: {
            $0.isVisible && String(describing: type(of: $0)).contains("Popover")
        }) else { RLog.log("AVATAR no popover window"); return }
        debugWindowSnapshot(to: path, window: pop)
    }

    private func debugWindowSnapshot(to path: String, window override: NSWindow? = nil) {
        guard let win = override ?? window else { return }
        if let img = CGWindowListCreateImage(.null, .optionIncludingWindow,
                                             CGWindowID(win.windowNumber),
                                             [.boundsIgnoreFraming, .bestResolution]),
           let d = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) {
            try? d.write(to: URL(fileURLWithPath: path))
            RLog.log("STATUSSHOT wrote \(path)")
            return
        }
        // 화면 캡처가 막혀 있으면 뷰 계층을 직접 그려서라도 남긴다 (애니메이션은 안 잡힌다).
        guard let v = win.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
        v.cacheDisplay(in: v.bounds, to: rep)
        if let d = rep.representation(using: .png, properties: [:]) {
            try? d.write(to: URL(fileURLWithPath: path))
        }
        RLog.log("STATUSSHOT fallback \(path)")
    }

    // Account popover from the status-bar account chip: identity + sync + sign-out, instead
    // of opening the whole Settings window.
    private var accountPopover: NSPopover?
    private func showAccountPopover() {
        let auth = SupabaseAuth.shared
        guard auth.isSignedIn else { settingsMenu(); return }   // signed out → Settings (sign-in lives there)
        let pop = NSPopover(); accountPopover = pop
        pop.behavior = .transient

        let box = NSView()
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: "person.crop.circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 24, weight: .regular))
        icon.contentTintColor = Theme.accent
        icon.translatesAutoresizingMaskIntoConstraints = false
        let name = NSTextField(labelWithString: auth.displayName ?? "riven")
        name.font = UIScale.font(UIScale.title, .semibold); name.textColor = Theme.fg
        name.lineBreakMode = .byTruncatingTail; name.translatesAutoresizingMaskIntoConstraints = false
        let email = NSTextField(labelWithString: auth.email ?? "")
        email.font = UIScale.font(UIScale.small); email.textColor = Theme.fgDim
        email.lineBreakMode = .byTruncatingTail; email.isHidden = (auth.email == nil)
        email.translatesAutoresizingMaskIntoConstraints = false

        let hair = NSView(); hair.wantsLayer = true; hair.layer?.backgroundColor = Theme.hairline.cgColor
        hair.translatesAutoresizingMaskIntoConstraints = false

        let sync = NSTextField(labelWithString: "설정 자동 동기화")
        sync.font = UIScale.font(UIScale.small); sync.textColor = Theme.fgDim
        sync.translatesAutoresizingMaskIntoConstraints = false
        let syncBtn = NSButton(title: "지금 동기화", target: self, action: #selector(accountSyncNow))
        syncBtn.isBordered = false; syncBtn.font = UIScale.font(UIScale.small, .medium)
        syncBtn.contentTintColor = Theme.accent
        syncBtn.translatesAutoresizingMaskIntoConstraints = false
        (syncBtn.cell as? NSButtonCell)?.highlightsBy = []

        let logout = NSButton(title: " 로그아웃", target: self, action: #selector(accountLogout))
        logout.image = NSImage(systemSymbolName: "rectangle.portrait.and.arrow.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
        logout.imagePosition = .imageLeading; logout.isBordered = false
        logout.font = UIScale.font(UIScale.body); logout.contentTintColor = Theme.danger
        logout.alignment = .left; logout.translatesAutoresizingMaskIntoConstraints = false
        (logout.cell as? NSButtonCell)?.highlightsBy = []

        [icon, name, email, hair, sync, syncBtn, logout].forEach { box.addSubview($0) }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
            icon.topAnchor.constraint(equalTo: box.topAnchor, constant: 14),
            name.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            name.topAnchor.constraint(equalTo: icon.topAnchor, constant: 0),
            name.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor, constant: -14),
            email.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            email.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 2),
            email.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor, constant: -14),
            hair.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
            hair.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -12),
            hair.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 12),
            hair.heightAnchor.constraint(equalToConstant: 1),
            sync.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
            sync.centerYAnchor.constraint(equalTo: syncBtn.centerYAnchor),
            syncBtn.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -12),
            syncBtn.topAnchor.constraint(equalTo: hair.bottomAnchor, constant: 10),
            logout.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
            logout.topAnchor.constraint(equalTo: syncBtn.bottomAnchor, constant: 8),
            logout.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -12)
        ])
        let vc = NSViewController(); vc.view = box
        pop.contentViewController = vc
        pop.contentSize = NSSize(width: 250, height: 130)
        let anchor = statusBar.accountAnchor
        pop.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .maxY)
    }
    @objc private func accountSyncNow() { SupabaseAuth.shared.pull(); SupabaseAuth.shared.push() }
    @objc private func accountLogout() {
        SupabaseAuth.shared.signOut()
        statusBar.setAccount(nil)
        accountPopover?.close(); accountPopover = nil
    }

    // Clicking a notification banner lands here: switch to the pane's workspace, focus the
    // pane, and clear its attention. Previously clicks did nothing (no userInfo / no handler).
    private func revealPane(wsPath: String, panelId: String) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        guard let url = states.keys.first(where: { $0.path == wsPath }) ?? workspaces.first(where: { $0.path == wsPath }) else { return }
        if workspace != url {
            // Switching: let activate() focus the target pane AT THE END (after rebuildTabs),
            // otherwise the editor restore would steal focus back (the "reveal from another
            // workspace doesn't focus the pane" bug).
            activate(url, focusPaneId: panelId)
        } else {
            guard let dock = activeDock,
                  let panel = dock.groups.flatMap({ $0.panels }).first(where: { $0.id == panelId }),
                  let g = panel.group else { return }
            // 그룹만 활성화하면 그 그룹의 다른 탭이 보이는 채로 끝난다 — 누른 패널의 탭으로
            // 실제로 넘어가야 한다 (이미 그 탭이면 select 가 값싸게 빠져나온다).
            g.select(id: panel.id)
            dock.setActive(g)
            focusPanelContent(panel)
        }
        // Looking at it clears the attention badge + ring + rail dot.
        if let panel = activeDock?.groups.flatMap({ $0.panels }).first(where: { $0.id == panelId }) {
            panel.badge = nil
            (panel.content as? TerminalView)?.setRingState(nil)
        }
        WorkspaceStatus.shared.setPane(ws: wsPath, pane: panelId, attn: false)
        refreshDockTabs()
    }

    // The name to show for a workspace: the user's custom rail name if set, else the folder.
    private func displayName(for url: URL) -> String {
        // Match by PATH, not URL identity: the stored keys are directory URLs (trailing "/"), so a
        // URL(fileURLWithPath:) rebuilt from a pane's workspace path missed the entry entirely —
        // which is why notifications fell back to the raw folder name after a rename.
        var custom = workspaceNames[url]?.trimmingCharacters(in: .whitespacesAndNewlines)
        if custom?.isEmpty != false {
            let p = url.standardizedFileURL.path
            custom = workspaceNames.first { $0.key.standardizedFileURL.path == p }?.value
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return (custom?.isEmpty == false ? custom! : url.lastPathComponent)
    }
    // Window title + status bar + dock header for a workspace, honoring a custom name.
    private func updateWorkspaceHeader(_ url: URL) {
        let name = displayName(for: url)
        window.title = "riven · \(name)"
        statusBar.setWorkspaceName(name)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let short = url.path.hasPrefix(home) ? "~" + url.path.dropFirst(home.count) : url.path
        let hs = NSMutableAttributedString(string: name,
            attributes: [.foregroundColor: Theme.fg, .font: UIScale.font(UIScale.body, .medium)])
        hs.append(NSAttributedString(string: "   \(short)",
            attributes: [.foregroundColor: Theme.fgDim, .font: UIScale.font(UIScale.small)]))
        headerLabel?.attributedStringValue = hs
    }
    // RIVEN_SWITCH_BENCH=<n>: switch back and forth n times and log each activate() duration, so
    // the switch path can be measured without a human clicking (and with real panes: chat, editor
    // tabs, terminals). Debug-only; never runs unless the env var is set.
    // RIVEN_RESIZE_BENCH=<n>: drag a dock divider n times and log how long each step takes, so the
    // resize path can be measured without a human holding the mouse.
    private func runResizeBench() {
        guard let n = ProcessInfo.processInfo.environment["RIVEN_RESIZE_BENCH"].flatMap(Int.init) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self, let dock = self.activeDock,
                  let sv = dock.container.subviews.compactMap({ $0 as? NSSplitView }).first,
                  sv.arrangedSubviews.count >= 2 else { RLog.log("RESIZEBENCH no split"); return }
            // Measure BOTH splits, and include the display pass — a drag repaints every frame, so
            // layout alone understates it.
            func run(_ label: String, _ target: NSSplitView) {
                var times: [Double] = []
                let base = target.arrangedSubviews[0].frame.size
                let start = target.isVertical ? base.width : base.height
                for i in 0..<n {
                    let t0 = CFAbsoluteTimeGetCurrent()
                    target.setPosition(start + CGFloat((i % 20) * 6 - 60), ofDividerAt: 0)
                    target.layoutSubtreeIfNeeded()
                    self.window.displayIfNeeded()          // include drawing, like a real drag
                    times.append(CFAbsoluteTimeGetCurrent() - t0)
                }
                let ms = times.map { $0 * 1000 }
                RLog.log(String(format: "RESIZEBENCH[%@] n=%d avg=%.1fms max=%.1fms", label, ms.count,
                                ms.reduce(0,+) / Double(max(ms.count,1)), ms.max() ?? 0))
            }
            run("dock-first", sv)
            // The divider NEXT TO the chat pane: resizing it re-wraps every rendered message.
            if sv.arrangedSubviews.count >= 2 {
                var times: [Double] = []
                let last = sv.arrangedSubviews.count - 2
                let start = sv.arrangedSubviews[last].frame.width
                for i in 0..<n {
                    let t0 = CFAbsoluteTimeGetCurrent()
                    sv.setPosition(start + CGFloat((i % 20) * 6 - 60), ofDividerAt: last)
                    sv.layoutSubtreeIfNeeded(); self.window.displayIfNeeded()
                    times.append(CFAbsoluteTimeGetCurrent() - t0)
                }
                let ms = times.map { $0 * 1000 }
                RLog.log(String(format: "RESIZEBENCH[dock-chat] n=%d avg=%.1fms max=%.1fms", ms.count,
                                ms.reduce(0,+) / Double(max(ms.count,1)), ms.max() ?? 0))
            }
            if let body = self.bodySplit { run("sidebar", body) }
        }
    }
    // The FIRST switch to a workspace pays one-time costs (build its dock, spawn its panes) —
    // measured at ~186ms vs ~20ms for later switches, which is the "재실행 후 첫 이동이 렉" report.
    // Build those docks while the app is idle instead, one per runloop pass so the UI stays live.
    // 채팅 팬 준비(claude 프로세스 기동 + 기록 재생)는 팬 하나에 0.2~1.2초가 든다. 복원 때
    // 전부 한 런루프 턴에 몰아 하면 메인 스레드가 몇 초씩 멈춰 스피너도 안 돌고 커서가
    // 비치볼이 된다. 한 턴에 하나씩 처리해 그 사이에 화면이 갱신되게 한다.
    private var pendingBinds: [(chat: ChatPanel, ws: URL, resume: String?)] = []
    private var bindDraining = false
    private func queueBind(_ chat: ChatPanel, ws: URL, resume: String?) {
        pendingBinds.append((chat, ws, resume))
        guard !bindDraining else { return }
        bindDraining = true
        DispatchQueue.main.async { [weak self] in self?.drainBinds() }
    }
    private func drainBinds() {
        guard !pendingBinds.isEmpty else {
            bindDraining = false
            hideSwitchOverlay()          // 팬까지 다 준비된 다음에 오버레이를 내린다
            return
        }
        let job = pendingBinds.removeFirst()
        let t = Date()
        job.chat.bind(workspace: job.ws, resume: job.resume)
        if ProcessInfo.processInfo.environment["RIVEN_BOOTTIME"] != nil {
            RLog.log(String(format: "BOOT   bind %.0fms (남은 %d개)",
                            Date().timeIntervalSince(t) * 1000, pendingBinds.count))
        }
        DispatchQueue.main.async { [weak self] in self?.drainBinds() }
    }

    private func prewarmWorkspaces(except active: URL) {
        let targets = workspaces.filter { $0 != active && state(for: $0).dock == nil }
        guard !targets.isEmpty else { return }
        func step(_ i: Int) {
            guard i < targets.count, let url = targets.first(where: { $0 == targets[i] }) else { return }
            let st = state(for: url)
            if st.dock == nil {
                let d = makeDock(for: st); st.dock = d
                d.container.frame = dockHost.bounds
                d.container.autoresizingMask = [.width, .height]
                d.container.isHidden = true                 // built, not shown
                if d.container.superview !== dockHost { dockHost.addSubview(d.container) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { step(i + 1) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { step(0) }   // after the first paint
    }
    private func runSwitchBench() {
        guard let n = ProcessInfo.processInfo.environment["RIVEN_SWITCH_BENCH"].flatMap(Int.init),
              workspaces.count >= 2 else { return }
        var times: [Double] = []
        func step(_ i: Int) {
            guard i < n else {
                let ms = times.map { $0 * 1000 }
                let avg = ms.reduce(0, +) / Double(max(ms.count, 1))
                RLog.log(String(format: "SWITCHBENCH n=%d avg=%.0fms max=%.0fms all=%@",
                                ms.count, avg, ms.max() ?? 0,
                                ms.map { String(format: "%.0f", $0) }.joined(separator: ",")))
                return
            }
            let target = workspaces[i % workspaces.count]
            guard target != workspace else { step(i + 1); return }
            let t0 = CFAbsoluteTimeGetCurrent()
            activate(target)
            times.append(CFAbsoluteTimeGetCurrent() - t0)
            // next switch after the deferred tail has run, so each measurement is a clean switch
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { step(i + 1) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { step(0) }
    }

    private func activate(_ url: URL, focusPaneId: String? = nil) {
        if workspace != nil, workspace != url { showSwitchOverlay() }
        suppressAutoFocus = true   // don't let restored panels (editor/aux) steal focus; applied at the end
        if !workspaces.contains(url) { workspaces.append(url) }
        let st = state(for: url)
        st.lastUsed = Date()

        // Snapshot the OUTgoing workspace's FULL dock layout (split tree + pane sizes% +
        // panel types, incl. editor/aux still in place) so returning restores it EXACTLY —
        // not just "which aux were open". Must run BEFORE detaching the singletons below.
        if let old = workspace, old != url {
            state(for: old).openAux = Set(auxDockPanels.keys)
            // NO snapshot here. The dock stays alive with its split tree; only the shared editor/aux
            // singletons leave, and their slots are recorded above. Snapshotting on every switch made
            // the return path rebuild the whole tree (profiled: DockManager.restore → a full
            // layoutSubtreeIfNeeded over thousands of views was the rest of the switch lag).
            // `pendingLayout` now only carries a layout loaded from DISK at launch. We still take a
            // cheap snapshot for SAVING (walking the tree is not what cost time — rebuilding it was).
            state(for: old).savedLayout = activeDock?.snapshot()
            state(for: old).activePanelId = activeDock?.activeGroup?.activePanel?.id  // restore focus on return
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
        }
        auxDockPanels.removeAll()

        // Swap the dock view for this workspace's dock (create it on first visit).
        //
        // HIDE the outgoing one instead of removing it, and only addSubview a dock the FIRST time.
        // Profiling a real switch showed the cost was almost entirely
        //   activate → addSubview → _setSuperview → _setLayoutEngine (recursive)
        // — AppKit migrates the ENTIRE subtree into the window's autolayout engine on every
        // insertion, and riven's dock is thousands of views (splits, panels, chat transcript). A
        // visibility toggle keeps the tree in the engine, so switching costs nothing to re-adopt.
        activeDock?.container.isHidden = true
        let isNew = (st.dock == nil)
        let dock = st.dock ?? { let d = makeDock(for: st); st.dock = d; return d }()
        dock.container.frame = dockHost.bounds
        dock.container.autoresizingMask = [.width, .height]
        if dock.container.superview !== dockHost { dockHost.addSubview(dock.container) }
        dock.container.isHidden = false
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
        if let rawSnap = st.pendingLayout {
            st.pendingLayout = nil
            // Promote plain panes whose workspace has a claude conversation to Claude Code
            // panes (so restore resumes them) — markClaudePanes runs at save too, but old
            // snapshots were saved before folder-based promotion existed, so re-apply here.
            let snap = markClaudePanes(rawSnap, cwd: st.url.path)
            let agents = AgentDiscovery.available()
            var liveTerms = dock.groups.flatMap { $0.panels }.filter { $0.content is TerminalView }
            // Chat panes hold a LIVE `claude` subprocess. restore() drops the old views WITHOUT
            // calling onClose, so if we rebuilt them from scratch every switch we'd (a) spawn a new
            // claude + re-run loadHistory each time and (b) LEAK the previous process (orphaned,
            // still burning memory/CPU). So reuse the live pane by session id — exactly like
            // terminals reuse their shell — and only teardown the ones not carried over.
            var liveChats = dock.groups.flatMap { $0.panels }.filter { $0.content is ChatPanel }
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
                    // Agent not discovered (e.g. claude not on the GUI PATH) → fall back to a
                    // plain terminal rather than dropping the pane entirely.
                    guard let agent = agents.first(where: { $0.name == name }) else {
                        return self.makeTerminalPanel(for: st, sessionId: sid)
                    }
                    return self.makeTerminalPanel(for: st, agent: agent, sessionId: sid)   // resume this pane's session
                }
                if desc == "editor" { return self.ensureEditorPanel() }
                // chat panes: reuse the LIVE pane (keeps its claude process + rendered transcript)
                // when its session id matches; otherwise resume the persisted id, else fresh.
                if desc.hasPrefix("chat:") {
                    // sid \t nickname \t persona \t group \t parent \t model \t avatar
                    // — 짧은(구버전) 형식도 그대로 읽힌다.
                    let f = desc.dropFirst(5).components(separatedBy: "\t")
                    func fld(_ i: Int) -> String { i < f.count ? f[i] : "" }
                            let sid = fld(0), nick = fld(1), persona = fld(2), group = fld(3)
                    let parent = fld(4), model = fld(5), avatar = fld(6)
                    let kind = ChatAgentKind(rawValue: fld(7)) ?? .claude   // 빈 칸 = 예전 스냅샷 = claude
                    if !sid.isEmpty, let i = liveChats.firstIndex(where: { $0.sessionId == sid }) {
                        return liveChats.remove(at: i)          // reuse — no respawn, no reload
                    }
                    let p = self.makeChatPanel(for: st, resume: sid.isEmpty ? nil : sid,
                                               agent: persona.isEmpty ? nil : persona,
                                               model: model.isEmpty ? nil : model, kind: kind)
                    p.chatModel = model.isEmpty ? nil : model
                    p.chatAvatar = avatar.isEmpty ? nil : avatar   // 고른 아바타는 재기동해도 그대로
                    if !nick.isEmpty {                          // restore the group role
                        p.title = group.isEmpty ? nick : "\(group) · \(nick)"
                        p.agentName = nick; p.chatNickname = nick; p.chatGroup = group.isEmpty ? nil : group
                        p.chatParent = parent.isEmpty ? nil : parent
                        let chat = p.content as? ChatPanel
                        chat?.nickname = nick; chat?.groupName = group.isEmpty ? nil : group
                        chat?.parentName = parent.isEmpty ? nil : parent
                    }
                    return p
                }
                if desc == "chat" || desc.hasPrefix("chat-") {
                    // session-less chat (never sent a turn yet) — reuse the first idle live one
                    if let i = liveChats.firstIndex(where: { $0.sessionId == nil }) {
                        return liveChats.remove(at: i)
                    }
                    return self.makeChatPanel(for: st)
                }
                return self.makeAuxPanel(desc)
            }
            // Any live chat pane NOT carried into the new layout is genuinely gone — stop its
            // claude process (restore() removed the view but never called onClose).
            for stale in liveChats { (stale.content as? ChatPanel)?.teardown() }
            if restoredLayout {
                st.pendingTerminals = nil                 // 구버전 폴백 기록은 더 필요 없다
                st.openAux = Set(auxDockPanels.keys)      // 레이아웃이 배치한 aux가 곧 열린 aux
                // Focus is applied at the END of activate (after rebuildTabs, which would
                // otherwise re-focus the editor) — see the restoreFocus call below.
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
        // This workspace's aux panels live in ITS dock permanently; just move the shared views back
        // into their hosts and re-point the active map (no detach/re-insert, no tree mutation).
        auxDockPanels.removeAll()
        for (id, panel) in st.auxPanels where panel.group?.manager === dock {
            adopt(sharedAuxView(id, ws: url), into: st.auxHost(id))
            auxDockPanels[id] = panel
            refreshAuxRoot(id, ws: url)
        }
        if !restoredLayout {
            for id in ["search", "git", "preview", "changes", "api", "notes", "team"] where st.openAux.contains(id) {
                if auxDockPanels[id] == nil { toggleDockPanel(id) }
            }
        }
        // Restore this workspace's editor tabs (adds the editor panel if needed).
        rebuildTabs(for: st)

        updateWorkspaceHeader(url)
        rail.setActive(url)   // keep the highlighted card in sync with the shown workspace
        // Populate the SIDE panels (file tree, git/search/changes roots, rail agent rows) on the
        // next runloop so the dock swap + active editor tab paint FIRST — this is the heavy tail of
        // a workspace switch, and running it in the same frame is what made the switch feel janky.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.workspace == url else { return }   // bailed if switched again
            // 각 패널이 워크스페이스마다 따로라 루트를 다시 가리킬 것이 없다. 탐색기만
            // 사이드바 자리에 끼운다. 아직 안 만든 패널은 여기서도 만들지 않는다 —
            // 워크스페이스를 스무 개 열어 두고 훑기만 해도 그만큼 만들어지면 안 된다.
            self.adopt(self.explorer(for: url), into: self.explorerHost)
            self.trimColdWorkspaces()   // 오래 안 본 곳의 패널은 여기서 놓아준다
            // 워크스페이스마다 패널이 따로라 다시 가리킬 필요가 없다. 떠나는 쪽 저장만.
            self.workspace.map { self.state(for: $0).notes?.flush() }
            self.refreshRailAgents()   // this workspace's agent rows
            self.hideSwitchOverlay()
            self.refreshGit()
        }

        // NOW apply focus — after rebuildTabs (which re-adds the editor) so it can't steal it.
        // Target: an explicit reveal pane, else the pane the user last had focused here.
        suppressAutoFocus = false
        let target = focusPaneId ?? st.activePanelId
        if let tid = target,
           let panel = dock.groups.flatMap({ $0.panels }).first(where: { $0.id == tid }),
           let g = panel.group {
            dock.setActive(g)
            focusPanelContent(panel)
        } else {
            focusActivePanel()
        }

        // Agent-edit tracking: snapshot the session baseline + watch the tree so files
        // the agent writes appear in the Changes panel with before/after diffs.
        AgentEdits.shared.snapshot(workspace: url)
        agentWatch?.stop()
        agentWatch = AgentWatch(root: url) { [weak self] path in
            // The Changes panel is fed ONLY by agent hooks (recordAgentFileEdit) so it shows
            // exactly what riven's own agents edited — NOT git pull, the user's own edits, or
            // another tool (cmux etc.) touching the folder. FSEvents can't tell who wrote a
            // file, so it no longer records changes here; it only refreshes the file tree.
            if !FileNode.isIgnoredPath(path) { self?.scheduleExplorerRefresh() }
            self?.scheduleEditorReload(path)   // agent edited a file → refresh it if it's open
        }
    }
    // Debounced editor reload for files changed on disk (agent edits) while open — otherwise
    // the editor showed a stale copy until you closed & reopened the tab.
    private var pendingReload = Set<String>()
    private var reloadTimer: Timer?
    private func scheduleEditorReload(_ path: String) {
        DispatchQueue.main.async {
            guard let ws = self.workspace, self.state(for: ws).openTabs.contains(path) else { return }
            self.pendingReload.insert(path)
            self.reloadTimer?.invalidate()
            self.reloadTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
                guard let self else { return }
                for p in self.pendingReload { self.reloadIfOpen(p) }
                self.pendingReload.removeAll()
            }
        }
    }

    // Debounced explorer reload: the FS watcher bursts on writes, so coalesce (0.4s) and
    // reload the tree once, preserving expansion.
    private var explorerRefreshTimer: Timer?
    private func scheduleExplorerRefresh() {
        DispatchQueue.main.async {
            self.explorerRefreshTimer?.invalidate()
            self.explorerRefreshTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                self?.explorer?.refreshTree()
            }
        }
    }

    private func switchWorkspace(_ url: URL) { activate(url); persistSession() }

    // Close a workspace: tear down its dock + state, switch to another (or empty).
    private func closeWorkspace(_ url: URL) {
        let st0 = states[url]
        if let st = states[url] {
            // Dock containers now STAY in dockHost (hidden) across switches, so closing a workspace
            // must remove this one explicitly, and stop its chat sessions — otherwise its hidden
            // tree and its claude processes would outlive the workspace.
            st.dock?.container.removeFromSuperview()
            for p in st.dock?.groups.flatMap({ $0.panels }) ?? [] {
                (p.content as? TerminalView)?.dispose()
                (p.content as? ChatPanel)?.teardown()
            }
        }
        editor.disposePaths(st0?.openTabs ?? [])   // models stay resident across switches now
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
                explorerHost.subviews.forEach { $0.removeFromSuperview() }   // 워크스페이스 없음 → 트리도 비운다
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
                // Promote to a Claude Code pane (so restore relaunches claude) ONLY when THIS
                // pane's own session has a transcript. We must NOT promote just because the
                // folder has some claude conversation: that turned every plain terminal in a
                // claude-touched folder into a claude pane that resurrected an unrelated old
                // conversation on restart. Precise per-pane matching keeps closed sessions
                // closed and new panes fresh.
                return claudeSessionExists(sessionId: uuid) ? "term:Claude Code\t\(uuid)" : desc
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
    // True if a Claude Code transcript for this session id exists. Globs by id across all
    // project dirs — session ids are globally unique, so this is independent of how the
    // workspace path is encoded into a dir name AND of CLAUDE_CONFIG_DIR. (The old version
    // reconstructed the encoded path and silently missed non-ASCII workspaces.)
    private func claudeSessionExists(sessionId: String) -> Bool {
        guard UUID(uuidString: sessionId) != nil else { return false }
        let base = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
        let projects = base.appendingPathComponent("projects")
        guard let dirs = try? FileManager.default.contentsOfDirectory(at: projects, includingPropertiesForKeys: nil) else { return false }
        return dirs.contains { FileManager.default.fileExists(atPath: $0.appendingPathComponent("\(sessionId).jsonl").path) }
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
            // Active workspace: its live dock holds the editor/aux, so snapshot it. Inactive ones:
            // use the layout captured when we left (their live dock lost the shared singletons).
            let live = (url == workspace) ? st.dock?.snapshot() : (st.savedLayout ?? st.dock?.snapshot())
            if let snap = live {
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
        // 레일 높이는 railHeight(절대값) 하나로만 관리한다. 예전에는 여기서 비율(sidebarRail)로
        // 한 번 더 저장하고 restoreSession 에서 나중에 복원해, 기동 초반에 복원한 railHeight 를
        // 곧바로 덮어썼다 (483 로 맞춰둔 레일이 매번 222 쯤으로 되돌아가던 원인).
        var session: [String: Any] = [
            "workspaces": workspaces.map { $0.absoluteString },
            "active": workspace?.absoluteString ?? "",
            "tabs": tabs,
            "activeTab": actives,
            "colors": colors,
            "names": names,
            "layout": layouts
        ]
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
        if ProcessInfo.processInfo.environment["RIVEN_BOOTTIME"] != nil {
            RLog.log(String(format: "BOOT 복원시작 %.0fms", Date().timeIntervalSince(AppDelegate.launchedAt) * 1000))
            DispatchQueue.main.async {
                RLog.log(String(format: "BOOT 복원끝 %.0fms", Date().timeIntervalSince(AppDelegate.launchedAt) * 1000))
            }
        }
        guard let s = Settings.shared.object("session"),
              let keys = s["workspaces"] as? [String], !keys.isEmpty else { hideSwitchOverlay(); return }
        let tabs = s["tabs"] as? [String: Any] ?? [:]
        let actives = s["activeTab"] as? [String: Any] ?? [:]
        let colors = s["colors"] as? [String: String] ?? [:]
        let names = s["names"] as? [String: String] ?? [:]
        let layouts = s["layout"] as? [String: Any] ?? [:]
        let terms = s["terminals"] as? [String: [String]] ?? [:]   // 구버전 세션 (하위 호환)
        let fm = FileManager.default
        var restored: [URL] = []
        var seen = Set<String>()
        for key in keys {
            // 예전 세션은 맨 경로("/a/b"), 지금은 absoluteString("file:///a/b/") 을 저장한다.
            // 둘을 그대로 URL 로 만들면 같은 폴더가 서로 다른 URL 이 되고, 워크스페이스 상태는
            // URL 로 키를 잡으므로 같은 폴더에 카드가 둘 생긴다 — 어느 쪽을 누르냐에 따라 다른
            // 패널이 뜬다 (베타테스터가 "클릭이 이상하다" 고 한 것이 이거다). 한 번 이 상태가
            // 되면 그 폴더를 다시 열 때마다 workspaces.contains 가 빗나가 계속 늘어난다.
            // 그래서 여기서 하나의 형태로 모으고, 같은 것이 또 오면 버린다.
            let url = AppDelegate.canonicalWorkspaceURL(key)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { continue }
            // 같은 폴더가 두 번 나오면 카드는 하나로 모으되, 뒤엣것이 들고 있던 탭·레이아웃은
            // 버리지 않는다 — 둘 중 어느 쪽에 진짜 작업이 들어 있는지는 알 수 없고, 카드를
            // 합치면서 열려 있던 파일을 잃으면 그건 고친 게 아니라 잃은 것이다.
            // ("#2" 처럼 일부러 나눈 사본은 조각이 달라 애초에 겹치지 않는다.)
            guard seen.insert(url.absoluteString).inserted else {
                let st = state(for: url)
                let dupTabs = (tabs[key] as? [String] ?? []).filter { fm.fileExists(atPath: $0) }
                if st.openTabs.isEmpty { st.openTabs = dupTabs }
                else { st.openTabs.append(contentsOf: dupTabs.filter { !st.openTabs.contains($0) }) }
                if st.pendingLayout == nil { st.pendingLayout = layouts[key] as? [String: Any] }
                RLog.log("restore: 같은 폴더의 워크스페이스를 합쳤다 \(key) (탭 \(dupTabs.count)개)")
                continue
            }
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
        guard !restored.isEmpty else { hideSwitchOverlay(); return }
        workspaces = restored
        let activeKey = s["active"] as? String
        // 활성 키도 같은 형태로 맞춰서 찾는다 — 예전 형태로 저장돼 있으면 못 찾고 첫 번째로
        // 떨어져, 재시작할 때마다 보던 워크스페이스가 아닌 곳이 열렸다.
        let activeCanon = activeKey.map { AppDelegate.canonicalWorkspaceURL($0).absoluteString }
        let active = restored.first { $0.absoluteString == activeCanon } ?? restored.first!
        let tAct = Date()
        activate(active)
        if ProcessInfo.processInfo.environment["RIVEN_BOOTTIME"] != nil {
            RLog.log(String(format: "BOOT activate %.0fms (팬 %d개)",
                            Date().timeIntervalSince(tAct) * 1000,
                            activeDock?.groups.flatMap { $0.panels }.count ?? 0))
        }
        prewarmWorkspaces(except: active)
        runSwitchBench()
        runResizeBench()
        // RIVEN_ORDERDUMP=1: log the app's workspace order, the rail's order and the editor's tab
        // order 3s after restore, to see which one diverges (⌘N uses the app array; the ⌘N chip is
        // numbered from the rail's array; the tabs come from the webview).
        if ProcessInfo.processInfo.environment["RIVEN_ORDERDUMP"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                RLog.log("ORDER app=" + self.workspaces.map { $0.lastPathComponent }.joined(separator: ","))
                RLog.log("ORDER rail=" + self.rail.orderDump())
                if let ws = self.workspace {
                    RLog.log("ORDER openTabs=" + self.state(for: ws).openTabs.map { ($0 as NSString).lastPathComponent }.joined(separator: ","))
                }
                self.editor.dumpTabs { RLog.log("ORDER jsTabs=" + $0) }
            }
        }
        // RIVEN_WSSCOPE=1: 다른 워크스페이스의 에이전트가 MCP 로 연 브라우저가 그쪽
        // 워크스페이스에서 열리는지 (보고 있는 화면을 건드리지 않는지).
        if ProcessInfo.processInfo.environment["RIVEN_WSSCOPE"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                // 두 워크스페이스를 한 번씩 방문해 팬을 살려 둔 뒤, wsA 로 돌아온다.
                let other = self.workspaces.first { $0 != self.workspace }
                if let other { self.activate(other) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    if let first = self.workspaces.first { self.activate(first) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                        self.wsScopeReport()
                        // 껐다 켰을 때 브라우저가 제 워크스페이스에만 남아 있는지도 본다.
                        if ProcessInfo.processInfo.environment["RIVEN_WSSCOPE"] == "restore" {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                                for ws in self.workspaces {
                                    let st = self.state(for: ws)
                                    let open = st.auxPanels["preview"] != nil
                                    RLog.log("WSSCOPE 복원 \(ws.lastPathComponent): 브라우저패널=\(open) 주소=\(st.preview?.debugURL() ?? "-")")
                                }
                                RLog.log("WSSCOPE 복원 done")
                            }
                        }
                    }
                }
            }
        }
        // RIVEN_CLOSEBENCH=1: 패널을 닫을 때 걸리는 시간을 단계별로.
        if ProcessInfo.processInfo.environment["RIVEN_CLOSEBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, let dock = self.activeDock else { return }
                // HEAVY=1 이면 이미 복원된 무거운 채팅 탭들로만 잰다 (실사용에 가깝다).
                if ProcessInfo.processInfo.environment["RIVEN_CLOSEHEAVY"] == nil {
                    for id in ["preview", "notes", "team", "api", "changes"] where self.auxDockPanels[id] == nil {
                        self.toggleDockPanel(id)
                    }
                    self.newChat(); self.newChat()
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                    RLog.log("CLOSE 패널 수=\(dock.groups.flatMap { $0.panels }.count)")
                    // 실사용처럼: 탭들을 한 번씩 둘러본 뒤에 닫는다 (본 탭은 이미 붙어 있다).
                    if ProcessInfo.processInfo.environment["RIVEN_CLOSEVISITED"] != nil {
                        for g in dock.groups {
                            for p in g.panels { g.select(id: p.id) }
                            if let first = g.panels.first { g.select(id: first.id) }
                        }
                        RLog.log("CLOSE 탭 한 번씩 둘러봄")
                    }
                    var delay = 0.0
                    let ids = ProcessInfo.processInfo.environment["RIVEN_CLOSEHEAVY"] != nil
                        ? dock.groups.flatMap { $0.panels }.filter { $0.content is ChatPanel }.map { $0.id }
                        : ["changes", "api", "team", "notes", "preview"]
                    for id in ids {
                        delay += 1.2
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                            guard let p = dock.groups.flatMap({ $0.panels }).first(where: { $0.id == id })
                            else { return }
                            dock.removePanel(p)
                        }
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay + 1.5) { RLog.log("CLOSE done") }
                }
            }
        }
        // RIVEN_WSMANY=<n>: 워크스페이스를 여러 개 오갈 때 메모리가 어떻게 되는지.
        // 패널을 워크스페이스마다 두기로 했으니, 많이 열어도 문제가 없어야 한다.
        if let nStr = ProcessInfo.processInfo.environment["RIVEN_WSMANY"], let n = Int(nStr) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                func rss() -> Int {
                    var info = mach_task_basic_info()
                    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
                    let kr = withUnsafeMutablePointer(to: &info) {
                        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
                        }
                    }
                    return kr == KERN_SUCCESS ? Int(info.resident_size) / 1_048_576 : -1
                }
                RLog.log("WSMANY 시작 RSS=\(rss())MB")
                var dirs: [URL] = []
                for i in 0..<n {
                    let d = URL(fileURLWithPath: "/private/tmp/wsmany/ws\(i)")
                    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
                    dirs.append(d)
                }
                var step = 0.0
                // 1) 그냥 훑기 — 패널을 열지 않고 워크스페이스만 오간다.
                for d in dirs {
                    step += 0.6
                    DispatchQueue.main.asyncAfter(deadline: .now() + step) { self.activate(d) }
                }
                step += 1.5
                DispatchQueue.main.asyncAfter(deadline: .now() + step) {
                    RLog.log("WSMANY \(n)곳 훑은 뒤 RSS=\(rss())MB (탐색기만 생김)")
                }
                // 2) 각 워크스페이스에서 패널을 전부 열어 본다 — 최악의 경우.
                for d in dirs {
                    step += 1.2
                    DispatchQueue.main.asyncAfter(deadline: .now() + step) {
                        self.activate(d)
                        for id in ["search", "git", "changes", "notes", "api", "team", "preview"] {
                            self.ensureAux(id, in: d)
                        }
                    }
                }
                step += 3
                DispatchQueue.main.asyncAfter(deadline: .now() + step) {
                    let warm = self.workspaces.filter { self.states[$0]?.hasPanels == true }
                    RLog.log("WSMANY \(n)곳에 패널 전부 연 뒤 RSS=\(rss())MB 패널유지=\(warm.count)곳")
                }
                // 계속 오가도 늘지 않는지 (한 바퀴 더).
                for d in dirs {
                    step += 0.8
                    DispatchQueue.main.asyncAfter(deadline: .now() + step) {
                        self.activate(d)
                        for id in ["search", "git", "changes", "notes", "api", "team", "preview"] {
                            self.ensureAux(id, in: d)
                        }
                    }
                }
                step += 3
                DispatchQueue.main.asyncAfter(deadline: .now() + step) {
                    let warm = self.workspaces.filter { self.states[$0]?.hasPanels == true }
                    RLog.log("WSMANY 한 바퀴 더 돈 뒤 RSS=\(rss())MB 패널유지=\(warm.count)곳")
                }
                // 놓아준 워크스페이스로 돌아가면 패널이 제자리에 되살아나야 한다.
                step += 1.5
                DispatchQueue.main.asyncAfter(deadline: .now() + step) {
                    let cold = dirs.first!
                    RLog.log("WSMANY 돌아가기 전 ws0 패널유지=\(self.states[cold]?.hasPanels ?? false)")
                    self.activate(cold)
                }
                step += 2.5
                DispatchQueue.main.asyncAfter(deadline: .now() + step) {
                    let cold = dirs.first!
                    let st = self.states[cold]
                    let inDock = (st?.dock?.groups.flatMap { $0.panels }.map { $0.id }) ?? []
                    let shown = ["preview", "notes", "team", "api", "search", "git", "changes"].filter { id in
                        guard let host = st?.auxHosts[id] else { return false }
                        return !host.subviews.isEmpty
                    }
                    RLog.log("WSMANY 돌아온 뒤 독패널=\(inDock.sorted()) 내용복구=\(shown.sorted())")
                    RLog.log("WSMANY done")
                }
            }
        }
        // RIVEN_EXBENCH=1: 워크스페이스를 오갈 때 탐색기가 그 워크스페이스 것으로 바뀌는지.
        if ProcessInfo.processInfo.environment["RIVEN_EXBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                for i in 0..<2 {
                    let d = URL(fileURLWithPath: "/private/tmp/exws/ws\(i)")
                    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
                    try? "hello".write(to: d.appendingPathComponent("only-in-ws\(i).txt"), atomically: true, encoding: .utf8)
                }
                func report(_ label: String) {
                    let host = self.debugExplorerHost()
                    let shown = host.subviews.compactMap { ($0 as? FileTreeView)?.debugRoot() }
                    RLog.log("EX \(label): 활성=\(self.workspace?.lastPathComponent ?? "-") "
                             + "호스트안=\(host.subviews.count)개 뿌리=\(shown) "
                             + "보이는것=\((host.subviews.last as? FileTreeView)?.debugRoot() ?? "없음")")
                }
                var t = 0.0
                for i in [0, 1, 0, 1] {
                    t += 2.0
                    DispatchQueue.main.asyncAfter(deadline: .now() + t) {
                        self.activate(URL(fileURLWithPath: "/private/tmp/exws/ws\(i)"))
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { report("ws\(i) 로 이동") }
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + t + 2) { RLog.log("EX done") }
            }
        }
        // RIVEN_NOTEBENCH=1: 메모 패널이 목록을 읽고 그리는 데 드는 시간.
        if ProcessInfo.processInfo.environment["RIVEN_NOTEBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, let ws = self.workspace else { return }
                if self.auxDockPanels["notes"] == nil { self.toggleDockPanel("notes") }
                let n = self.notes(for: ws)
                func time(_ label: String, _ body: () -> Void) {
                    let s0 = DispatchTime.now(); body()
                    let ms = Double(DispatchTime.now().uptimeNanoseconds - s0.uptimeNanoseconds) / 1e6
                    RLog.log(String(format: "NOTE %@ %.1fms", label, ms))
                }
                time("첫 reload(메모만)") { n.reload() }
                time("두번째 reload") { n.reload() }
                n.debugShowList(docs: true)
                time("문서탭 reload(레포 훑기)") { n.reload() }
                time("문서탭 두번째") { n.reload() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    RLog.log("NOTE 훑기 끝난 뒤 문서 수=\(n.debugDocCount()) 훑는중=\(n.scanningDocs)")
                    time("문서탭 세번째(캐시)") { n.reload() }
                    RLog.log("NOTE done")
                }
            }
        }
        // RIVEN_STATEDUMP=1: 재기동 후 복원된 그룹 상태 (그룹·닉네임·보고 라인·모델·제목).
        if ProcessInfo.processInfo.environment["RIVEN_STATEDUMP"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                RLog.log("STATE panes=" + self.agentPanes().map {
                    "[\($0.chat.groupName ?? "-")]\($0.chat.agentRole)←\($0.chat.parentName ?? "-")"
                    + "/\($0.chat.preferredModel ?? "default")/\($0.chat.agentPersona ?? "-")"
                }.joined(separator: " "))
                RLog.log("STATE titles=" + self.agentPanes().map { $0.panel.title }.joined(separator: " | "))
                // 패널을 열어야 탭이 채워진다 (열 때마다 살아있는 팬에서 다시 읽는다).
                self.toggleDockPanel("team")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    RLog.log("STATE tabs=" + self.teamPanel.debugTabTitles().joined(separator: "|"))
                }
                self.activeDock?.dumpTree("STATE tree")
            }
        }
        // RIVEN_FOCUSCARD=1: 선택 카드가 떠 있을 때 패널 활성화가 카드로 포커스를 주는지.
        if ProcessInfo.processInfo.environment["RIVEN_FOCUSCARD"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, let pane = self.agentPanes().first else { RLog.log("CARD no chat pane"); return }
                pane.chat.debugPresentChoice(["A", "B"])
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    // 입력창으로 포커스를 뺏은 뒤 패널 활성화를 다시 태운다 (사용자가 클릭한 상황).
                    pane.chat.focusInput(force: true)
                    let stolen = String(describing: type(of: self.window.firstResponder ?? NSNull()))
                    self.focusPanelContent(pane.panel)
                    let now = String(describing: type(of: self.window.firstResponder ?? NSNull()))
                    RLog.log("CARD afterSteal=\(stolen) afterActivate=\(now)")
                }
            }
        }
        // RIVEN_USAGEBENCH=1: 턴이 끝날 때 사용량이 다시 읽히는지 + 3초 합치기가 도는지.
        if ProcessInfo.processInfo.environment["RIVEN_USAGEBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in   // 기동 시 갱신과 겹치지 않게
                guard let self else { return }
                let t0 = self.lastUsageRefresh
                self.refreshUsageAfterTurn()
                let t1 = self.lastUsageRefresh
                self.refreshUsageAfterTurn()      // 곧바로 또 부르면 합쳐져야 한다
                let t2 = self.lastUsageRefresh
                self.refreshUsage(force: true)    // 버튼은 언제나 즉시
                let t3 = self.lastUsageRefresh
                RLog.log("USAGE 턴종료=\(t1 > t0) 3초내중복=\(t2 == t1 ? "합쳐짐" : "또호출") 버튼=\(t3 > t2)")
            }
        }
        // RIVEN_COPYTEST=1: 브라우저에서 텍스트를 골라 ⌘C 경로(responder chain)가 도는지.
        if ProcessInfo.processInfo.environment["RIVEN_COPYTEST"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                self.previewPanel.openURLString("http://127.0.0.1:8877/")
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    let pb = NSPasteboard.general
                    pb.clearContents(); pb.setString("이전내용", forType: .string)
                    // 사용자가 실제로 하는 순서: 페이지 클릭 → 선택 → ⌘C
                    if let win = self.window as NSWindow?, let w = self.previewPanel.debugWebView() {
                        let mid = w.convert(NSPoint(x: w.bounds.midX, y: w.bounds.midY), to: nil)
                        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                            if let e = NSEvent.mouseEvent(with: type, location: mid, modifierFlags: [],
                                                          timestamp: ProcessInfo.processInfo.systemUptime,
                                                          windowNumber: win.windowNumber, context: nil,
                                                          eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) {
                                NSApp.postEvent(e, atStart: false)
                            }
                        }
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        RLog.log("COPY 클릭후 firstResponder=\(String(describing: type(of: self.window.firstResponder ?? NSNull())))")
                        self.previewPanel.debugSelectAll { ok in
                            let sent = NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                                let got = NSPasteboard.general.string(forType: .string) ?? "(없음)"
                                RLog.log("COPY 선택=\(ok) sendAction=\(sent) 클립보드=\(got.prefix(40))")
                            }
                        }
                    }
                }
            }
        }
        // RIVEN_BROWSERMEM=1: 브라우저가 마지막 주소를 기억하고 재기동 때 되살리는지.
        if ProcessInfo.processInfo.environment["RIVEN_BROWSERMEM"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                if self.auxDockPanels["preview"] == nil { self.toggleDockPanel("preview") }
                let saved = (Settings.shared.object("browserURLs") as? [String: String] ?? [:])
                RLog.log("BRMEM 기동시 저장값=\(saved.values.first ?? "(없음)") 현재주소=\(self.previewPanel.debugURL())")
                DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
                    RLog.log("BRMEM 3초 뒤 현재주소=\(self.previewPanel.debugURL())")
                }
                if saved.isEmpty {
                    self.previewPanel.openURLString("http://127.0.0.1:8877/second.html")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                        let now = (Settings.shared.object("browserURLs") as? [String: String] ?? [:])
                        RLog.log("BRMEM 이동 후 저장값=\(now.values.first ?? "(없음)")")
                    }
                }
            }
        }
        // RIVEN_FOCUSTIME=1: 조직도에서 멤버 카드를 누를 때 어디서 시간을 쓰는지.
        if ProcessInfo.processInfo.environment["RIVEN_FOCUSTIME"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                if self.auxDockPanels["team"] == nil { self.toggleDockPanel("team") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.teamPanel.debugCreate()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                        let names = self.agentPanes().map { $0.chat.agentRole }
                        // 무거운 대화에서 재도록 (실제 사용 상황). RIVEN_FOCUSTIME=light 면 건너뛴다.
                        if ProcessInfo.processInfo.environment["RIVEN_FOCUSTIME"] != "light" {
                            for p in self.agentPanes() { for i in 1...200 { p.chat.noteSystem("기록 줄 \(i) 입니다.") } }
                        }
                        RLog.log("FOCUSTIME 멤버=" + names.joined(separator: ",") + " (각 200줄)")
                        for (i, n) in names.enumerated() {
                            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.6) {
                                let t = Date()
                                self.focusAgentPane("팀", n)
                                RLog.log("FOCUSTIME [\(n)] 호출전체=\(Int(Date().timeIntervalSince(t) * 1000))ms")
                            }
                        }
                    }
                }
            }
        }
        // RIVEN_DOCBENCH=1: 문서화 도구가 워크스페이스에 파일을 만들고 그 문서를 띄우는지,
        // 메모 미리보기에 제목이 두 번 나오지 않는지.
        if ProcessInfo.processInfo.environment["RIVEN_DOCBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, let ws = self.workspace else { return }
                RLog.log("DOC write=" + self.runNoteTool("riven_doc_write",
                    ["path": "docs/정리.md", "body": "# 정리 문서\n\n본문 첫 줄.\n"]))
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    let f = ws.appendingPathComponent("docs/정리.md")
                    RLog.log("DOC 파일존재=\(FileManager.default.fileExists(atPath: f.path)) "
                           + "패널문서=\(self.notesPanel.debugCurrentPath()) "
                           + "미리보기제목중복=\(self.notesPanel.debugPreviewHasTitleTwice())")
                    RLog.log("DOC 덮어쓰기거부=" + self.runNoteTool("riven_doc_write",
                        ["path": "docs/정리.md", "body": "x"]))
                    RLog.log("DOC 밖차단=" + self.runNoteTool("riven_doc_write",
                        ["path": "../밖.md", "body": "x"]))
                }
            }
        }
        // RIVEN_MDSURFACE=1: 에이전트가 워크스페이스에 .md 를 쓰면 메모 패널이 그 문서를 띄우는지.
        if ProcessInfo.processInfo.environment["RIVEN_MDSURFACE"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, let ws = self.workspace else { return }
                let f = ws.appendingPathComponent("agent-written.md")
                try? "# 에이전트가 쓴 문서\n\n본문입니다.\n".write(to: f, atomically: true, encoding: .utf8)
                self.surfaceAgentMarkdown(f.path, ws: ws)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                    RLog.log("MDSURFACE 패널열림=\(self.auxDockPanels["notes"] != nil) "
                           + "보이는문서=\(self.notesPanel.debugCurrentPath())")
                    // 워크스페이스 밖 파일은 띄우지 않아야 한다.
                    let out = URL(fileURLWithPath: "/tmp/outside-agent.md")
                    try? "# 밖\n".write(to: out, atomically: true, encoding: .utf8)
                    self.surfaceAgentMarkdown(out.path, ws: ws)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        RLog.log("MDSURFACE 밖의파일 뒤 보이는문서=\(self.notesPanel.debugCurrentPath())")
                    }
                }
            }
        }
        // RIVEN_SIDEBARBENCH=1: 사이드바 분할선을 실제 마우스 이벤트로 끌어 보고, 저장까지
        // 되는지 본다 (합성 이벤트라도 NSSplitView 의 모달 추적 루프가 그대로 처리한다).
        if ProcessInfo.processInfo.environment["RIVEN_SIDEBARBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, let win = self.window as NSWindow? else { return }
                let before = Settings.shared.double("sidebarWidth", 220)
                let sv = self.bodySplit!
                let x = sv.arrangedSubviews[0].frame.maxX + sv.dividerThickness / 2
                let y = sv.frame.midY
                func post(_ type: NSEvent.EventType, _ pt: NSPoint) {
                    guard let e = NSEvent.mouseEvent(with: type, location: sv.convert(pt, to: nil),
                                                     modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                     windowNumber: win.windowNumber, context: nil,
                                                     eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
                    else { return }
                    NSApp.postEvent(e, atStart: false)
                }
                RLog.log("SIDEBAR 드래그 시작 divider x=\(Int(x)) 저장값=\(Int(before))")
                // 레일 분할선도 같이 끌어 본다 (여기가 이중 저장 지점).
                if let rv = self.sidebarSplit, rv.arrangedSubviews.count >= 2 {
                    let ry = rv.arrangedSubviews[0].frame.maxY + rv.dividerThickness / 2
                    let rx = rv.frame.midX
                    func rpost(_ type: NSEvent.EventType, _ pt: NSPoint) {
                        guard let e = NSEvent.mouseEvent(with: type, location: rv.convert(pt, to: nil),
                                                         modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                         windowNumber: win.windowNumber, context: nil,
                                                         eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
                        else { return }
                        NSApp.postEvent(e, atStart: false)
                    }
                    rpost(.leftMouseDown, NSPoint(x: rx, y: ry))
                    for i in 1...6 { rpost(.leftMouseDragged, NSPoint(x: rx, y: ry - CGFloat(i) * 10)) }
                    rpost(.leftMouseUp, NSPoint(x: rx, y: ry - 60))
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        RLog.log("SIDEBAR 레일 실제높이=\(Int(rv.arrangedSubviews[0].frame.height)) "
                               + "railHeight저장=\(Int(Settings.shared.double("railHeight", 190)))")
                    }
                }
                post(.leftMouseDown, NSPoint(x: x, y: y))
                for i in 1...6 { post(.leftMouseDragged, NSPoint(x: x + CGFloat(i) * 8, y: y)) }
                post(.leftMouseUp, NSPoint(x: x + 48, y: y))
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    RLog.log("SIDEBAR 드래그 후 실제폭=\(Int(sv.arrangedSubviews[0].frame.width)) "
                           + "저장값=\(Int(Settings.shared.double("sidebarWidth", 220))) "
                           + "restored플래그=\(self.debugSidebarRestored)")
                }
            }
        }
        // RIVEN_PERSONADUMP=1: 카드가 만들어진 뒤에 에이전트 목록이 주입되는 실제 순서를 그대로
        // 재현해서, 패널을 열 때 목록이 카드에 실리는지 본다.
        if ProcessInfo.processInfo.environment["RIVEN_PERSONADUMP"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                RLog.log("PERSONA 주입 전 카드=" + self.teamPanel.debugPersonaItems().joined(separator: " | "))
                self.teamPanel.agentsProvider = { ["reviewer", "tester"] }
                RLog.log("PERSONA 주입 직후 카드=" + self.teamPanel.debugPersonaItems().joined(separator: " | "))
                self.toggleDockPanel("team")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    RLog.log("PERSONA 패널 연 뒤 카드=" + self.teamPanel.debugPersonaItems().joined(separator: " | "))
                }
            }
        }
        // RIVEN_TOKENSHOT=<theme>: 그 테마에서 @멘션 / 슬래시 토큰이 실제로 읽히는지 캡처.
        if let theme = ProcessInfo.processInfo.environment["RIVEN_TOKENSHOT"] {
            Theme.apply(id: theme)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                if self.auxDockPanels["team"] == nil { self.toggleDockPanel("team") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.teamPanel.debugCreate()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        if let lead = self.agentPanes().first(where: { $0.chat.parentName == nil }) {
                            lead.chat.debugFillInput("/status @멤버1 저녁메뉴 @멤버2 점심메뉴")
                            self.focusPanelContent(lead.panel)
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                            if let v = self.window.contentView,
                               let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                                v.cacheDisplay(in: v.bounds, to: rep)
                                if let png = rep.representation(using: .png, properties: [:]) {
                                    try? png.write(to: URL(fileURLWithPath: "/tmp/token-\(theme).png"))
                                    RLog.log("TOKEN shot /tmp/token-\(theme).png")
                                }
                            }
                        }
                    }
                }
            }
        }
        // RIVEN_MENTIONSPLIT=1: 멘션마다 다른 지시가 각자에게 가는지 (문자열 분해만 검증).
        if ProcessInfo.processInfo.environment["RIVEN_MENTIONSPLIT"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                let peers = ["멤버1", "멤버2"]
                for text in ["@멤버1 저녁메뉴 추천해줘 @멤버2 점심메뉴 추천해줘",
                             "한국식으로 @멤버1 저녁 @멤버2 점심",
                             "@멤버1 @멤버2 이 파일 같이 봐줘",
                             "@멤버1"] {
                    let tasks = ChatTokens.mentionTasks(text, peers: peers)
                    RLog.log("SPLIT \(text) → " + (tasks.isEmpty ? "(없음)" :
                        tasks.map { "\($0.agent)=\"\($0.message)\"" }.joined(separator: " | ")))
                }
            }
        }
        // RIVEN_ASKBENCH=1: 도구 응답 전달 규칙 — 정상 resolve / 만료된 id / 세션 종료 시.
        if ProcessInfo.processInfo.environment["RIVEN_ASKBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                guard let srv = ChatAskServer() else { RLog.log("ASK server unavailable"); return }
                var got: String?
                srv.onTool = { id, _, _, _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        RLog.log("ASK resolve(live)=\(srv.resolve(id, result: "선택 A"))")
                        RLog.log("ASK resolve(stale)=\(srv.resolve(id, result: "늦은 클릭"))")
                    }
                }
                DispatchQueue.global().async {
                    got = ChatAskServer.debugCall(sock: srv.path, tool: "ask_user")
                    DispatchQueue.main.async { RLog.log("ASK client got=\(got ?? "nil")") }
                }
            }
        }
        // RIVEN_PLANBENCH=1: 계획 파일 제목 추출 + 배지 노출/클릭 경로.
        if ProcessInfo.processInfo.environment["RIVEN_PLANBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".claude/plans")
                let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasSuffix(".md") }
                for f in files.prefix(3) {
                    let path = (dir as NSString).appendingPathComponent(f)
                    RLog.log("PLAN file=\(f) title=\(ChatPanel.planTitle(of: path))")
                }
                let badge = PlanBadge(frame: .zero)
                badge.show(title: "사업장 정보 수정", file: "reactive-moseying-key.md")
                var opened = false
                badge.onOpen = { opened = true }
                badge.mouseDown(with: NSEvent())
                RLog.log("PLAN badge hidden=\(badge.isHidden) click=\(opened) tip=\(badge.toolTip ?? "-")")
            }
        }
        // RIVEN_MDBENCH=1: 스트리밍 중 서식이 실제로 붙는지 + 표/제목/목록이 뷰로 그려지는지.
        if ProcessInfo.processInfo.environment["RIVEN_MDBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                let seg = AssistantText(frame: NSRect(x: 0, y: 0, width: 640, height: 10))
                let md = """
                # 요약

                **굵게** 와 `코드` 가 섞인 문단입니다.

                | 이름 | 모델 | 상태 |
                |---|---|---|
                | 리드 | Opus 5 | 대기 |
                | 구현 | Sonnet 5 | 작업 중 |

                - 첫째 항목
                - 둘째 항목

                ```swift
                let x = 1
                ```

                마지막 문단입니다.
                """
                func grids(_ v: NSView) -> Int {
                    (v is NSGridView ? 1 : 0) + v.subviews.reduce(0) { $0 + grids($1) }
                }
                func dump(_ tag: String) {
                    let kinds = seg.subviews.first?.subviews.compactMap { v -> String in
                        if let inner = v.subviews.first, !(v is NSStackView) { return "\(type(of: inner))" }
                        return "\(type(of: v))"
                    } ?? []
                    RLog.log("MD \(tag) blocks=\(kinds.count) tables=\(grids(seg)) [\(kinds.joined(separator: ", "))]")
                }
                // 20자씩 흘려 넣으며 타이핑 진행
                var i = md.startIndex
                var ticks = 0
                while i < md.endIndex {
                    let j = md.index(i, offsetBy: 20, limitedBy: md.endIndex) ?? md.endIndex
                    seg.receive(String(md[i..<j])); i = j
                    while seg.advance() { }
                    ticks += 1
                    if ticks == 6 { dump("mid") }
                }
                dump("streamed")
                seg.renderFinal()
                dump("final")
            }
        }
        // RIVEN_ZOOMBENCH=1: ⌘+ 로 배율을 올렸을 때 탭 바 높이·탭 폭이 함께 따라오는지.
        // (30px 고정이던 시절엔 글꼴만 커져 탭 글자가 바 안에 갇혔다.)
        if ProcessInfo.processInfo.environment["RIVEN_ZOOMBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                func grids(_ v: NSView) -> Int {
                    (v is NSGridView ? 1 : 0) + v.subviews.reduce(0) { $0 + grids($1) }
                }
                func dump(_ tag: String) {
                    let g = self.activeDock?.groups.first(where: { !$0.panels.isEmpty })
                    let tabs = g?.tabBar.subviews.first?.subviews.first?.subviews.first?.subviews ?? []
                    let widths = tabs.map { Int($0.frame.width) }
                    RLog.log("ZOOM \(tag) factor=\(UIScale.factor) barH=\(Int(DockGroup.tabBarHeight)) "
                           + "tabBar=\(Int(g?.tabBar.frame.height ?? 0)) tabW=\(widths)")
                }
                dump("before")
                for _ in 0..<4 { self.zoomInMenu() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { dump("after") }
            }
        }
        // RIVEN_UIBENCH=1: 사용자가 실제로 하는 순서 그대로 — 패널을 열고 기본값으로 [그룹 만들기].
        if ProcessInfo.processInfo.environment["RIVEN_UIBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                if self.auxDockPanels["team"] == nil { self.toggleDockPanel("team") }
                self.activeDock?.dumpTree("UI before")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if ProcessInfo.processInfo.environment["RIVEN_UIBENCH"] == "5" {
                        self.teamPanel.debugAddAgents(2)     // 리드 + 멤버 4명
                    }
                    self.teamPanel.debugCreate()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        self.activeDock?.dumpTree("UI after")
                        // MCP 경로: 추가 → (확인 후) 제거 → 그룹 삭제
                        // 멤버 하나를 닫았다가 조직도에서 되살린다.
                        if let victim = self.agentPanes().first(where: { $0.chat.agentRole == "멤버1" }) {
                            self.activeDock?.removePanel(victim.panel)
                            let after = self.liveAgentGroups().first { $0.group == "팀" }?.members ?? []
                            RLog.log("REOPEN closed=" + after.map { "\($0.name):\($0.open ? "open" : "closed")" }.joined(separator: " "))
                            self.focusAgentPane("팀", "멤버1")
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                                let now = self.liveAgentGroups().first { $0.group == "팀" }?.members ?? []
                                RLog.log("REOPEN after=" + now.map { "\($0.name):\($0.open ? "open" : "closed")" }.joined(separator: " "))
                                self.activeDock?.dumpTree("REOPEN tree")
                            }
                        }
                        // 창을 그대로 PNG 로 떠서 눈으로 확인한다 (스크린 전체가 아니라 riven 창만).
                        if let v = self.window.contentView,
                           let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                            v.cacheDisplay(in: v.bounds, to: rep)
                            if let png = rep.representation(using: .png, properties: [:]) {
                                try? png.write(to: URL(fileURLWithPath: "/tmp/uibench.png"))
                                RLog.log("UI shot /tmp/uibench.png \(Int(v.bounds.width))x\(Int(v.bounds.height))")
                            }
                        }
                    }
                }
            }
        }
        // RIVEN_TEAMBENCH=1: 3단 계층 그룹을 만들어 팬이 깊이별 열로 놓이는지, 역할/부모가
        // 스냅샷에 실려 다시 읽히는지 확인한다 (메인 | 리포트 열 | 그 아래 열).
        if ProcessInfo.processInfo.environment["RIVEN_TEAMBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self else { return }
                // 넓은 오른쪽 영역에서 3열이 나오는지 보려고 기존 팬을 비운다.
                if ProcessInfo.processInfo.environment["RIVEN_WIDEBENCH"] != nil,
                   let dock = self.activeDock {
                    for p in dock.groups.flatMap({ $0.panels }) { dock.removePanel(p) }
                }
                self.createAgentGroup("배포팀", [
                    (name: "리드", agent: nil, model: nil, parent: nil),
                    (name: "구현", agent: nil, model: "sonnet", parent: 0),
                    (name: "리뷰", agent: nil, model: "haiku", parent: 0),
                ])
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    let panes = self.agentPanes().map { "\($0.chat.agentRole)←\($0.chat.parentName ?? "-")/\($0.chat.preferredModel ?? "default")" }
                    RLog.log("TEAM panes=" + panes.joined(separator: " "))
                    RLog.log("TEAM report\n" + self.agentPanesReport())
                    self.activeDock?.container.layoutSubtreeIfNeeded()
                    let cols = self.agentPanes().map { p -> String in
                        let f = p.panel.group?.convert(p.panel.group!.bounds, to: nil) ?? .zero
                        return "\(p.chat.agentRole)@x\(Int(f.minX)),y\(Int(f.minY)),w\(Int(f.width))"
                    }
                    RLog.log("TEAM layout " + cols.joined(separator: " "))
                    self.activeDock?.dumpTree("TEAM tree")
                    // 지연 후 다시 균등화해 보고(타이밍 문제인지 확인) 트리를 또 찍는다.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        let row = self.agentPanes().first { $0.chat.agentRole == "테스트" }
                        self.activeDock?.equalizeSiblings(of: row?.panel.group)
                        self.activeDock?.dumpTree("TEAM tree-after-equalize")
                    }
                    // 요약 제목이 와도 그룹·닉네임이 앞에 남아야 한다.
                    for pane in self.agentPanes() { pane.chat.onTitle?("로그 파서 리팩터링") }
                    RLog.log("TEAM titles=" + self.agentPanes().map { $0.panel.title }.joined(separator: " | "))
                    // 실제 병렬 위임: 세 명에게 동시에 던지고 시작/도착 시각을 잰다.
                    if ProcessInfo.processInfo.environment["RIVEN_PARBENCH"] != nil {
                        let t0 = Date()
                        let tasks = self.agentPanes().dropFirst().map {
                            (agent: $0.chat.agentRole, message: "숫자 7만 답해. 설명 금지.")
                        }
                        for task in tasks {
                            self.askAgentPane(task.agent, task.message, from: nil) { _ in
                                RLog.log(String(format: "PAR done %@ at %.2fs", task.agent, Date().timeIntervalSince(t0)))
                            }
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            let busy = self.agentPanes().filter { $0.chat.isBusy }.map { $0.chat.agentRole }
                            RLog.log("PAR busy-at-0.3s=" + busy.joined(separator: ","))
                        }
                    }
                    // 조직도 편집: 이름·모델·보고 대상을 바꾸고 팬/자식 참조/스냅샷에 반영되는지.
                    self.editAgentPane("배포팀", "구현", name: "빌더", model: "opus", parent: nil)
                    RLog.log("TEAM edited=" + self.agentPanes().map {
                        "\($0.chat.agentRole)←\($0.chat.parentName ?? "-")/\($0.chat.preferredModel ?? "default")"
                    }.joined(separator: " "))
                    RLog.log("TEAM editedTitles=" + self.agentPanes().map { $0.panel.title }.joined(separator: " | "))
                    // 같은 이름으로 하나 더 만들면 합쳐지지 않고 분리돼야 한다.
                    self.createAgentGroup("배포팀", [
                        (name: "리드", agent: nil, model: nil, parent: nil),
                        (name: "구현", agent: nil, model: nil, parent: 0),
                    ])
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        RLog.log("TEAM dup tabs=" + self.teamPanel.debugTabTitles().joined(separator: "|"))
                        RLog.log("TEAM dup panes=" + self.agentPanes().map {
                            "[\($0.chat.groupName ?? "-")]\($0.chat.agentRole)"
                        }.joined(separator: " "))
                    }
                    RLog.log("TEAM panelOpen=\(self.auxDockPanels["team"] != nil) "
                           + "tabs=" + self.teamPanel.debugTabTitles().joined(separator: "|")
                           + " selected=\(self.teamPanel.debugSelectedTab()) chart=\(self.teamPanel.debugChartVisible())")
                }
            }
        }
        // RIVEN_FOCUSBENCH=1: 빈 독에 패널을 열었을 때 전체를 차지하는지, 여러 팬 중 하나를
        // 닫았을 때 활성 그룹과 창 포커스가 살아남는지를 실제 트리로 찍는다 (클릭 없이 검증).
        if ProcessInfo.processInfo.environment["RIVEN_FOCUSBENCH"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, let dock = self.activeDock else { return }
                for p in dock.groups.flatMap({ $0.panels }) { dock.removePanel(p) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    self.toggleDockPanel("notes")
                    dock.container.layoutSubtreeIfNeeded()
                    let frames = dock.groups.map { g in
                        "\(g.panels.first?.id ?? "empty")=\(Int(g.frame.width))x\(Int(g.frame.height))"
                    }
                    RLog.log("FOCUS empty-open dock=\(Int(dock.container.bounds.width))x\(Int(dock.container.bounds.height)) panes[\(dock.groups.count)] " + frames.joined(separator: " "))
                    self.newTerminal(); self.toggleDockPanel("search")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        let victim = dock.groups.flatMap({ $0.panels }).first { $0.id == "notes" }
                        if let v = victim { dock.removePanel(v) }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            let active = dock.groups.first(where: { $0.isActiveGroup })
                            let fr = self.window.firstResponder
                            let live = (fr as? NSView).map { v in dock.groups.contains { v.isDescendant(of: $0) } } ?? false
                            RLog.log("FOCUS after-close active=\(active?.activePanel?.id ?? "NONE") "
                                   + "firstResponder=\(fr.map { String(describing: type(of: $0)) } ?? "nil") inDock=\(live)")
                            // 비활성 팬의 본문 한가운데를 합성 클릭 → 활성 그룹이 옮겨가는지.
                            guard let target = dock.groups.first(where: { !$0.isActiveGroup && !$0.panels.isEmpty }),
                                  let win = self.window as NSWindow? else { return }
                            let c = target.convert(NSPoint(x: target.bounds.midX, y: target.bounds.midY), to: nil)
                            if let ev = NSEvent.mouseEvent(with: .leftMouseDown, location: c, modifierFlags: [],
                                                           timestamp: ProcessInfo.processInfo.systemUptime,
                                                           windowNumber: win.windowNumber, context: nil,
                                                           eventNumber: 0, clickCount: 1, pressure: 1) {
                                let want = target.activePanel?.id ?? "?"
                                NSApp.postEvent(ev, atStart: false)
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                                    let now = dock.groups.first(where: { $0.isActiveGroup })?.activePanel?.id ?? "NONE"
                                    RLog.log("FOCUS click target=\(want) active=\(now) ok=\(now == want)")
                                }
                            }
                        }
                    }
                }
            }
        }
        // Restore the left sidebar (rail/explorer) split proportion once it's laid out.
        // 예전 세션에 남아 있는 sidebarRail(비율)은 무시한다. railHeight 로 이미 복원했고,
        // 여기서 다시 손대면 사용자가 맞춰둔 높이를 창 높이에 비례한 값으로 덮어쓴다.
    }

    // Rebuild the tab bar + editor for a workspace's open tabs. 에디터 웹뷰는 모든
    // 워크스페이스가 공유하는 하나의 WKWebView라서, 전환 시 이전 워크스페이스의
    // 모델/탭이 그대로 남아 있었다(#7) — 먼저 전부 정리하고 이 워크스페이스의
    // 탭을 전부 다시 연다 (활성 탭을 마지막에 열어 그 탭이 보이게).
    private func rebuildTabs(for st: WorkspaceState) {
        tabBar.closeAll()
        // 디스크에서 사라진 파일은 건너뛴다 (restoreSession과 같은 필터).
        let fm = FileManager.default
        st.openTabs = st.openTabs.filter { fm.fileExists(atPath: $0) }
        if let a = st.activeTab, !st.openTabs.contains(a) { st.activeTab = nil }
        if st.activeTab == nil { st.activeTab = st.openTabs.last }
        for p in st.openTabs { tabBar.open(p) }
        guard let active = st.activeTab else {
            editor.setTabs([], active: nil) { _ in }   // clear the view, KEEP the models
            hideEditorPane()   // workspace has no open tabs → terminal full width
            statusBar.setFileInfo("")
            return
        }
        showEditorPane()
        // Swap the tab set instead of disposing every Monaco model and re-creating it. Disposing
        // meant each switch re-read and re-tokenized every file — the 1-2s workspace-switch stall.
        // Models now live until the workspace is closed, so returning is a pure tab swap and only
        // never-loaded files are read from disk (reported back as `missing`).
        let ws = workspace
        editor.setTabs(st.openTabs, active: active) { [weak self] missing in
            guard let self, self.workspace == ws, !missing.isEmpty else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                let loaded = missing.map { ($0, (try? String(contentsOfFile: $0, encoding: .utf8)) ?? "") }
                DispatchQueue.main.async {
                    guard self.workspace == ws, let cur = ws.map({ self.state(for: $0) }) else { return }
                    for (p, content) in loaded where cur.openTabs.contains(p) {
                        if p == cur.activeTab { self.editor.open(path: p, content: content) }
                        else { self.editor.openBackground(path: p, content: content) }
                    }
                    self.editor.setTabs(cur.openTabs, active: cur.activeTab) { _ in }   // keep the user's order
                }
            }
        }
        tabBar.setActive(active)
        statusBar.setFileInfo(fileInfo(active))
    }

    private func refreshGit() {
        guard let ws = workspace else { return }
        DispatchQueue.global(qos: .utility).async {
            let branch = Git.branch(cwd: ws.path)
            let status = Git.status(cwd: ws.path)
            DispatchQueue.main.async {
                self.statusBar.setBranch(branch)
                self.rail.setBranch(ws, branch)
                self.state(for: ws).explorer?.setGitStatus(status)
                self.state(for: ws).git?.changes.refresh()   // 열어 둔 소스 컨트롤만 갱신
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
    private static let maxEditorFileSize = 10 * 1024 * 1024   // 10 MB — 텍스트(Monaco)용
    /// 이미지는 Monaco 를 거치지 않고 뷰어로 그린다. 텍스트용 상한(10MB)을 그대로 씌우면
    /// 평범한 사진 한 장도 "너무 큽니다" 로 거절당했다 — 카메라 원본이 그 정도는 넘는다.
    /// data: URL 로 넘기느라 메모리를 base64 만큼 더 쓰는 건 사실이라 상한을 아주 없애지는
    /// 않고, 사람이 실제로 여는 이미지가 다 들어오는 선으로 크게 잡는다.
    private static let maxImageFileSize = 256 * 1024 * 1024   // 256 MB

    private func openFile(_ url: URL) {
        RLog.log("openFile \(url.lastPathComponent) ws=\(workspace?.lastPathComponent ?? "nil")")
        guard let ws = workspace else { RLog.log("openFile: no workspace!"); return }
        let st = state(for: ws)
        let path = url.path
        explorer?.reveal(url)   // keep the explorer selection on the active file
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
        // 이미지는 Monaco 를 안 거치므로 훨씬 넉넉한 상한을 쓴다.
        let isImageFile = Self.imageMIME(path) != nil
        let cap = isImageFile ? Self.maxImageFileSize : Self.maxEditorFileSize
        if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
           let size = attrs[.size] as? Int, size > cap {
            let a = NSAlert()
            a.messageText = t("editor.tooLarge")
            a.informativeText = t("editor.tooLargeBody", [
                "name": url.lastPathComponent,
                "size": ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file),
                "limit": ByteCountFormatter.string(fromByteCount: Int64(cap), countStyle: .file)])
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
        explorer?.reveal(URL(fileURLWithPath: path))   // explorer follows the active tab
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
        window.title = "riven · \(ws)" + (dirty ? "  •  \(name) (수정됨)" : "  •  \(name)")
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
        addRemap(viewMenu, t("menu.notes"), "view.notes", #selector(notesMenu))
        addRemap(viewMenu, t("menu.team"), "view.team", #selector(teamMenu))
        addRemap(viewMenu, "Chat", "view.chat", #selector(chatMenu))
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
        // 설치된 AI 에이전트. "agentUI" 설정이 네이티브 챗 팬으로 열지, 터미널에 CLI 를
        // 그대로 띄울지 정한다. Codex 도 이제 네이티브다 — app-server 로 몰기 때문에
        // 스트리밍·승인 카드·변경사항 연동이 Claude 와 같은 자리에서 돈다.
        let nativeUI = Settings.shared.string("agentUI", "native") == "native"
        let nativeKinds: [String: ChatAgentKind] = ["Claude Code": .claude, "Codex": .codex]
        for a in AgentDiscovery.available() {
            let kind = nativeUI ? nativeKinds[a.name] : nil
            actions.append(QuickAction(title: a.name,
                                       hint: kind != nil ? "네이티브 UI" : t("agent.label"),
                                       symbol: a.symbol) { [weak self] in
                if let kind { self?.newChat(kind: kind) } else { self?.launchAgent(a) }
            })
        }
        actions.append(contentsOf: [
            QuickAction(title: t("title.editor"), hint: "", symbol: "doc.text") { [weak self] in self?.showEditorPane(); self?.editor.focusEditor() },
            QuickAction(title: t("title.search"), hint: "⌘⇧F", symbol: "magnifyingglass") { [weak self] in self?.toggleDockPanel("search") },
            QuickAction(title: t("title.git"), hint: "⌘⇧G", symbol: "arrow.triangle.branch") { [weak self] in self?.toggleDockPanel("git") },
            QuickAction(title: t("title.preview"), hint: "⌘⇧V", symbol: "safari") { [weak self] in self?.toggleDockPanel("preview") },
            QuickAction(title: t("api.test"), hint: "", symbol: "network") { [weak self] in self?.toggleDockPanel("api") },
            QuickAction(title: t("title.changes"), hint: "⌘⇧C", symbol: "clock.arrow.circlepath") { [weak self] in self?.toggleDockPanel("changes") },
            QuickAction(title: t("title.notes"), hint: "", symbol: "note.text") { [weak self] in self?.toggleDockPanel("notes") },
            QuickAction(title: t("title.team"), hint: "", symbol: "person.3") { [weak self] in self?.toggleDockPanel("team") },
            QuickAction(title: "새 채팅", hint: "네이티브 에이전트", symbol: "bubble.left.and.text.bubble.right") { [weak self] in self?.newChat() },
            QuickAction(title: "새 채팅: 에이전트 선택", hint: "claude --agent", symbol: "person.2") { [weak self] in self?.newChatWithAgent() },
            QuickAction(title: "채팅: 이전 세션 열기", hint: "resume", symbol: "clock.arrow.circlepath") { [weak self] in self?.resumeChatSession() },
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
    func debugCloseTabMenu() { closeTabMenu() }
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
        // 브라우저가 활성이면 ⌘W 는 먼저 브라우저 탭을 닫는다 — 브라우저에서 늘 그렇다.
        // 마지막 탭이었으면 브라우저가 스스로 패널 닫기를 요청한다 (onRequestClose).
        // (패널의 content 는 호스트 컨테이너라 타입으로 못 알아본다 — id 로 본다.)
        if let panel = activeDock?.activeGroup?.activePanel, panel.id == "preview",
           let ws = workspace {
            preview(for: ws).closeActiveTab()
            return
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
    /// 설정 화면에서도 같은 경로를 쓴다 (메뉴·단축키와 결과가 달라지면 안 된다).
    func zoomFromSettings(_ delta: Int) {
        if delta == 0 { applyZoom(UIScale.reset(), delta: 0) }
        else { applyZoom(UIScale.step(delta), delta: delta) }
    }
    @objc private func zoomInMenu() { applyZoom(UIScale.step(+1), delta: +1) }
    @objc private func zoomOutMenu() { applyZoom(UIScale.step(-1), delta: -1) }
    @objc private func zoomResetMenu() { applyZoom(UIScale.reset(), delta: 0) }
    // ⌘+/⌘− AUTO-REPEATS. Each press used to synchronously re-font the editor, reload the ghostty
    // config, re-set every terminal surface's font, rebuild the rail/status/tabs/explorer and
    // broadcast applyScale() to every registered panel (which walks the whole chat transcript).
    // Holding the key queued that whole pipeline per repeat — the reported lag. UIScale.factor is
    // already updated by the caller, so coalescing the EXPENSIVE part is safe: the single rebuild
    // that runs uses the final factor.
    private var zoomWork: DispatchWorkItem?
    private func applyZoom(_ baseFont: Int, delta: Int) {
        zoomWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.applyZoomNow() }
        zoomWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10, execute: work)
    }
    private func applyZoomNow() {
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
        headerLabel?.font = UIScale.font(UIScale.body, .medium)
        headerUsage?.font = UIScale.font(UIScale.small)
        rebuildPinnedUsage()
        UIScale.broadcast()   // re-font every registered aux panel (changes/search/git/preview/api/…)
    }
    @objc private func toggleSidebarMenu() { toggleSidebar() }
    @objc private func searchMenu() { toggleDockPanel("search") }
    @objc private func gitMenu() { toggleDockPanel("git") }
    @objc private func previewMenu() { toggleDockPanel("preview") }
    @objc private func changesMenu() { toggleDockPanel("changes") }
    @objc private func notesMenu() { toggleDockPanel("notes") }
    @objc private func teamMenu() { toggleDockPanel("team") }
    @objc private func chatMenu() { newChat() }
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
    /// 그 워크스페이스에 aux 패널이 열려 있는지 (활성 여부와 무관).
    /// 이 경로를 품고 있는 워크스페이스. 하위 폴더에서 CLI 를 띄우는 일이 흔하므로
    /// 가장 깊이 맞는 것을 고른다 (레포 안에 레포를 열어 둔 경우).
    func workspaceContaining(_ path: String?) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        let p = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        var best: URL?
        for ws in workspaces {
            let root = ws.standardizedFileURL.resolvingSymlinksInPath().path
            guard p == root || p.hasPrefix(root + "/") else { continue }
            if best == nil || root.count > best!.path.count { best = ws }
        }
        return best
    }

    private func auxIsOpen(_ id: String, in ws: URL) -> Bool {
        let st = state(for: ws)
        guard let panel = st.auxPanels[id], let dock = st.dock else { return false }
        return panel.group?.manager === dock
    }
    /// 그 워크스페이스에 aux 패널을 연다. 지금 보고 있는 워크스페이스는 건드리지 않는다 —
    /// 에이전트가 자기 워크스페이스에서 한 일이 남의 화면을 바꾸면 안 된다.
    @discardableResult
    private func ensureAux(_ id: String, in ws: URL) -> Bool {
        if auxIsOpen(id, in: ws) { return true }
        if ws == workspace { toggleDockPanel(id); return auxIsOpen(id, in: ws) }
        guard let dock = state(for: ws).dock else { return false }
        guard let panel = makeAuxPanel(id, for: ws) else { return false }
        if !dock.restorePlacement(panel) {
            dock.addPanel(panel, reference: dock.activeGroup ?? dock.groups.last, direction: .right)
        }
        return true
    }

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
        // Prefer the slot this panel last occupied in THIS workspace; fall back to the default edge.
        if !dock.restorePlacement(panel) {
            dock.addPanel(panel, reference: dock.activeGroup ?? dock.groups.last, direction: .right)
        }
        if id == "team" { teamPanel.refresh() }      // 칩·조직도는 열 때마다 현재 팬에서 다시 읽는다
        if id == "search" { searchPanel.focusQuery() }
        else if id == "preview" { previewPanel.focusURL() }
    }

    // aux 패널 생성만 분리 (toggleDockPanel과 레이아웃 복원이 공용): 제목·심볼·콘텐츠
    // 스위치 + onClose 핸들러 + auxDockPanels 등록까지. 독에 어디에 붙일지는 호출자가
    // 정한다 (토글은 기본 가장자리, 레이아웃 복원은 스냅샷의 자리).
    private func makeAuxPanel(_ id: String, for forced: URL? = nil) -> DockPanel? {
        guard let ws = forced ?? workspace else { return nil }
        let title: String; let symbol: String
        let content: NSView
        switch id {
        case "search":  title = t("title.search"); symbol = "magnifyingglass"; content = search(for: ws)
        case "git":     title = t("title.git"); symbol = "arrow.triangle.branch"; content = git(for: ws)
        case "preview":
            title = t("title.preview"); symbol = "safari"; content = preview(for: ws)
        case "api":     title = t("title.api"); symbol = "network"; content = api(for: ws)
        case "changes": title = t("title.changes"); symbol = "clock.arrow.circlepath"; content = changes(for: ws)
        case "notes":   title = t("title.notes"); symbol = "note.text"; content = notes(for: ws)
        case "team":    title = t("title.team"); symbol = "person.3"; content = team(for: ws)
        default: return nil
        }
        // Per-workspace panel hosting the SHARED view (same pattern as the editor): the dock tree
        // then never changes on a switch — we only re-parent the content view.
        let st = state(for: ws)
        let host = st.auxHost(id)
        adopt(content, into: host)
        let panel = st.auxPanels[id] ?? DockPanel(id: id, title: title,
            icon: NSImage(systemSymbolName: symbol, accessibilityDescription: nil), content: host)
        panel.title = title
        panel.onClose = { [weak self] in
            if ws == self?.workspace { self?.auxDockPanels[id] = nil }
            st.auxPanels[id] = nil
            self?.activeDock?.savedPlacements[id] = nil   // × 로 닫음 → 자리 기록도 지움 (#4)
        }
        st.auxPanels[id] = panel
        if ws == workspace { auxDockPanels[id] = panel }
        return panel
    }

    // Reload a file's editor model from disk (after an agent-edit revert).
    private func reloadIfOpen(_ path: String) {
        guard let ws = workspace, state(for: ws).openTabs.contains(path),
              let content = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        editor.close(path: path)
        editor.open(path: path, content: content)
    }

    /// Build a group of agent panes the way the user describes it: the MAIN agent owns one whole
    /// vertical slot on the left, and the members fill the slot next to it top-to-bottom, at most
    /// THREE per slot; a fourth member starts a new slot to the right.
    ///
    ///     ┌──────┬────────┬────────┐
    ///     │ 리드 │ 멤버1  │ 멤버4  │
    ///     │      │ 멤버2  │        │
    ///     │      │ 멤버3  │        │
    ///     └──────┴────────┴────────┘
    ///
    /// The slots are created FIRST, while each still holds a single pane, and only then filled
    /// downward. Done the other way round the next slot nests inside one cell of the previous slot
    /// instead of standing on its own.
    private func createAgentGroup(_ requested: String, _ specs: [(name: String, agent: String?, model: String?, parent: Int?)]) {
        guard let dock = activeDock, let ws = workspace, !specs.isEmpty else { return }
        let st = state(for: ws)
        // 그룹 이름이 곧 식별자다(탭·조직도·riven_ask_agent 가 이름으로 찾는다). 같은 이름으로
        // 또 만들면 두 그룹이 하나로 합쳐져 보이므로, 살아 있는 그룹과 겹치지 않게 번호를 붙인다.
        let group = uniqueGroupName(requested)
        func makeMember(_ i: Int) -> DockPanel {
            let spec = specs[i]
            let p = makeChatPanel(for: st, agent: spec.agent, model: spec.model)
            p.title = "\(group) · \(spec.name)"          // the tab says which group it belongs to
            p.agentName = spec.name                       // rail shows the nickname
            p.chatNickname = spec.name; p.chatGroup = group   // persisted with the layout
            let parentName = spec.parent.flatMap { $0 >= 0 && $0 < specs.count ? specs[$0].name : nil }
            p.chatParent = parentName; p.chatModel = spec.model
            let chat = p.content as? ChatPanel
            chat?.nickname = spec.name; chat?.groupName = group; chat?.parentName = parentName
            return p
        }
        let main = makeMember(0)
        dock.addPanel(main, reference: dock.activeGroup ?? dock.groups.last, direction: .right)
        let members = Array(specs.indices.dropFirst())
        guard !members.isEmpty else { dock.setActive(main.group ?? dock.activeGroup!); return }
        let perSlot = 3
        var slotHeads: [DockPanel] = []
        for start in stride(from: 0, to: members.count, by: perSlot) {
            let p = makeMember(members[start])
            dock.addPanel(p, reference: (slotHeads.last ?? main).group, direction: .right, activate: false)
            slotHeads.append(p)
        }
        for (sIdx, head) in slotHeads.enumerated() {
            var tail = head
            for k in 1..<perSlot {
                let i = sIdx * perSlot + k
                guard i < members.count else { break }
                let p = makeMember(members[i])
                dock.addPanel(p, reference: tail.group, direction: .down, activate: false)
                tail = p
            }
            dock.equalizeSiblings(of: tail.group)      // 한 칸 안의 가로줄을 균등하게
        }
        dock.equalizeSiblings(of: slotHeads.last?.group)   // 칸끼리도 균등하게
        // 옆에 설정 패널(에이전트 그룹)이 있으면 반반이 되어 그룹이 절반에 갇힌다. 그룹 쪽이
        // 대부분을 갖게 하고 패널은 조직도를 볼 만큼만 남긴다.
        dock.giveMajority(to: main.group, fraction: 0.72)
        dock.setActive(main.group ?? dock.activeGroup!)
        refreshDockTabs(); refreshRailAgents()
        // 만든 그룹의 조직도로 바로 넘어간다 (패널은 그대로 둔다 — 방금 만든 구조를 확인하고
        // 다른 그룹으로 옮겨 다니는 게 자연스럽다).
        saveGroupRoster(group)
        teamPanel.show(group: group)
        // Tell the main agent who its team is (with the reporting lines), so it can delegate at once.
        (main.content as? ChatPanel)?.noteTeam(group, specs.dropFirst().map { s in
            let par = s.parent.flatMap { $0 >= 0 && $0 < specs.count ? specs[$0].name : nil }
            return par.map { "\(s.name) ← \($0)" } ?? s.name
        })
    }

    // ---- agent teams -------------------------------------------------------------------
    // Every chat pane is an independent agent (its own session, context and role). These two verbs
    // turn that into a TEAM: an agent can see its peers and delegate work to one, then continue with
    // the answer. Hand-offs are visible in the target's transcript, so the user can watch or step in.
    /// 지금 워크스페이스의 채팅 팬.
    private func agentPanes() -> [(panel: DockPanel, chat: ChatPanel)] {
        guard let dock = activeDock else { return [] }
        return dock.groups.flatMap { $0.panels }.compactMap { p in
            (p.content as? ChatPanel).map { (panel: p, chat: $0) }
        }
    }

    private func wsScopeReport() {
        // 파일 감시 경로: 다른 워크스페이스에서 .md 가 생겨도 지금 보는 쪽에 뜨면 안 된다.
        if let mineWS = workspace, let theirs = workspaces.first(where: { $0 != mineWS }) {
            let f = theirs.appendingPathComponent("에이전트문서.md")
            try? "# 저쪽 문서\n".write(to: f, atomically: true, encoding: .utf8)
            surfaceAgentMarkdown(f.path, ws: theirs)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self else { return }
                RLog.log("WSSCOPE md: 내쪽 메모패널=\(self.states[mineWS]?.auxPanels["notes"] != nil) (거짓이어야 정상)"
                         + " 저쪽 메모패널=\(self.states[theirs]?.auxPanels["notes"] != nil) (참이어야 정상)"
                         + " 저쪽에 뜬 문서=\(self.states[theirs]?.notes?.debugCurrentPath() ?? "없음")")
            }
        }
        // 다른 워크스페이스의 팬이 돌기 시작해도, 보고 있는 워크스페이스에 조직도가
        // 새로 생기면 안 된다 (예전에는 teamPanel 이 "지금 보는 곳" 을 가리켜 그랬다).
        if let mineWS = workspace, let theirs = allAgentPanes().first(where: { $0.ws != mineWS }) {
            let hadTeamHere = state(for: mineWS).team != nil
            theirs.chat.ask("1만 답해. 다른 말 금지.") { _ in }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                RLog.log("WSSCOPE 저쪽 팬 상태=\(theirs.chat.runState)")
                RLog.log("WSSCOPE 내쪽 조직도 생김=\(!hadTeamHere && self.state(for: mineWS).team != nil) (거짓이어야 정상)")
            }
        }
        // 메모/문서도 브라우저와 같아야 한다: 다른 워크스페이스의 에이전트가 쓴 문서가
        // 지금 보고 있는 워크스페이스에 뜨면 안 된다.
        if let mineWS = workspace,
           let theirs = allAgentPanes().first(where: { $0.ws != mineWS }) {
            _ = theirs.chat.onNoteTool?("riven_doc_write",
                                        ["path": "docs/저쪽메모.md", "body": "# 저쪽\n다른 워크스페이스 문서"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self else { return }
                let here = FileManager.default.fileExists(atPath: mineWS.appendingPathComponent("docs/저쪽메모.md").path)
                let there = FileManager.default.fileExists(atPath: theirs.ws.appendingPathComponent("docs/저쪽메모.md").path)
                RLog.log("WSSCOPE 문서: 내쪽에 생김=\(here) 저쪽에 생김=\(there)")
                RLog.log("WSSCOPE 메모패널 같은인스턴스=\(self.state(for: mineWS).notes === self.state(for: theirs.ws).notes)")
            }
        }
        let all = allAgentPanes()
        guard let mine = all.first(where: { $0.ws == workspace }),
              let theirs = all.first(where: { $0.ws != workspace }) else {
            RLog.log("WSSCOPE 팬이 모자람 (\(all.map { $0.ws.lastPathComponent }))"); return
        }
        RLog.log("WSSCOPE 보고있는곳=\(workspace?.lastPathComponent ?? "?") 다른곳=\(theirs.ws.lastPathComponent)")
        // 다른 워크스페이스의 에이전트가 브라우저를 연다.
        theirs.chat.onOpenBrowser?("https://example.com")
        // 내 워크스페이스의 에이전트도 하나 연다.
        mine.chat.onOpenBrowser?("https://developer.apple.com")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self else { return }
            let here = self.state(for: mine.ws).preview?.debugURL() ?? "(없음)"
            let there = self.state(for: theirs.ws).preview?.debugURL() ?? "(없음)"
            RLog.log("WSSCOPE 내워크스페이스 브라우저=\(here)")
            RLog.log("WSSCOPE 다른워크스페이스 브라우저=\(there)")
            RLog.log("WSSCOPE 같은인스턴스=\(self.state(for: mine.ws).preview === self.state(for: theirs.ws).preview)")
            RLog.log("WSSCOPE 동료목록(내쪽)\n\(mine.chat.onAgentPanes?() ?? "")")
            RLog.log("WSSCOPE done")
        }
    }

    /// 모든 워크스페이스의 채팅 팬 (지금 보고 있는 것 먼저).
    ///
    /// 에이전트는 사용자가 어느 워크스페이스를 보고 있든 계속 일한다. 위임 대상 찾기를
    /// 활성 워크스페이스로만 한정하면, 다른 프로젝트로 옮겨 본 순간 같은 팀원이 "없는 이름"이
    /// 되어 위임이 실패한다 (실제로 그렇게 실패했다).
    private func allAgentPanes() -> [(panel: DockPanel, chat: ChatPanel, ws: URL)] {
        var out: [(panel: DockPanel, chat: ChatPanel, ws: URL)] = []
        var seen = Set<ObjectIdentifier>()
        func collect(_ dock: DockManager?, _ ws: URL) {
            guard let dock else { return }
            for p in dock.groups.flatMap({ $0.panels }) {
                guard let c = p.content as? ChatPanel, seen.insert(ObjectIdentifier(p)).inserted else { continue }
                out.append((panel: p, chat: c, ws: ws))
            }
        }
        if let ws = workspace { collect(activeDock, ws) }
        for ws in workspaces where ws != workspace { collect(state(for: ws).dock, ws) }
        return out
    }
    /// 그룹 명단을 워크스페이스에 저장한다. 패널을 닫아도 조직도에 남기고 다시 열 수 있어야
    /// 하므로, 살아 있는 팬 + 이미 저장돼 있던 멤버를 합쳐 기록한다 (닫힌 멤버는 마지막 세션
    /// id 를 들고 있어 --resume 으로 대화까지 되살아난다).
    private func saveGroupRoster(_ group: String) {
        guard let ws = workspace else { return }
        var byName: [String: [String: String]] = [:]
        for m in savedRoster(ws, group) { byName[m["name"] ?? ""] = m }
        for p in agentPanes() where p.chat.groupName == group {
            byName[p.chat.agentRole] = [
                "name": p.chat.agentRole,
                "agent": p.chat.agentPersona ?? "",
                "model": p.chat.preferredModel ?? "",
                "parent": p.chat.parentName ?? "",
                "sid": p.panel.sessionId ?? byName[p.chat.agentRole]?["sid"] ?? "",
                // 고른 아바타. 명단에도 남겨야 팬을 닫았다 조직도에서 되살릴 때 얼굴이 유지된다.
                "avatar": p.panel.chatAvatar ?? "",
            ]
        }
        let order = agentPanes().filter { $0.chat.groupName == group }.map { $0.chat.agentRole }
        let rest = byName.keys.filter { !order.contains($0) }.sorted()
        let list = (order + rest).compactMap { byName[$0] }
        if let d = try? JSONSerialization.data(withJSONObject: list),
           let json = String(data: d, encoding: .utf8) {
            Settings.shared.set("group.\(ws.path)|\(group)", json)
        }
    }
    /// 닫힌 그룹 팬의 마지막 상태를 명단에 남긴다.
    private func noteClosedAgent(_ group: String, _ p: DockPanel) {
        guard let ws = workspace else { return }
        var list = savedRoster(ws, group)
        let name = p.chatNickname ?? p.agentName ?? ""
        guard !name.isEmpty else { return }
        let entry = ["name": name, "agent": p.chatAgent ?? "", "model": p.chatModel ?? "",
                     "parent": p.chatParent ?? "", "sid": p.sessionId ?? "",
                     "avatar": p.chatAvatar ?? ""]
        if let i = list.firstIndex(where: { $0["name"] == name }) { list[i] = entry } else { list.append(entry) }
        if let d = try? JSONSerialization.data(withJSONObject: list),
           let json = String(data: d, encoding: .utf8) {
            Settings.shared.set("group.\(ws.path)|\(group)", json)
        }
        teamPanel.refresh()
    }

    private func savedRoster(_ ws: URL, _ group: String) -> [[String: String]] {
        let json = Settings.shared.string("group.\(ws.path)|\(group)", "")
        guard let d = json.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: d) as? [[String: String]] else { return [] }
        return list
    }
    /// 이 워크스페이스에 기록된 모든 그룹 이름.
    private func savedGroupNames(_ ws: URL) -> [String] {
        Settings.shared.keys(prefix: "group.\(ws.path)|").map { String($0.dropFirst("group.\(ws.path)|".count)) }
    }

    /// 에이전트가 워크스페이스 안에 쓴 .md 를 메모 패널의 문서 쪽에서 연다.
    /// 짧은 시간에 여러 개를 쓰면 마지막 것만 띄운다 (파일마다 패널이 튀지 않게).
    private var lastMarkdownSurface = Date.distantPast
    private func surfaceAgentMarkdown(_ path: String, ws: URL) {
        guard path.lowercased().hasSuffix(".md") else { return }
        let url = URL(fileURLWithPath: path)
        guard AppDelegate.isInside(url, ws), FileManager.default.fileExists(atPath: path) else { return }
        guard Date().timeIntervalSince(lastMarkdownSurface) > 1.5 else { return }
        lastMarkdownSurface = Date()
        // 그 문서가 속한 워크스페이스에 연다. 예전에는 ws 를 인자로 받고도 무시한 채
        // "지금 보고 있는" 워크스페이스에 메모 패널을 열고 거기에 남의 문서를 띄웠다 —
        // 에이전트에게 시켜 놓고 다른 워크스페이스로 옮기면 그대로 겪는다.
        ensureAux("notes", in: ws)
        notes(for: ws).open(url)
    }

    /// 심볼릭 링크와 ".." 를 모두 편 절대 경로.
    /// resolvingSymlinksInPath 는 **존재하는** 경로만 편다(그래서 /private/tmp 를 /tmp 로 줄이는
    /// 것도 존재할 때뿐이다). 아직 없는 파일에 그대로 쓰면 같은 폴더인데도 한쪽만 줄어들어
    /// 비교가 깨진다. 존재하는 조상까지 올라가 편 뒤 나머지 조각을 다시 붙인다.
    static func resolved(_ url: URL) -> URL {
        let std = url.standardizedFileURL
        let fm = FileManager.default
        var trail: [String] = []
        var cur = std
        while !fm.fileExists(atPath: cur.path), cur.pathComponents.count > 1 {
            trail.append(cur.lastPathComponent)
            cur = cur.deletingLastPathComponent()
        }
        var out = cur.resolvingSymlinksInPath()
        for c in trail.reversed() { out.appendPathComponent(c) }
        return out
    }
    /// child 가 parent 안에 있는가 (경로 조각 단위 비교라 "/ws" 와 "/ws-evil" 을 구분한다).
    static func isInside(_ child: URL, _ parent: URL) -> Bool {
        let c = resolved(child).pathComponents, p = resolved(parent).pathComponents
        return c.count > p.count && Array(c.prefix(p.count)) == p
    }

    /// Groups that actually exist right now, read off the live panes — name → members with their
    /// reporting lines. Drives the panel's group chips and its org chart.
    private func liveAgentGroups() -> [(group: String, members: [AgentNode])] {
        var out: [String: [AgentNode]] = [:]
        var order: [String] = []
        for p in agentPanes() {
            guard let g = p.chat.groupName else { continue }
            if out[g] == nil { order.append(g) }
            out[g, default: []].append(AgentNode(name: p.chat.agentRole, persona: p.chat.agentPersona,
                                                 model: p.chat.preferredModel,
                                                 parent: p.chat.parentName, open: true,
                                                 avatar: p.panel.chatAvatar))
        }
        // 닫힌 멤버를 명단에서 채운다 — 그룹 전체를 닫아도 탭과 조직도는 남는다.
        if let ws = workspace {
            for g in savedGroupNames(ws) {
                let live = Set((out[g] ?? []).map { $0.name })
                let closed = savedRoster(ws, g).filter { !live.contains($0["name"] ?? "") }.map {
                    AgentNode(name: $0["name"] ?? "", persona: ($0["agent"] ?? "").isEmpty ? nil : $0["agent"],
                              model: ($0["model"] ?? "").isEmpty ? nil : $0["model"],
                              parent: ($0["parent"] ?? "").isEmpty ? nil : $0["parent"],
                              open: false,
                              avatar: ($0["avatar"] ?? "").isEmpty ? nil : $0["avatar"])
                }
                guard !closed.isEmpty || out[g] != nil else { continue }
                if out[g] == nil { order.append(g) }
                out[g, default: []].append(contentsOf: closed)
            }
        }
        return order.map { (group: $0, members: out[$0] ?? []) }
    }

    /// 지금 열려 있는 그룹과 겹치지 않는 이름 ("팀" → "팀 2" → "팀 3").
    private func uniqueGroupName(_ base: String) -> String {
        let taken = Set(agentPanes().compactMap { $0.chat.groupName })
        guard taken.contains(base) else { return base }
        var n = 2
        while taken.contains("\(base) \(n)") { n += 1 }
        return "\(base) \(n)"
    }

    /// Apply org-chart edits to the live pane: nickname, model, reporting line. The model change
    /// goes over the running session's control channel, so nothing restarts; every field is also
    /// written onto the DockPanel so it survives in the layout snapshot.
    private func editAgentPane(_ group: String, _ old: String, name: String, model: String?,
                               parent: String?, avatar: String? = nil) {
        for p in agentPanes() where p.chat.groupName == group {
            if p.chat.agentRole == old {
                p.chat.applyNickname(name)
                p.chat.parentName = parent
                if p.chat.preferredModel != model { p.chat.applyModel(model) }
                p.panel.chatNickname = name; p.panel.agentName = name
                p.panel.chatParent = parent; p.panel.chatModel = model
                p.panel.chatAvatar = avatar          // nil = 이름에서 자동 배정으로 되돌리기
                p.panel.title = "\(group) · \(name)"
            } else if p.chat.parentName == old {
                // 이름이 바뀌면 그를 상사로 두던 팬들의 보고 라인도 따라가야 한다.
                p.chat.parentName = name; p.panel.chatParent = name
            }
        }
        saveGroupRoster(group)
        refreshDockTabs(); refreshRailAgents(); teamPanel.refresh()
    }

    /// 기존 그룹에 멤버를 하나 더 연다. 자리 규칙은 생성 때와 같다: 마지막 칸이 3개 미만이면
    /// 그 칸 아래로, 꽉 찼으면 오른쪽에 새 칸을 만든다.
    private func addAgentToGroup(_ group: String, name: String, persona: String?, model: String?,
                                 parent: String?, avatar: String? = nil) {
        guard let dock = activeDock, let ws = workspace else { return }
        let st = state(for: ws)
        let mates = agentPanes().filter { $0.chat.groupName == group }
        let uniqueName = mates.contains { $0.chat.agentRole == name } ? "\(name) 2" : name
        let p = makeChatPanel(for: st, agent: persona, model: model)
        p.title = "\(group) · \(uniqueName)"
        p.agentName = uniqueName; p.chatNickname = uniqueName; p.chatGroup = group
        p.chatParent = parent; p.chatModel = model; p.chatAgent = persona
        p.chatAvatar = avatar
        let chat = p.content as? ChatPanel
        chat?.nickname = uniqueName; chat?.groupName = group; chat?.parentName = parent
        let members = mates.filter { $0.chat.parentName != nil }
        if members.count % 3 == 0, let anchor = (members.last ?? mates.first)?.panel.group {
            dock.addPanel(p, reference: anchor, direction: .right)     // 새 칸
        } else if let last = members.last?.panel.group {
            dock.addPanel(p, reference: last, direction: .down)        // 같은 칸 아래
        } else {
            dock.addPanel(p, reference: mates.first?.panel.group ?? dock.activeGroup, direction: .right)
        }
        saveGroupRoster(group)
        refreshDockTabs(); refreshRailAgents(); teamPanel.refresh()
    }

    /// 멤버를 그룹에서 완전히 뺀다: 팬을 닫고, 명단에서 지우고, 그를 상사로 두던 멤버는
    /// 메인 직속으로 올린다 (조직도에 끊긴 가지가 남지 않게).
    private func removeAgentFromGroup(_ group: String, _ name: String) {
        guard let ws = workspace, let dock = activeDock else { return }
        let mainName = agentPanes().first { $0.chat.groupName == group && $0.chat.parentName == nil }?.chat.agentRole
        for p in agentPanes() where p.chat.groupName == group && p.chat.parentName == name {
            p.chat.parentName = mainName; p.panel.chatParent = mainName
        }
        if let victim = agentPanes().first(where: { $0.chat.groupName == group && $0.chat.agentRole == name }) {
            victim.panel.chatGroup = nil          // 닫기 훅이 명단에 다시 넣지 않도록
            dock.removePanel(victim.panel)
        }
        var list = savedRoster(ws, group).filter { $0["name"] != name }
        for i in list.indices where list[i]["parent"] == name { list[i]["parent"] = mainName ?? "" }
        if let d = try? JSONSerialization.data(withJSONObject: list),
           let json = String(data: d, encoding: .utf8) {
            Settings.shared.set("group.\(ws.path)|\(group)", json)
        }
        refreshDockTabs(); refreshRailAgents(); teamPanel.refresh()
    }

    /// 그룹을 통째로 지운다: 진행 중인 턴을 멈추고, 모든 팬을 닫고, 저장된 명단도 지운다.
    @discardableResult
    private func deleteGroup(_ group: String) -> String {
        guard let dock = activeDock, let ws = workspace else { return "unavailable" }
        let panes = agentPanes().filter { $0.chat.groupName == group }
        for p in panes {
            p.chat.stopTurn()        // 돌고 있으면 먼저 멈춘다
            p.panel.chatGroup = nil       // 닫기 훅이 명단에 되돌려 넣지 않도록
            dock.removePanel(p.panel)     // onClose → teardown 으로 프로세스 종료
        }
        Settings.shared.remove("group.\(ws.path)|\(group)")
        refreshDockTabs(); refreshRailAgents(); teamPanel.refresh()
        return t("team.groupDeleted", ["group": group, "n": panes.count])
    }

    /// Jump to one agent's pane (org chart node click).
    private func focusAgentPane(_ group: String, _ name: String) {
        guard let dock = activeDock, let ws = workspace else { return }
        let bench = ProcessInfo.processInfo.environment["RIVEN_FOCUSTIME"] != nil
        let t0 = Date()
        for p in agentPanes() where p.chat.groupName == group && p.chat.agentRole == name {
            let tScan = Date()
            if let g = p.panel.group {
                g.select(id: p.panel.id)
                let tSelect = Date()
                dock.setActive(g)
                let tActive = Date()
                if bench {
                    func ms(_ a: Date, _ b: Date) -> Int { Int(b.timeIntervalSince(a) * 1000) }
                    RLog.log("FOCUSTIME scan=\(ms(t0, tScan))ms select=\(ms(tScan, tSelect))ms "
                           + "setActive=\(ms(tSelect, tActive))ms total=\(ms(t0, tActive))ms")
                }
            }
            return
        }
        // 닫힌 멤버 → 저장해 둔 역할·모델·세션으로 되살린다.
        guard let m = savedRoster(ws, group).first(where: { $0["name"] == name }) else { return }
        let st = state(for: ws)
        let sid = m["sid"] ?? "", persona = m["agent"] ?? "", model = m["model"] ?? ""
        let p = makeChatPanel(for: st, resume: sid.isEmpty ? nil : sid,
                              agent: persona.isEmpty ? nil : persona,
                              model: model.isEmpty ? nil : model)
        p.title = "\(group) · \(name)"
        p.agentName = name; p.chatNickname = name; p.chatGroup = group
        p.chatParent = (m["parent"] ?? "").isEmpty ? nil : m["parent"]
        p.chatModel = model.isEmpty ? nil : model
        p.chatAvatar = (m["avatar"] ?? "").isEmpty ? nil : m["avatar"]   // 되살려도 같은 얼굴
        let chat = p.content as? ChatPanel
        chat?.nickname = name; chat?.groupName = group; chat?.parentName = p.chatParent
        // 원래 자리로 되돌린다: 같은 그룹의 다른 멤버가 있으면 그 아래(같은 칸)로, 멤버가
        // 하나도 없으면 리드 옆 칸으로. 그냥 활성 팬 옆에 붙이면 칸 구조가 무너진다.
        let mates = agentPanes().filter { $0.chat.groupName == group }
        let lastMember = mates.last { $0.chat.parentName != nil || $0.chat.agentRole != name }
        if let member = mates.last(where: { $0.chat.parentName != nil }) ?? lastMember, member.chat.parentName != nil {
            dock.addPanel(p, reference: member.panel.group, direction: .down)
        } else if let lead = mates.first(where: { $0.chat.parentName == nil }) {
            dock.addPanel(p, reference: lead.panel.group, direction: .right)
        } else {
            dock.addPanel(p, reference: dock.activeGroup ?? dock.groups.last, direction: .right)
        }
        refreshDockTabs(); refreshRailAgents()
        teamPanel.refresh()
        (p.content as? ChatPanel)?.noteSystem(t("team.reopened", ["name": name]))
    }

    /// Fan out to several panes at once. Every ask is dispatched in the SAME runloop turn, so the
    /// peers' claude processes run concurrently; the completion fires when the last one answers.
    /// `each` 는 한 명이 답할 때마다 그 이름으로 불린다 (팀 입력줄이 도착 순서를 보여준다).
    private func askAgentPanes(_ tasks: [(agent: String, message: String)], from sender: ChatPanel?,
                               inGroup: String? = nil, each: ((String) -> Void)? = nil,
                               _ done: @escaping ([(String, String)]) -> Void) {
        var answers = [String?](repeating: nil, count: tasks.count)
        var left = tasks.count
        for (i, task) in tasks.enumerated() {
            askAgentPane(task.agent, task.message, from: sender, inGroup: inGroup) { answer in
                // 콜백은 전부 메인 스레드(세션 이벤트)에서 온다 — 잠금 없이 안전하다.
                guard answers[i] == nil else { return }
                answers[i] = answer
                left -= 1
                each?(task.agent)
                if left == 0 { done(tasks.enumerated().map { ($1.agent, answers[$0] ?? "") }) }
            }
        }
    }

    /// 부른 팬과 같은 워크스페이스의 채팅 팬들. 워크스페이스가 다르면 남의 일감이다 —
    /// 이름이 같은 "멤버1" 이 여러 프로젝트에 있을 수 있고, 남의 프로젝트에 일이 넘어가면
    /// 그 워크스페이스의 패널까지 건드리게 된다.
    private func agentPanes(near sender: ChatPanel?) -> [(panel: DockPanel, chat: ChatPanel, ws: URL)] {
        let all = allAgentPanes()
        let home = all.first { $0.chat === sender }?.ws ?? workspace
        return all.filter { $0.ws == home }
    }

    private func agentPanesReport(near sender: ChatPanel? = nil) -> String {
        let panes = agentPanes(near: sender)
        guard !panes.isEmpty else { return "(no agent panes open)" }
        return panes.map { p in
            let state = p.chat.isBusy ? "busy" : "idle"
            let role = p.chat.agentPersona.map { " (\($0))" } ?? ""
            let grp = p.chat.groupName.map { "[\($0)] " } ?? ""
            let up = p.chat.parentName.map { " ← \($0)" } ?? ""   // 보고 라인 (조직도)
            return "- \(grp)\(p.chat.agentRole)\(role)\(up)  \(state)"
        }.joined(separator: "\n")
    }
    /// Deliver `message` to the agent named/identified by `target` and return its answer.
    /// `target` matches a pane id, an agent role, or a panel title (case-insensitive).
    /// `inGroup` 이 있으면 그 그룹 안에서만 찾는다 (팀 입력줄). 이름은 그룹마다 따로라서,
    /// "리드" 가 두 그룹에 있을 때 전역 검색으로 떨어지면 남의 팀에 일이 넘어간다.
    private func askAgentPane(_ target: String, _ message: String, from sender: ChatPanel?,
                              inGroup: String? = nil,
                              _ done: @escaping (String) -> Void) {
        let q = target.trimmingCharacters(in: .whitespaces).lowercased()
        let panes = agentPanes(near: sender).map { (panel: $0.panel, chat: $0.chat) }
            .filter { $0.chat !== sender }      // never delegate to yourself
        // 같은 그룹 동료를 먼저 본다 — 그룹이 여러 개면 "리드" 같은 닉네임이 겹칠 수 있고,
        // 그때 남의 팀 사람에게 일이 넘어가면 안 된다.
        let mates = (inGroup ?? sender?.groupName).map { g in panes.filter { $0.chat.groupName == g } } ?? []
        let inMates = mates.first { $0.chat.agentRole.lowercased() == q }
            ?? mates.first { ($0.chat.agentPersona ?? "").lowercased() == q }
        let hit = inGroup != nil ? inMates
            : inMates
            ?? panes.first { $0.chat.agentRole.lowercased() == q }
            ?? panes.first { ($0.chat.agentPersona ?? "").lowercased() == q }
            ?? panes.first { $0.panel.id.lowercased() == q }
            ?? panes.first { $0.panel.title.lowercased().contains(q) }
        guard let hit else {
            done("no agent matched \(target). Open one with riven_open_panel(chat) or pick from:\n"
                 + agentPanesReport(near: sender))
            return
        }
        hit.panel.badge = hit.panel.badge ?? "busy"
        refreshDockTabs(); refreshRailAgents()
        // 조직도에 흐르는 선으로 보여준다: 누가 누구에게, 무슨 일을, 얼마나 오래.
        // sender 가 nil 이면 사용자가 팀 입력줄에서 직접 보낸 것이다.
        let flow = teamPanel.beginFlow(group: hit.chat.groupName, from: sender?.agentRole,
                                       to: hit.chat.agentRole, summary: ChatPanel.shortTitle(message))
        hit.chat.ask(message) { [weak self] answer in
            self?.teamPanel.endFlow(flow, ok: !answer.hasPrefix("agent session is not running"))
            done(answer)
        }
    }

    /// 벤치용: 리드 패널의 입력창에서 한 줄 보낸 것과 같은 경로.
    private func mentionFromLead(_ text: String) {
        agentPanes().first { $0.chat.groupName == "배포팀" && $0.chat.parentName == nil }?
            .chat.debugSendInput(text)
    }

    /// riven_browser_* 의 실제 동작. WKWebView 는 메인 스레드 전용이라 여기서 한 번 더 맞춘다
    /// (도구 호출은 소켓 스레드에서 들어온다).
    private func handleBrowserTool(_ verb: String, _ args: [String: Any], in ws: URL,
                                   _ done: @escaping (String) -> Void) {
        func onMain(_ body: @escaping () -> Void) {
            if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
        }
        onMain { [weak self] in
            guard let self else { done("riven is shutting down"); return }
            self.ensureAux("preview", in: ws)
            let p = self.preview(for: ws)
            func str(_ k: String) -> String? { (args[k] as? String).flatMap { $0.isEmpty ? nil : $0 } }
            func num(_ k: String) -> Double? {
                (args[k] as? NSNumber)?.doubleValue ?? (args[k] as? Double) ?? (args[k] as? Int).map(Double.init)
            }
            switch verb {
            case "riven_browser_open":
                done(p.agentNavigate(str("url") ?? "", newTab: (args["new_tab"] as? Bool) ?? false,
                                     profile: str("profile") ?? ""))
            case "riven_browser_state":
                done(p.agentState())
            case "riven_browser_go":
                done(p.agentGo(str("action") ?? ""))
            case "riven_browser_tab":
                done(p.agentTab(str("action") ?? "", index: num("index").map { Int($0) }))
            case "riven_browser_read":
                p.agentRead(selector: str("selector"), html: (args["html"] as? Bool) ?? false, done)
            case "riven_browser_click":
                guard let sel = str("selector") else { done("selector is required"); return }
                p.agentClick(sel, done)
            case "riven_browser_fill":
                guard let sel = str("selector") else { done("selector is required"); return }
                p.agentFill(sel, (args["value"] as? String) ?? "",
                            submit: (args["submit"] as? Bool) ?? false, done)
            case "riven_browser_wait":
                guard let sel = str("selector") else { done("selector is required"); return }
                p.agentWait(sel, timeoutMs: Int(num("timeout_ms") ?? 5000), done)
            case "riven_browser_scroll":
                p.agentScroll(selector: str("selector"), y: num("y"), done)
            case "riven_browser_eval":
                guard let js = str("js") else { done("js is required"); return }
                p.agentEval(js, done)
            default:
                done("unknown browser verb: \(verb)")
            }
        }
    }

    // riven tools called by the CLI running in a TERMINAL pane. The actions are app-level, so this
    // reuses the same verbs the native chat exposes; `ask_user` has no chat card to draw here, so it
    // asks with a modal (the terminal agent is blocked waiting for the answer either way).
    private func handleTerminalTool(_ id: String, _ tool: String, _ args: [String: Any],
                                    _ srv: ChatAskServer, cwd: String? = nil) {
        func s(_ k: String) -> String { args[k] as? String ?? "" }
        // 부른 CLI 의 작업 폴더로 워크스페이스를 정한다. 릴레이가 이 값을 실어 보내므로,
        // 사용자가 지금 다른 워크스페이스를 보고 있어도 그쪽 화면을 건드리지 않는다.
        let owner = workspaceContaining(cwd) ?? workspace
        switch tool {
        case "ask_user":
            let opts = args["options"] as? [String] ?? []
            let a = NSAlert()
            a.messageText = s("question").isEmpty ? t("title.terminal") : s("question")
            a.alertStyle = .informational
            for o in opts.prefix(3) { a.addButton(withTitle: o) }
            if opts.isEmpty { a.addButton(withTitle: t("common.ok")) }
            let idx = a.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            srv.resolve(id, result: opts.indices.contains(idx) ? opts[idx] : (opts.first ?? "ok"))
        case "riven_open_file":
            let p = s("path")
            let line = (args["line"] as? NSNumber)?.intValue ?? (args["line"] as? Int) ?? 1
            openFileAt(URL(fileURLWithPath: p), line: line, column: 1)
            srv.resolve(id, result: "opened \(p) in riven editor")
        case "riven_open_browser":
            guard let ws = owner else { srv.resolve(id, result: "no workspace"); return }
            ensureAux("preview", in: ws)
            preview(for: ws).openURLString(s("url"))
            srv.resolve(id, result: "opened \(s("url")) in riven preview panel")
        case "riven_screenshot":
            guard let ws = owner else { srv.resolve(id, result: "no workspace"); return }
            ensureAux("preview", in: ws)
            let p = preview(for: ws)
            let u = args["url"] as? String
            if let u { p.openURLString(u) }
            DispatchQueue.main.asyncAfter(deadline: .now() + (u == nil ? 0.2 : 1.6)) {
                p.capture { path in
                    srv.resolve(id, result: path.map { "screenshot saved to \($0) (read it with the Read tool)" } ?? "screenshot failed")
                }
            }
        case "riven_browser_open", "riven_browser_state", "riven_browser_go", "riven_browser_read",
             "riven_browser_tab",
             "riven_browser_click", "riven_browser_fill", "riven_browser_wait", "riven_browser_scroll",
             "riven_browser_eval":
            // 터미널 에이전트에는 승인 카드를 띄울 대화창이 없다. eval 만 모달로 묻는다.
            if tool == "riven_browser_eval" {
                let a = NSAlert()
                a.messageText = t("browser.eval.confirm", ["o": owner.map { preview(for: $0).currentOrigin } ?? ""])
                a.informativeText = String((args["js"] as? String ?? "").prefix(400))
                a.addButton(withTitle: t("common.confirm")); a.addButton(withTitle: t("common.cancel"))
                guard a.runModal() == .alertFirstButtonReturn else {
                    srv.resolve(id, result: t("browser.eval.denied")); return
                }
            }
            guard let ws = owner else { srv.resolve(id, result: "no workspace"); return }
            handleBrowserTool(tool, args, in: ws) { srv.resolve(id, result: $0) }
        case "riven_api_request":
            let hdrs = (args["headers"] as? [String: Any])?.map { "\($0.key): \($0.value)" }.joined(separator: "\n") ?? ""
            guard let ws = owner else { srv.resolve(id, result: "no workspace"); return }
            ensureAux("api", in: ws)
            api(for: ws).run(method: s("method").isEmpty ? "GET" : s("method"), url: s("url"), headers: hdrs, body: s("body"))
            srv.resolve(id, result: "ran \(s("method")) \(s("url")) in riven's API panel")
        case "riven_panels":
            guard let ws = owner, let dock = state(for: ws).dock else { srv.resolve(id, result: "(no dock)"); return }
            var out: [String] = []
            for g in dock.groups { for p in g.panels { out.append("- id=\(p.id) kind=\(panelKind(p)) title=\(p.title)") } }
            srv.resolve(id, result: "workspace: \(ws.path)\npanels:\n" + out.joined(separator: "\n"))
        case "riven_open_panel":
            let kind = s("kind")
            switch kind {
            case "editor": showEditorPane()
            case "terminal": newTerminal()
            case "chat": newChat()
            case "search", "git", "preview", "api", "changes", "notes", "team":
                if auxDockPanels[kind] == nil { toggleDockPanel(kind) }
            default: srv.resolve(id, result: "unknown kind: \(kind)"); return
            }
            srv.resolve(id, result: "opened \(kind)")
        case "riven_close_panel":
            let pid = s("id")
            if let dock = activeDock {
                for g in dock.groups { for p in g.panels where p.id == pid { dock.removePanel(p); refreshRailAgents(); srv.resolve(id, result: "closed \(pid)"); return } }
            }
            srv.resolve(id, result: "no panel with id \(pid)")
        case "riven_agents":
            srv.resolve(id, result: agentPanesReport())
        case "riven_ask_agent":
            askAgentPane(s("agent"), s("message"), from: nil) { srv.resolve(id, result: $0) }
        case "riven_workspaces":
            srv.resolve(id, result: workspaces.map { ($0 == workspace ? "* " : "- ") + $0.path }.joined(separator: "\n"))
        case "riven_open_workspace":
            let url = URL(fileURLWithPath: s("path")).standardizedFileURL.resolvingSymlinksInPath()
            if let existing = workspaces.first(where: { $0.path == url.path }) { activate(existing); srv.resolve(id, result: "switched to \(url.path)"); return }
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue {
                let ws = uniqueWorkspaceURL(for: url); rail.addWorkspace(ws); activate(ws)
                srv.resolve(id, result: "opened \(url.path)")
            } else { srv.resolve(id, result: "not a folder: \(s("path"))") }
        case let n where n.hasPrefix("riven_note_"):
            srv.resolve(id, result: runNoteTool(tool, args))
        default:
            srv.resolve(id, result: "unknown tool: \(tool)")
        }
    }

    // MARK: - riven_note_* (메모/문서)

    /// 에이전트가 메모를 읽고 쓰는 경로. 채팅 팬과 터미널 팬이 같은 구현을 쓴다.
    ///
    /// 되돌리기 어려운 동작을 확인 없이 하느냐: 메모 덮어쓰기는 확인 없이 하되 이전 내용을
    /// 반드시 백업으로 남긴다. mcp__riven__* 도구는 이미 자동 승인되는 구조라 여기만 모달을
    /// 띄우면 헤드리스 턴이 멈춰 버리고, 사용자에게는 "확인을 눌렀는지"보다 "무엇이 바뀌었고
    /// 되돌릴 수 있는지"가 실질적인 안전장치다. 그래서 덮어쓰기 = 백업 + 패널 표시 + 되돌리기
    /// 버튼으로 간다. 반면 워크스페이스의 실제 파일(riven_note_save_file)은 사용자의 소스라
    /// 이미 있는 파일을 덮어쓰지 않는다 (overwrite=true 를 명시해야 한다).
    private func runNoteTool(_ tool: String, _ args: [String: Any], in owner: URL? = nil) -> String {
        func s(_ k: String) -> String { (args[k] as? String) ?? "" }
        // 부른 쪽의 워크스페이스. 메모·문서는 그 프로젝트의 것이라, 사용자가 지금 다른
        // 워크스페이스를 보고 있다고 해서 거기에 쓰이면 안 된다 (브라우저와 같은 문제였다).
        guard let ws = owner ?? workspace else { return "no workspace is open" }
        notes(for: ws).flush()      // 사용자가 쓰던 중이면 먼저 저장 (에이전트 쓰기에 묻히지 않게)

        func describe(_ n: Note) -> String {
            "- \(n.title)  [\(n.scope == .personal ? "note" : "doc")]  \(n.url.path)"
        }
        /// 메모가 바뀐 걸 사용자가 보게 한다: 패널을 열고, 목록을 새로 읽고, 표시를 남긴다.
        func surface(_ url: URL) {
            ensureAux("notes", in: ws)
            notes(for: ws).noteChangedByAgent(url)
        }

        switch tool {
        case "riven_note_list":
            let scope = s("scope").isEmpty ? "all" : s("scope")
            var out: [String] = []
            if scope != "docs" { out += NoteStore.personal(ws).map(describe) }
            if scope != "notes" { out += NoteStore.workspaceDocs(ws).map(describe) }
            return out.isEmpty ? "(no notes yet)" : out.joined(separator: "\n")

        case "riven_note_read":
            guard let n = NoteStore.find(s("note"), ws: ws) else { return "note not found: \(s("note"))" }
            return n.read()

        case "riven_note_write":
            let title = s("title"), bodyText = s("body")
            let target = s("note")
            if !target.isEmpty, let existing = NoteStore.find(target, ws: ws) {
                NoteStore.write(NoteStore.compose(title: title.isEmpty ? existing.title : title,
                                                  body: bodyText), to: existing.url)   // backup 남김
                surface(existing.url)
                return "replaced note \"\(existing.title)\" (\(existing.url.path)). "
                     + "The previous version is kept; the user can undo it from the Notes panel."
            }
            let n = NoteStore.create(in: ws, title: title, body: bodyText)
            surface(n.url)
            return "created note \"\(n.title)\" (\(n.url.path))"

        case "riven_note_append":
            guard let n = NoteStore.find(s("note"), ws: ws) else { return "note not found: \(s("note"))" }
            let old = n.read()
            let sep = old.hasSuffix("\n") || old.isEmpty ? "" : "\n"
            NoteStore.write(old + sep + s("body") + "\n", to: n.url, backup: false)   // 덧붙이기는 잃는 게 없다
            surface(n.url)
            return "appended to \"\(n.title)\" (\(n.url.path))"

        case "riven_doc_write":
            // 문서화 = 저장소에 남는 파일. 메모(스크래치)와 확실히 갈라 둔다.
            var rel = s("path")
            if rel.isEmpty { return "path is required" }
            if !rel.lowercased().hasSuffix(".md") { rel += ".md" }
            let dest = rel.hasPrefix("/") ? URL(fileURLWithPath: rel) : ws.appendingPathComponent(rel)
            guard AppDelegate.isInside(dest, ws) else {
                return "refusing to write outside the workspace: \(AppDelegate.resolved(dest).path)"
            }
            let exists = FileManager.default.fileExists(atPath: dest.path)
            if exists, (args["overwrite"] as? Bool) != true {
                return "\(dest.path) already exists. Pass overwrite=true if you really mean to replace it."
            }
            try? FileManager.default.createDirectory(at: dest.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            guard NoteStore.write(s("body"), to: dest, backup: exists) else { return "could not write \(dest.path)" }
            surface(dest)
            return "wrote \(dest.path)"

        case "riven_note_save_file":
            guard let n = NoteStore.find(s("note"), ws: ws) else { return "note not found: \(s("note"))" }
            var rel = s("path")
            if rel.isEmpty { return "path is required" }
            if !rel.lowercased().hasSuffix(".md") { rel += ".md" }
            let dest = rel.hasPrefix("/") ? URL(fileURLWithPath: rel)
                                          : ws.appendingPathComponent(rel)
            // 워크스페이스 밖으로는 쓰지 않는다 (../.. 로 홈 디렉터리를 건드리는 걸 막는다).
            // 두 경로를 같은 방식으로 펴서 비교해야 한다: standardizedFileURL 은 디렉터리 쪽만
            // /private/tmp 를 /tmp 로 줄여서, 같은 폴더인데도 접두사가 어긋났다. 또 문자열
            // 접두사는 "/ws" 옆의 "/ws-evil" 까지 통과시키므로 경로 조각 단위로 본다.
            let destPath = AppDelegate.resolved(dest).path
            guard AppDelegate.isInside(dest, ws) else {
                return "refusing to write outside the workspace: \(destPath)"
            }
            let exists = FileManager.default.fileExists(atPath: destPath)
            if exists, (args["overwrite"] as? Bool) != true {
                return "\(destPath) already exists. Pass overwrite=true if you really mean to replace it."
            }
            try? FileManager.default.createDirectory(at: dest.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            guard NoteStore.write(n.read(), to: dest, backup: exists) else { return "could not write \(destPath)" }
            surface(dest)
            return "saved \"\(n.title)\" to \(destPath)"

        default:
            return "unknown note tool: \(tool)"
        }
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
        // Restore the pinned-usage state the user left it in (was saved but never re-applied,
        // so the pin was lost every launch). Deferred so the sidebar layout has settled.
        if Settings.shared.bool("usagePinned", false) {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.pinnedUsage == nil else { return }
                RLog.log("usage: restoring pinned state")
                self.pinUsage()
            }
        }
        statusBar.onReloadUsage = { [weak self] in self?.refreshUsage(force: true) }
        NotificationCenter.default.addObserver(forName: .rivenUsageModeChanged, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.statusBar.setUsage(limits: self.lastLimits, today: self.lastToday)
            self.updateHeaderUsage(limits: self.lastLimits, today: self.lastToday)
            self.rebuildPinnedUsage()
            if self.headerUsagePopover?.isShown == true { self.rebuildUsagePopover() }
        }
        refreshUsage()
        usageTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refreshUsage() }
    }
    /// 턴이 끝날 때마다 부른다. 여러 팬이 거의 동시에 끝나면 API 를 그만큼 두드리게 되므로
    /// 3초 안의 요청은 하나로 합친다 (버튼으로 부를 때는 force 로 즉시).
    private var lastUsageRefresh = Date.distantPast
    private func refreshUsageAfterTurn() {
        guard Date().timeIntervalSince(lastUsageRefresh) > 3 else { return }
        refreshUsage()
    }
    /// 마지막 조회가 어떻게 끝났는지. 실패를 감추면 화면은 옛 숫자를 그대로 들고 있고
    /// 사용자에게는 "갱신이 안 된다" 로 보인다 (실제로 그렇게 보였다).
    private(set) var lastUsageOutcome: Usage.Outcome = .ok
    /// Codex 쪽 최신값 (없으면 Codex 를 안 쓰는 사람이다 — 화면에 내보내지 않는다).
    private var lastCodexLimits: CodexUsage.Limits?
    private var lastCodexToday = CodexUsage.Today()
    private func refreshUsage(force: Bool = false) {
        // 사용자가 openusage 같은 걸 같이 띄워 두면 같은 엔드포인트를 함께 두드리게 된다.
        // 우리 쪽에서 불필요하게 겹쳐 부르지 않도록 최소 간격을 둔다 (버튼은 예외).
        if !force, Date().timeIntervalSince(lastUsageRefresh) < 20 { return }
        lastUsageRefresh = Date()
        DispatchQueue.global(qos: .utility).async {
            let t = Usage.today()
            let cx = CodexUsage.scan()
            DispatchQueue.main.async { self.lastCodexToday = cx.today; self.lastCodexLimits = cx.limits }
            // Show today's $cost right away (riven's fallback) so the widget is never
            // empty; upgrade to session%·weekly% if the plan-limits API resolves.
            DispatchQueue.main.async { self.lastToday = t; self.statusBar.setUsage(limits: self.lastLimits, today: t); self.updateHeaderUsage(limits: self.lastLimits, today: t); self.rebuildPinnedUsage() }
            Usage.limits { lim in
                DispatchQueue.main.async {
                    self.lastUsageOutcome = lim.outcome
                    // 값이 왔을 때만 숫자를 갈아 끼운다. 실패했을 때는 마지막 숫자를 남겨 두되,
                    // 언제 것인지·왜 못 갱신했는지를 팝오버와 흐린 표시로 알린다.
                    if lim.sessionRemaining != nil || lim.weeklyRemaining != nil { self.lastLimits = lim }
                    self.statusBar.setUsage(limits: self.lastLimits, today: t)
                    self.updateHeaderUsage(limits: self.lastLimits, today: t)
                    self.rebuildPinnedUsage()
                }
            }
        }
    }

    // 헤더 사용량: Claude 는 세션%·주간%, Codex 는 창 하나. 둘 다 "남은" 비율이다.
    //
    // 한 줄에 나란히 놓기 때문에 방향이 같아야 한다 — Codex 는 "쓴 %" 로 주는 것을
    // [[CodexUsage]] 가 뒤집어 둔다. 안 그러면 "12%" 가 넉넉하다는 뜻인지 얼마 안 남았다는
    // 뜻인지 화면에서 구분되지 않는다.
    //
    // 안 쓰는 CLI 는 아예 내보내지 않는다. Claude 만 쓰는 사람 헤더에 죽은 눈금이 남으면
    // 그건 정보가 아니라 잡음이다.
    private func updateHeaderUsage(limits: Usage.Limits?, today: Usage.Today?) {
        var parts: [String] = []
        let s = limits?.sessionRemaining, w = limits?.weeklyRemaining
        if let s, let w { parts.append("\(UsageUI.shown(s))% · \(UsageUI.shown(w))%") }
        else if let s { parts.append("\(UsageUI.shown(s))%") }
        if let cx = lastCodexLimits { parts.append("◎ \(UsageUI.shown(cx.remainingPercent))%") }
        if !parts.isEmpty {
            // Claude 쪽 숫자가 있을 때만 앞에 표식을 단다 — 하나뿐이면 표식이 군더더기다.
            if parts.count > 1, s != nil { parts[0] = "✳ " + parts[0] }
            headerUsage.stringValue = parts.joined(separator: "   ")
            headerUsageItem.isHidden = false
        }
        else if let c = today?.totalCost, c > 0 { headerUsage.stringValue = String(format: "$%.2f", c); headerUsageItem.isHidden = false }
        else { headerUsageItem.isHidden = true }
        // 오래된 숫자는 흐리게. 5분 넘게 갱신되지 않았으면 지금 값이 아니다.
        // (아직 한 번도 못 불러온 상태는 흐리게 하지 않는다 — 그냥 뜨는 중이다.)
        let stale = Usage.lastSuccess.map { Date().timeIntervalSince($0) > 300 } ?? false
        headerUsage.alphaValue = stale ? 0.45 : 1
        headerUsageItem.toolTip = UsageUI.modeSuffix() + " · " + usageFreshness()
    }
    /// "방금 갱신" / "12분 전 · 로그인 정보가 만료돼 갱신하지 못했습니다" 같은 한 줄.
    func usageFreshness() -> String {
        var when = t("usage.never")
        if let s = Usage.lastSuccess {
            let m = Int(Date().timeIntervalSince(s) / 60)
            when = m < 1 ? t("usage.justNow") : t("usage.minsAgo", ["n": String(m)])
        }
        switch lastUsageOutcome {
        case .ok: return when
        case .noToken: return when + " · " + t("usage.noToken")
        case .unauthorized: return when + " · " + t("usage.unauthorized")
        case .rateLimited(let sec):
            return when + " · " + t("usage.rateLimited", ["n": String(sec ?? 60)])
        case .failed(let why): return when + " · " + t("usage.failed", ["msg": why])
        }
    }
    /// 열려 있는 팝오버의 내용만 갈아 끼운다 (닫았다 여는 것과 달리 위치가 유지된다).
    private func rebuildUsagePopover() {
        headerUsagePopover?.contentViewController?.view = UsageUI.content(
            limits: lastLimits, today: lastToday, freshness: usageFreshness(),
            codexLimits: lastCodexLimits, codexToday: lastCodexToday,
            onReload: { [weak self] in self?.refreshUsage(force: true) },
            onPin: { [weak self] in self?.headerUsagePopover?.close(); self?.pinUsage() })
    }

    @objc private func headerUsageClicked() {
        if headerUsagePopover?.isShown == true { headerUsagePopover?.close(); return }
        let pop = headerUsagePopover ?? NSPopover()
        pop.behavior = .transient
        pop.contentViewController = NSViewController()
        pop.contentViewController?.view = UsageUI.content(
            limits: lastLimits, today: lastToday, freshness: usageFreshness(),
            codexLimits: lastCodexLimits, codexToday: lastCodexToday,
            onReload: { [weak self] in self?.refreshUsage(force: true) },
            onPin: { [weak self] in self?.headerUsagePopover?.close(); self?.pinUsage() })
        headerUsagePopover = pop
        pop.show(relativeTo: headerUsageItem.bounds, of: headerUsageItem, preferredEdge: .maxY)
    }

    // Pin the usage view to the bottom of the sidebar (riven's UsagePinned). Reserves
    // a strip at the bottom of the sidebar container and hides the status-bar widget.
    // Height of the pinned usage strip. It is MEASURED from the content (header + session
    // bar + weekly bar + optional today line, each including its reset-time line) rather
    // than a fixed constant — a fixed 118pt clipped the bottom rows, which is why the
    // session/weekly reset times went missing when pinned. Recomputed on every rebuild so
    // it stays correct as the content changes.
    private var pinnedUsageH: CGFloat = 118
    private func measuredPinnedHeight(_ v: NSView, width: CGFloat) -> CGFloat {
        v.frame = NSRect(x: 0, y: 0, width: width, height: 400)
        v.layoutSubtreeIfNeeded()
        return max(96, ceil(v.fittingSize.height))
    }
    private func pinUsage() {
        guard pinnedUsage == nil, let sc = sidebarContainer else { return }
        Settings.shared.set("usagePinned", true)
        let v = makePinnedUsage()
        pinnedUsageH = measuredPinnedHeight(v, width: sc.bounds.width)
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
        title.font = UIScale.font(UIScale.caption, .semibold); title.textColor = Theme.fgDim
        title.translatesAutoresizingMaskIntoConstraints = false; box.addSubview(title)
        let unpin = NSButton(title: " 고정 해제", target: self, action: #selector(unpinUsageMenu))
        unpin.image = NSImage(systemSymbolName: "pin.slash", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .regular))
        unpin.imagePosition = .imageLeading; unpin.isBordered = false
        unpin.font = UIScale.font(UIScale.caption); unpin.contentTintColor = Theme.fgDim
        unpin.translatesAutoresizingMaskIntoConstraints = false; box.addSubview(unpin)
        let content = UsageUI.pinnedContent(limits: lastLimits, today: lastToday,
                                            codexLimits: lastCodexLimits,
                                            codexToday: lastCodexToday) { }
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
            content.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            // Drives the box's height from its content so the strip fits without clipping.
            content.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -8)
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
        let newH = measuredPinnedHeight(v, width: sc.bounds.width)
        v.frame = NSRect(x: 0, y: 0, width: sc.bounds.width, height: newH)
        v.autoresizingMask = [.width, .maxYMargin]
        sc.addSubview(v); pinnedUsage = v
        // If the content's height changed (e.g. a reset line appeared), re-offset the split
        // above the strip by the delta so nothing overlaps or leaves a gap.
        if newH != pinnedUsageH, let sv = sidebarSplit {
            let delta = newH - pinnedUsageH
            var f = sv.frame; f.origin.y += delta; f.size.height -= delta; sv.frame = f
            pinnedUsageH = newH
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) {
        notesPanel?.flush(); persistSession(); Settings.shared.flush(sync: true)
        SupabaseAuth.shared.flushOnQuit()   // 클라우드에는 나가는 길에 한 번만 올린다
        lsp.stopAll()
    }
}

// App-level chrome re-themes with the rest (window/root/terminal well), and the
// editor is told the new shiki theme so Monaco re-highlights live.
extension AppDelegate: Themable {
    func applyTheme() {
        window.backgroundColor = Theme.bg
        rootView?.layer?.backgroundColor = Theme.bg.cgColor
        dockHost?.layer?.backgroundColor = Theme.bg.cgColor
        sidebarContainer?.layer?.backgroundColor = Theme.bg2.cgColor
        headerStrip?.layer?.backgroundColor = Theme.bg2.cgColor
        sidebarHeadStrip?.layer?.backgroundColor = Theme.bg2.cgColor
        // 사이드바에 고정한 사용량 칸은 만들 때 색을 구워 넣는다 — 통째로 다시 만든다.
        rebuildPinnedUsage()
        sidebarHeadButton?.contentTintColor = Theme.fgDim
        headerHairline?.layer?.backgroundColor = Theme.hairline.cgColor
        headerLabel?.textColor = Theme.fg
        headerIcon?.contentTintColor = Theme.fgDim
        headerUsage?.textColor = Theme.fgDim
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
        // 400 == the save/restore cap. Previously this allowed 480 while save/restore capped at 400,
        // so dragging into (400,480] was silently NOT persisted (dead zone) and any old 480 artifact
        // restored as the 220 default — the sidebar kept "reverting" to a width the user never set.
        if sv === bodySplit && i == 0 { return 400 }
        // 레일 높이에는 인위적인 상한을 두지 않는다 — 아래 탐색기가 사라지지 않을
        // 최소치(120pt)만 남기고 사이드바 거의 전체 높이까지 끌어올릴 수 있다.
        if sv === sidebarSplit && i == 0 { return max(96, sv.bounds.height - 120) }
        return p
    }
    // Neither the rail nor the sidebar column may collapse to zero (that's what made
    // the workspace area "disappear").
    func splitView(_ sv: NSSplitView, canCollapseSubview view: NSView) -> Bool { false }

    /// 구분선은 1pt 로 그리되, **잡히는 영역**은 그보다 넓게 준다.
    ///
    /// 얇은 선은 보기엔 좋지만 1pt 짜리 과녁이다 — 끌려고 누르면 대개 사이드바나 독에
    /// 떨어지고 아무 일도 일어나지 않는다 ("드래그로 크기 조절이 안 된다"). 그리는 선은
    /// 그대로 두고 마우스가 닿는 범위만 양옆으로 넓힌다. macOS 자신도 얇은 구분선에
    /// 이 방식을 쓴다.
    func splitView(_ sv: NSSplitView, effectiveRect proposed: NSRect,
                   forDrawnRect drawn: NSRect, ofDividerAt index: Int) -> NSRect {
        let grab: CGFloat = 5      // 좌우 5pt 씩 → 실질 11pt (사이드바 안쪽 여백이 12pt 라 안전)
        return sv.isVertical
            ? drawn.insetBy(dx: -grab, dy: 0)
            : drawn.insetBy(dx: 0, dy: -grab)
    }
    // On window resize, flex the main area and keep the sidebar's width; inside the
    // sidebar, keep the rail's height fixed and flex the explorer below it.
    func splitView(_ sv: NSSplitView, shouldAdjustSizeOfSubview view: NSView) -> Bool {
        // 비교 대상은 반드시 **그 스플릿의 자식** 이어야 한다. 예전에는 sidebarView(=안쪽
        // 세로 스플릿)와 비교했는데 bodySplit 의 자식은 그것을 담고 있는 sidebarContainer 다.
        // 그래서 조건이 늘 참이었고 "사이드바 폭 고정" 은 한 번도 적용되지 않았다 — 창을
        // 400 넓히면 사이드바가 220 → 289 로 같이 늘어났다.
        //
        // 그 결과가 제보된 두 증상이다: 창이 저장할 때보다 크면 켤 때마다 사이드바가
        // 넓어져 있고(복원은 220 을 넣지만 창이 제 크기를 갖는 순간 비례해서 늘어난다),
        // 그 상태에서 구분선을 누르면 상한(400)으로 잘리며 폭이 갑자기 줄어든다.
        if sv === bodySplit { return view !== sidebarContainer }   // 사이드바 폭은 고정
        // (안쪽 세로 스플릿은 rail 이 실제 자식이라 원래도 맞았다.)
        if sv === sidebarSplit { return view !== rail }             // 레일 높이 고정, 탐색기가 늘어남
        return true
    }
    // Persist the divider positions the user drags so they survive across launches. The
    // sidebar width (bodySplit) and rail height (sidebarSplit) are kept fixed on window
    // resize by shouldAdjustSizeOfSubview above, so this only fires with a real user drag
    // for those dimensions. Skip while collapsed (width would be 0) and until the saved
    // geometry has been restored (so initial-layout events don't overwrite it).
    func splitViewDidResizeSubviews(_ notification: Notification) {
        guard sidebarLayoutRestored, let sv = notification.object as? NSSplitView else { return }
        // ONLY persist while the user is actively dragging this split's divider. Window
        // resizes, collapse/expand, pinned-usage shifts and restore all fire this too, and
        // used to save transient MAX values (sidebarWidth=480, railHeight=693 artifacts).
        guard (sv as? PersistingSplitView)?.isUserDragging == true else { return }
        if sv === bodySplit, !sidebarCollapsed, let sb = sv.arrangedSubviews.first {
            let w = sb.frame.width
            if w >= 120 && w <= 400 { sidebarWidth = w; Settings.shared.set("sidebarWidth", Double(w)) }
        } else if sv === sidebarSplit, let railView = sv.arrangedSubviews.first {
            let h = railView.frame.height
            if h >= 48 && h <= 500 { Settings.shared.set("railHeight", Double(h)) }
        }
    }
}

// NSSplitView that knows when the USER is dragging a divider (vs a window-resize / layout /
// collapse pass). Divider dragging is driven by the split view's own mouseDown, which runs a
// modal tracking loop until mouseUp — so isUserDragging is true for exactly that span, and
// persistence can ignore the transient extreme values layout passes produce (which is how
// sidebarWidth/railHeight kept getting saved as their MAX).
final class PersistingSplitView: NSSplitView {
    private(set) var isUserDragging = false
    override func mouseDown(with event: NSEvent) {
        isUserDragging = true
        NotificationCenter.default.post(name: .rivenDividerDragBegan, object: nil)
        super.mouseDown(with: event)
        NotificationCenter.default.post(name: .rivenDividerDragEnded, object: nil)
        isUserDragging = false
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
