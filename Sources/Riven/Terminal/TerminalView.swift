import AppKit
import QuartzCore
import GhosttyKit

// A Metal-backed NSView hosting one libghostty surface (GPU terminal + real
// shell spawned by libghostty). Working directory can be set per instance.
final class TerminalView: NSView, NSMenuItemValidation, Themable {
    private var surface: ghostty_surface_t?
    private var link: CVDisplayLink?
    private let workdir: String?
    private var command: String?          // initial command (agent launch) — runs directly;
                                          // cleared after the first child-exit respawn so the
                                          // pane falls back to a plain shell (see childExited).
    private let env: [String: String]     // extra environment for the surface (session shim)
    var onTitle: ((String) -> Void)?      // OSC 0/2 title from the shell/agent

    // surface pointer → view, so ghostty's per-surface actions (bell / desktop
    // notification) can find the TerminalView that raised them (for tab badges).
    private final class Weak { weak var v: TerminalView?; init(_ v: TerminalView) { self.v = v } }
    private static var registry: [OpaquePointer: Weak] = [:]
    static func view(for surface: ghostty_surface_t?) -> TerminalView? {
        guard let s = surface else { return nil }
        return registry[OpaquePointer(s)]?.v
    }
    // Every live surface (for app-wide config/theme updates).
    static func liveSurfaces() -> [ghostty_surface_t] {
        registry.compactMap { $0.value.v?.surface }
    }
    var onActivity: (() -> Void)?   // bell / notification while this terminal is in the background
    var onFocused: (() -> Void)?    // this terminal took keyboard focus → activate its dock group
    var onBusy: (() -> Void)?       // agent/command started working → busy badge
    var onIdle: (() -> Void)?       // agent/command finished → clear busy badge
    var onTurnDone: (() -> Void)?   // a substantial turn ended while unwatched → notify + attn
    var externalNotifyAt: Date?     // last agent-sent desktop notification (dedup our own)
    // ONE completion notification per user-initiated turn: pressing Enter arms it; the
    // first done-signal notifies and disarms. Stops the 3-notifications-per-command spam
    // (an agent turn has several output bursts, each an idle gap).
    var turnArmed = false
    // The terminal that currently holds focus — used by the clipboard read callback
    // to complete a paste request against the right surface.
    static weak var focused: TerminalView?
    var surfaceHandle: ghostty_surface_t? { surface }

    init(frame: NSRect, workdir: String? = nil, command: String? = nil, env: [String: String] = [:]) {
        self.workdir = workdir
        self.command = command
        self.env = env
        super.init(frame: frame)
        wantsLayer = true
        layer = CAMetalLayer()
        setupSurface()
        setupDisplayLink()
        attnRing.frame = bounds
        attnRing.autoresizingMask = [.width, .height]
        addSubview(attnRing)
        // Finder 등에서 파일/이미지를 끌어다 놓으면 그 경로를 터미널에 입력해 준다
        // (클로드코드 CLI에 이미지를 물릴 때 경로를 직접 치지 않아도 되도록).
        registerForDraggedTypes([.fileURL])
        observeFontSize()
        // 테마를 바꾸면 GhosttyApp.reloadTheme()가 config(=UIScale 기준 font-size)를 모든
        // 서피스에 다시 밀어넣어 설정한 터미널 폰트 크기가 날아간다. 테마 적용 순서상
        // AppDelegate 다음에 불리므로, 여기서 설정값을 다시 세워 되돌린다.
        Theme.register(self)
    }
    required init?(coder: NSCoder) { fatalError() }

    // ---- busy / idle signals ------------------------------------------------
    // These used to be derived by polling the visible viewport (ghostty_surface_read_text
    // every 0.3s, per pane, forever). That call is documented as expensive and not to be
    // polled, and it leaked ~10KB each time — ~9.3MB/min across a normal set of panes,
    // which is where the multi-GB sessions came from.
    //
    // Nothing polls now. The callbacks below are driven by push signals only:
    //   • agent panes  → lifecycle hooks (see [[AgentActivity]]), the authoritative source
    //   • plain shells → Return pressed = busy, ghostty's OSC 133 COMMAND_FINISHED = idle
    //   • anything else→ OSC 9/777 desktop notification, bell, child-exited
    //
    // The old comment here claimed COMMAND_FINISHED was unreliable. That was true of the
    // agent TUIs it was being tested against (they never emit it) but not of plain shells,
    // where OSC 133 is exact — so it is used for shells and hooks cover the agents.

    /// A shell command finished (OSC 133). Routed from [[GhosttyApp]]'s action handler.
    func commandFinished() { onIdle?() }

    /// The surface's process exited (GHOSTTY_ACTION_SHOW_CHILD_EXITED). For an agent pane we
    /// launched the CLI DIRECTLY as the surface command (no shell), so when the user types
    /// `exit` in claude the pty has no shell to fall back to — the terminal goes dead (a
    /// blinking cursor that accepts nothing). Respawn a plain shell in the same workdir/env
    /// so the pane stays usable; the env still carries RIVEN_PANE_SESSION + the ZDOTDIR shim,
    /// so typing `claude` again resumes THIS pane's own conversation. We clear `command` first
    /// so a subsequent `exit` (of the shell) just leaves an ordinary finished terminal rather
    /// than respawning forever.
    func childExited() {
        onIdle?()
        guard command != nil, window != nil else { return }
        RLog.log("childExited: agent command ended → respawning plain shell in pane")
        command = nil
        if let s = surface { TerminalView.registry.removeValue(forKey: OpaquePointer(s)); ghostty_surface_free(s) }
        surface = nil
        setupSurface()
        syncSize()
        if let s = surface, window?.firstResponder === self { ghostty_surface_set_focus(s, true) }
        needsDraw = true
        onCommandExited?()   // the agent/command ended → the pane is a plain shell now
    }
    var onCommandExited: (() -> Void)?

    // riven's state ring (busy = static, attn = travelling ember) overlaid on the
    // terminal. Driven from the panel's badge via setRingState.
    let attnRing = AttnRingView(frame: .zero)
    func setRingState(_ badge: String?) {
        switch badge {
        case "attn": attnRing.state = .attn
        case "busy": attnRing.state = .busy
        default:     attnRing.state = .none
        }
    }

    override var acceptsFirstResponder: Bool { true }

    // ---- mouse → ghostty (click, selection, scroll). Without this ghostty never
    // learns the pointer position, which left a stray cursor at the old spot. ----
    private func mousePos(_ event: NSEvent) {
        guard let s = surface else { return }
        needsDraw = true
        let p = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(s, Double(p.x), Double(bounds.height - p.y), ghosttyMods(event.modifierFlags))
    }
    private func mouseButton(_ event: NSEvent, _ state: ghostty_input_mouse_state_e, _ btn: ghostty_input_mouse_button_e) {
        guard let s = surface else { return }
        mousePos(event)
        _ = ghostty_surface_mouse_button(s, state, btn, ghosttyMods(event.modifierFlags))
    }
    // Clicking anywhere in the terminal body focuses it (riven behaviour).
    override func mouseDown(with event: NSEvent) {
        if window?.firstResponder !== self { window?.makeFirstResponder(self) }
        onFocused?()   // clear this pane's attn even when it was ALREADY focused (a click = "seen")
        mouseButton(event, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT)
    }
    override func mouseUp(with event: NSEvent) { mouseButton(event, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT) }
    override func mouseDragged(with event: NSEvent) { mousePos(event) }
    override func rightMouseUp(with event: NSEvent) { super.rightMouseUp(with: event) }
    override func otherMouseDown(with event: NSEvent) { mouseButton(event, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_MIDDLE) }
    override func otherMouseUp(with event: NSEvent) { mouseButton(event, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_MIDDLE) }
    override func scrollWheel(with event: NSEvent) {
        guard let s = surface else { return }
        needsDraw = true
        var mods: Int32 = 0
        if event.hasPreciseScrollingDeltas { mods |= 1 }   // precision (trackpad)
        ghostty_surface_mouse_scroll(s, Double(event.scrollingDeltaX), Double(event.scrollingDeltaY), mods)
    }
    // ---- 파일 드롭 → 경로를 입력 ----
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation {
        s.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ? .copy : []
    }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { draggingEntered(s) }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let surface,
              let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                            options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty else { return false }
        // 공백·따옴표 등이 있어도 셸에서 한 덩어리로 읽히도록 작은따옴표로 감싼다.
        let text = urls.map { u -> String in
            let p = u.path
            return "'" + p.replacingOccurrences(of: "'", with: "'\\''") + "'"
        }.joined(separator: " ") + " "
        text.withCString { ghostty_surface_text(surface, $0, UInt(strlen($0))) }
        window?.makeFirstResponder(self)
        needsDraw = true
        return true
    }

    override func becomeFirstResponder() -> Bool {
        if let s = surface { ghostty_surface_set_focus(s, true) }
        TerminalView.focused = self
        fullRate = true            // paint streamed agent output promptly while focused
        needsDraw = true
        onFocused?()
        return true
    }
    // Releasing focus MUST tell ghostty, otherwise the surface keeps drawing a solid
    // (focused) block cursor even after another pane takes focus — which shows up as
    // "two cursors" once a second terminal/editor is focused. (ghostty's own macOS app
    // does exactly this in resignFirstResponder.)
    override func resignFirstResponder() -> Bool {
        if let s = surface { ghostty_surface_set_focus(s, false) }
        if TerminalView.focused === self { TerminalView.focused = nil }
        fullRate = false
        needsDraw = true
        return super.resignFirstResponder()
    }

    // Right-click menu: copy / paste / select-all / clear (riven terminal parity).
    override func menu(for event: NSEvent) -> NSMenu? {
        let m = NSMenu()
        let hasSel = surface.map { ghostty_surface_has_selection($0) } ?? false
        let copy = NSMenuItem(title: "복사", action: #selector(ctxCopy), keyEquivalent: "")
        copy.isEnabled = hasSel; copy.target = self
        let paste = NSMenuItem(title: "붙여넣기", action: #selector(ctxPaste), keyEquivalent: "")
        paste.isEnabled = NSPasteboard.general.string(forType: .string) != nil
            || ChatInput.clipboardImagePaths(NSPasteboard.general, quoted: true) != nil
        paste.target = self
        m.addItem(copy); m.addItem(paste)
        m.addItem(.separator())
        let all = NSMenuItem(title: "전체 선택", action: #selector(ctxSelectAll), keyEquivalent: ""); all.target = self
        let clr = NSMenuItem(title: "화면 지우기", action: #selector(ctxClear), keyEquivalent: ""); clr.target = self
        m.addItem(all); m.addItem(clr)
        return m
    }
    @objc private func ctxCopy() {
        guard let s = surface, ghostty_surface_has_selection(s) else { return }
        var t = ghostty_text_s()
        if ghostty_surface_read_selection(s, &t), let ptr = t.text {
            let str = String(decoding: UnsafeRawBufferPointer(start: ptr, count: Int(t.text_len)), as: UTF8.self)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(str, forType: .string)
            ghostty_surface_free_text(s, &t)
        }
    }
    @objc private func ctxPaste() {
        guard let s = surface else { return }
        let pb = NSPasteboard.general
        // Image on the clipboard (a Cmd-Shift-4 screenshot, or copied image files) and no text →
        // save/resolve a path and "type" it, so the CLI running here can Read it. A bare terminal
        // paste only handles text, which is why pasting a screenshot did nothing.
        if pb.string(forType: .string) == nil, let paths = ChatInput.clipboardImagePaths(pb, quoted: true) {
            (paths + " ").withCString { ghostty_surface_text(s, $0, UInt(strlen($0))) }
            return
        }
        guard let str = pb.string(forType: .string) else { return }
        str.withCString { ghostty_surface_text(s, $0, UInt(strlen($0))) }
    }
    @objc private func ctxSelectAll() {
        guard let s = surface else { return }
        _ = "select_all".withCString { ghostty_surface_binding_action(s, $0, UInt(strlen($0))) }
    }
    @objc private func ctxClear() { clearScreen() }

    // Standard Edit-menu shortcuts route to the terminal clipboard when it has focus.
    // The menu items target the responder chain (copy:/paste:/cut:/selectAll:), which the
    // ghostty surface view doesn't implement — so ⌘C/⌘V/⌘X/⌘A did nothing. Bridge them.
    @objc func copy(_ sender: Any?) { ctxCopy() }
    @objc func paste(_ sender: Any?) { ctxPaste() }
    @objc func cut(_ sender: Any?) { ctxCopy() }              // a terminal has no cut → copy
    override func selectAll(_ sender: Any?) { ctxSelectAll() }
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(copy(_:)), #selector(cut(_:)):
            return surface.map { ghostty_surface_has_selection($0) } ?? false
        case #selector(paste(_:)):
            return NSPasteboard.general.string(forType: .string) != nil
                || ChatInput.clipboardImagePaths(NSPasteboard.general, quoted: true) != nil
        default:
            return true
        }
    }

    // DEBUG: directly send a keycode-only key event (e.g. backspace 0x33) to
    // reproduce key-path crashes headlessly.
    func debugSendKeycode(_ keycode: UInt32) {
        guard let s = surface else { return }
        var k = ghostty_input_key_s()
        k.action = GHOSTTY_ACTION_PRESS
        k.keycode = keycode
        k.mods = GHOSTTY_MODS_NONE
        _ = ghostty_surface_key(s, k)
    }

    private func setupSurface() {
        guard let app = GhosttyApp.shared.app else { return }
        var sc = ghostty_surface_config_s()
        sc.platform_tag = GHOSTTY_PLATFORM_MACOS
        sc.platform = ghostty_platform_u(macos: ghostty_platform_macos_s(
            nsview: Unmanaged.passUnretained(self).toOpaque()))
        sc.userdata = Unmanaged.passUnretained(self).toOpaque()
        sc.scale_factor = Double(window?.backingScaleFactor ?? 2.0)
        // 새로 만드는 터미널도 설정값으로 시작한다 (예전에는 13 고정이라 설정이 무시됐다).
        sc.font_size = Float(UIScale.terminalFontSize)
        // Optionally start in a directory, run a command directly (agent launch — e.g.
        // `claude` runs immediately), and inject per-surface env (session shim). ghostty
        // copies the config strings during surface_new, so strdup here + free after is safe.
        var owned: [UnsafeMutablePointer<CChar>] = []
        func dup(_ s: String) -> UnsafePointer<CChar> { let p = strdup(s)!; owned.append(p); return UnsafePointer(p) }
        if let wd = workdir { sc.working_directory = dup(wd) }
        if let cmd = command { sc.command = dup(cmd) }
        var envArr = env.map { ghostty_env_var_s(key: dup($0.key), value: dup($0.value)) }
        if envArr.isEmpty {
            surface = ghostty_surface_new(app, &sc)
        } else {
            envArr.withUnsafeMutableBufferPointer { buf in
                sc.env_vars = buf.baseAddress
                sc.env_var_count = buf.count
                surface = ghostty_surface_new(app, &sc)
            }
        }
        owned.forEach { free($0) }
        if let s = surface {
            TerminalView.registry[OpaquePointer(s)] = Weak(self)
            let scale = Double(window?.backingScaleFactor ?? 2.0)
            ghostty_surface_set_content_scale(s, scale, scale)
            // Start unfocused; the dock's onActivate makes the active terminal first
            // responder, which sets focus=true. Only ONE surface is ever focused, so
            // only one solid cursor is drawn.
            ghostty_surface_set_focus(s, false)
        }
    }

    // ghostty in this build does NOT emit GHOSTTY_ACTION_RENDER, so we draw every
    // display-link frame like ghostty's own POC (≈4% CPU for one terminal). needsDraw
    // is kept as a harmless hint but not gated on — the real CPU hog was elsewhere
    // (Usage.today() created an ISO8601DateFormatter per log line). To keep many/hidden
    // terminals cheap the link is PAUSED while occluded (setOccluded).
    private var needsDraw = true
    func setNeedsDraw() { needsDraw = true }
    private func drawIfNeeded() {
        guard let s = surface else { return }
        ghostty_surface_draw(s)
    }
    // After a keystroke the echo returns from the PTY a moment later; force a few draws so
    // the typed characters appear immediately even if the display-link poll is momentarily
    // starved by the editor WebView on the main thread (the "my input doesn't show" bug).
    private func kickEchoDraws() {
        for delay in [0.0, 0.02, 0.05, 0.1] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.drawIfNeeded() }
        }
    }

    private var frameTick: UInt64 = 0   // display-link-thread only
    // The FOCUSED terminal draws every frame (60fps); others every other frame (30fps).
    // Why: ghostty doesn't emit a render event here, so painting relies on this poll. An
    // agent (claude) STREAMS output with no user interaction, and at 30fps under main-thread
    // contention that output could sit unpainted until you scrolled/clicked (a plain shell
    // never showed it because you'd just typed, forcing a draw). Full-rate for the one pane
    // you're actually using fixes that; background terminals stay at 30fps so they don't
    // contend with the editor WKWebView.
    private var fullRate = false
    private func setupDisplayLink() {
        CVDisplayLinkCreateWithActiveCGDisplays(&link)
        guard let link else { return }
        CVDisplayLinkSetOutputCallback(link, { (_, _, _, _, _, ctx) -> CVReturn in
            let view = Unmanaged<TerminalView>.fromOpaque(ctx!).takeUnretainedValue()
            view.frameTick &+= 1
            if view.fullRate || view.frameTick & 1 == 0 { DispatchQueue.main.async { view.drawIfNeeded() } }
            return kCVReturnSuccess
        }, Unmanaged.passUnretained(self).toOpaque())
        CVDisplayLinkStart(link)
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        syncSize()
    }

    // Sync ghostty's surface size to the current bounds. Called on every layout so
    // the terminal fills its pane correctly even when created before the split has
    // been positioned (which otherwise left it narrow/broken on first open).
    override func layout() {
        super.layout()
        syncSize()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Pause the GPU draw loop (and ghostty occlusion) whenever this terminal leaves
        // the window — a hidden dock tab or an inactive workspace's terminal must not
        // keep rendering every frame (that's what multiplied idle CPU across terminals).
        if window == nil {
            if let l = link { CVDisplayLinkStop(l) }
            if let s = surface { ghostty_surface_set_occlusion(s, false) }
        } else {
            if let s = surface { ghostty_surface_set_occlusion(s, true) }
            if let l = link, CVDisplayLinkIsRunning(l) == false { CVDisplayLinkStart(l) }
            syncSize()
        }
    }
    private func syncSize() {
        needsDraw = true
        guard let s = surface, bounds.width > 1, bounds.height > 1 else { return }
        // Match ghostty's macOS SurfaceView exactly: the Metal layer's
        // contentsScale MUST equal the display's backingScaleFactor, or the GPU
        // renders at 1x while the size is in 2x pixels → tiny text. Size is the
        // backing (pixel) size; content scale is the backing/points ratio.
        if let window = window { layer?.contentsScale = window.backingScaleFactor }
        let backing = convertToBacking(bounds)
        // Keep the Metal drawable exactly the backing-pixel size, or shrinking the
        // window leaves parts of the terminal unpainted / clipped.
        (layer as? CAMetalLayer)?.drawableSize = CGSize(width: backing.width, height: backing.height)
        ghostty_surface_set_size(s, UInt32(backing.width), UInt32(backing.height))
        let xScale = bounds.width > 0 ? backing.width / bounds.width : 2
        let yScale = bounds.height > 0 ? backing.height / bounds.height : 2
        ghostty_surface_set_content_scale(s, Double(xScale), Double(yScale))
    }

    // Send raw text to the shell (e.g. a `cd` command). Used to re-root the
    // terminal without recreating the surface (recreating crashes libghostty).
    func sendText(_ text: String) {
        guard let s = surface else { return }
        text.withCString { ghostty_surface_text(s, $0, UInt(strlen($0))) }
    }
    // Press Enter as a real key event — sending "\r"/"\n" as TEXT does NOT execute a
    // command (the pty gets a bare CR), so command-running paths must use this.
    func sendEnter() {
        guard let s = surface else { return }
        var k = ghostty_input_key_s()
        k.action = GHOSTTY_ACTION_PRESS
        k.keycode = 0x24   // macOS Return
        k.mods = GHOSTTY_MODS_NONE
        _ = ghostty_surface_key(s, k)
    }
    // Type a command and run it (press Enter as a key event).
    func runCommand(_ cmd: String) {
        sendText(cmd)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.sendEnter() }
    }

    // Clear the screen + scrollback (⌘K), matching riven's terminal clear. Uses
    // ghostty's own keybinding action rather than emitting an escape sequence.
    func clearScreen() {
        guard let s = surface else { return }
        let action = "clear_screen"
        _ = action.withCString { ghostty_surface_binding_action(s, $0, UInt(strlen($0))) }
    }
    // Live font zoom (⌘+/⌘-/⌘0) via ghostty's own font-size bindings.
    private func fontAction(_ name: String) {
        guard let s = surface else { return }
        _ = name.withCString { ghostty_surface_binding_action(s, $0, UInt(strlen($0))) }
    }
    func adjustFontSize(_ delta: Int) { fontAction(delta >= 0 ? "increase_font_size:1" : "decrease_font_size:1") }
    func resetFontSize() { fontAction("reset_font_size") }
    // 설정(터미널 폰트 크기)을 절대값으로 적용한다. ghostty의 set_font_size는 상대 조정과
    // 달리 누적 오차 없이 정확히 그 크기로 맞춰준다. 이 액션이 없는 빌드에서는
    // reset(=config의 font-size) 후 그만큼 상대 조정하는 경로로 물러선다.
    func setFontSize(_ size: Int) {
        guard let s = surface else { return }
        let abs = "set_font_size:\(size)"
        let ok = abs.withCString { ghostty_surface_binding_action(s, $0, UInt(strlen($0))) }
        guard !ok else { return }
        fontAction("reset_font_size")
        let delta = size - UIScale.terminalFontSize   // reset은 config의 font-size로 돌아간다
        if delta > 0 { fontAction("increase_font_size:\(delta)") }
        else if delta < 0 { fontAction("decrease_font_size:\(-delta)") }
    }
    private func applySettingsFontSize() { setFontSize(UIScale.terminalFontSize) }
    // 색은 GhosttyApp이 서피스 단위로 갱신한다 — 여기서는 그때 함께 초기화되는 폰트
    // 크기만 설정값으로 되돌린다.
    func applyTheme() { applySettingsFontSize() }
    // 설정 → 일반 → 터미널 폰트 크기 변경을 살아있는 모든 터미널에 즉시 반영.
    private var fontObserver: Any?
    private func observeFontSize() {
        fontObserver = NotificationCenter.default.addObserver(forName: .rivenFontSizeChanged, object: nil, queue: .main) { [weak self] _ in
            self?.applySettingsFontSize()
        }
    }

    // Give this terminal keyboard focus (⌘J). Making the NSView first responder
    // triggers becomeFirstResponder, which forwards focus to the ghostty surface.
    func focusTerminal() {
        window?.makeFirstResponder(self)
        // Assert ghostty focus EVEN IF we were already first responder — after a
        // workspace swap the view can stay first responder while the surface lost
        // focus, so keystrokes went nowhere until you clicked again.
        if let s = surface { ghostty_surface_set_focus(s, true) }
        TerminalView.focused = self
        fullRate = true
        needsDraw = true
    }

    // Pause/resume drawing when this terminal is hidden behind another tab.
    func setOccluded(_ occluded: Bool) {
        guard let s = surface else { return }
        ghostty_surface_set_occlusion(s, !occluded)
        if occluded { CVDisplayLinkStop(link!) } else if let l = link { CVDisplayLinkStart(l) }
    }

    // Tear down when the terminal panel is closed: stop the display link first
    // (so its callback can't touch a freed surface), then free the surface.
    func dispose() {
        if let o = fontObserver { NotificationCenter.default.removeObserver(o); fontObserver = nil }
        if let l = link { CVDisplayLinkStop(l) }
        link = nil
        if let s = surface { TerminalView.registry.removeValue(forKey: OpaquePointer(s)); ghostty_surface_free(s) }
        surface = nil
    }

    // cd into a directory (quoted) + newline.
    func changeDirectory(_ path: String) {
        let escaped = path.replacingOccurrences(of: "'", with: "'\\''")
        sendText(" cd '\(escaped)'\n")
    }

    // IME state (Korean/CJK composition) — see NSTextInputClient below.
    private var markedText = ""
    private var pendingText: String?   // committed text captured by insertText during a keyDown

    private func ghosttyMods(_ f: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var m: UInt32 = 0
        if f.contains(.shift) { m |= GHOSTTY_MODS_SHIFT.rawValue }
        if f.contains(.control) { m |= GHOSTTY_MODS_CTRL.rawValue }
        if f.contains(.option) { m |= GHOSTTY_MODS_ALT.rawValue }
        if f.contains(.command) { m |= GHOSTTY_MODS_SUPER.rawValue }
        return ghostty_input_mods_e(m)
    }

    // Send a ghostty key event. keycode = macOS virtual keycode (libghostty maps
    // it internally); printable text (>= 0x20) is attached so letters/한글 print,
    // while backspace/enter/arrows carry only the keycode.
    //
    // keycodeOverride lets a caller detach the attached TEXT from the triggering
    // event's keycode. This exists for one reason: Return/Tab/Escape/keypad-Enter
    // are "commit + action" keys in Korean IME — the final composed syllable is
    // committed (via insertText) by the SAME keystroke that also has to fire the
    // key's own action (submit the line / indent / cancel). If we sent one event
    // with keycode = Return AND that text attached, ghostty treats it as the
    // Return action and the attached syllable is dropped — see keyDown below.
    // Overriding to a neutral keycode (0x00, 'a' with no modifiers — a key with
    // no keybinding of its own) makes ghostty fall back to printing `.text`
    // instead of running the Return/Tab/Escape action, so the syllable prints.
    private func sendKeyEvent(_ event: NSEvent, action: ghostty_input_action_e, text: String?, keycodeOverride: UInt32? = nil) {
        guard let s = surface else { return }
        var k = ghostty_input_key_s()
        k.action = action
        k.keycode = keycodeOverride ?? UInt32(event.keyCode)
        // A neutral override keycode must not carry the original event's modifiers
        // either (e.g. leftover shift) — keep it a plain, unbound keystroke so only
        // the attached text is observable.
        k.mods = keycodeOverride != nil ? GHOSTTY_MODS_NONE : ghosttyMods(event.modifierFlags)
        if let text, let first = text.utf8.first, first >= 0x20 {
            text.withCString { k.text = $0; _ = ghostty_surface_key(s, k) }
        } else {
            _ = ghostty_surface_key(s, k)
        }
    }

    // macOS virtual keycodes that both COMMIT IME text and carry their own action:
    // Return, keypad Enter, Tab, Escape. For these, the committed syllable and the
    // key's action must be sent as TWO separate ghostty_surface_key events (see
    // keyDown) — otherwise ghostty prioritizes the action and the text is lost.
    private static let commitActionKeycodes: Set<UInt16> = [0x24, 0x4C, 0x30, 0x35]

    // Key flow — matches ghostty's official macOS app (Surface.keyDown):
    // interpretKeyEvents routes the event to the IME, which calls back into
    // insertText / setMarkedText / doCommand. We do NOT send anything to the
    // shell from those callbacks; instead insertText only *captures* the
    // committed text into pendingText. Then, back here, we emit ghostty_surface_key
    // event(s) carrying that committed text.
    //
    // This is the critical difference from the old code (which called
    // ghostty_surface_text directly): a printable char sent via
    // ghostty_surface_text bypasses ghostty's key pipeline, and its cursor
    // bookkeeping diverged from the shell's echoed cursor — that mismatch was
    // rendered as TWO cursors on different rows. Routing everything through
    // ghostty_surface_key keeps one authoritative cursor. It also fixes
    // Enter-first-press: a plain Enter produces no insertText, so pendingText
    // stays nil and we emit a keycode-only Return in the same pass.
    //
    // Korean (and other CJK) IMEs keep the LAST composed syllable in the preedit
    // until a following keystroke commits it. When that following keystroke is
    // Return/Tab/Escape/keypad-Enter (e.g. pressing Return to submit a line),
    // interpretKeyEvents commits the syllable via insertText in the SAME keyDown
    // that must also fire Return's own action. Sending one event with
    // keycode=Return AND that text attached made ghostty run the Return action
    // and silently drop the attached text — the reported bug (issue #11): the
    // final syllable vanished on every Enter-to-submit. The fix: for these
    // "commit + action" keys, send the committed text FIRST under a neutral
    // keycode (so ghostty prints it, not interprets it as Return), THEN send the
    // real key as a keycode-only event so the line still submits / tab still
    // fires. For an ordinary letter/number key committing the PREVIOUS syllable
    // mid-composition, the single combined event is correct as before — the
    // committed text is attached to a plain letter keycode ghostty already just
    // prints, and resending that key would double-type it.
    override func keyDown(with event: NSEvent) {
        needsDraw = true
        kickEchoDraws()   // ensure typed characters paint promptly
        // Return submits a line → the pane is working until the shell reports the command
        // finished (OSC 133). For an agent pane this is a no-op: its hook events are
        // authoritative and main.swift ignores these once the pane is hook-backed.
        if event.keyCode == 0x24 { turnArmed = true; onBusy?() }
        if event.modifierFlags.contains(.command) { super.keyDown(with: event); return }
        pendingText = nil
        interpretKeyEvents([event])
        // Committed text (a letter, or a finished 한글 syllable) → one key event
        // carrying the keycode + text. Sent even while a NEW composition is in
        // progress, so a syllable that commits as another begins isn't dropped.
        if let t = pendingText, !t.isEmpty {
            if TerminalView.commitActionKeycodes.contains(event.keyCode) {
                // Print the committed syllable under a neutral keycode (ghostty
                // must not treat it as the Return/Tab/Escape action)...
                sendKeyEvent(event, action: GHOSTTY_ACTION_PRESS, text: t, keycodeOverride: 0x00)
                // ...then actually perform that key's action (submit the line,
                // indent, or cancel) as its own keycode-only event.
                sendKeyEvent(event, action: GHOSTTY_ACTION_PRESS, text: nil)
            } else {
                sendKeyEvent(event, action: GHOSTTY_ACTION_PRESS, text: t)
            }
            return
        }
        if hasMarkedText() { return }     // still composing, nothing committed → preedit shown, swallow
        sendKeyEvent(event, action: GHOSTTY_ACTION_PRESS, text: nil)   // special key / keycode-only
    }

    deinit {
        if let s = surface { TerminalView.registry.removeValue(forKey: OpaquePointer(s)); ghostty_surface_free(s) }
        if let link { CVDisplayLinkStop(link) }
    }
}

// IME support: committed text → shell; composing text → ghostty preedit overlay.
extension TerminalView: NSTextInputClient {
    func insertText(_ string: Any, replacementRange: NSRange) {
        let chars = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        markedText = ""
        // ACCUMULATE — the IME can call insertText MORE THAN ONCE per keyDown: typing a
        // punctuation mark right after 한글 commits the composing syllable ("글") and then
        // inserts the punctuation ("."), as two calls. Overwriting dropped the syllable, so
        // "한글." came out as "한." — append instead (ghostty's keyTextAccumulator model).
        // keyDown resets pendingText to nil before interpretKeyEvents, so this starts fresh
        // for each keystroke.
        pendingText = (pendingText ?? "") + chars
        // Clear the preedit now (the composing 한글 that just committed); if a new
        // composition follows in this same event, setMarkedText re-sets it after.
        if let s = surface { ghostty_surface_preedit(s, nil, 0) }
    }
    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        markedText = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        guard let s = surface else { return }
        if markedText.isEmpty { ghostty_surface_preedit(s, nil, 0) }
        else { markedText.withCString { ghostty_surface_preedit(s, $0, UInt(strlen($0))) } }
    }
    func unmarkText() {
        markedText = ""
        if let s = surface { ghostty_surface_preedit(s, nil, 0) }
    }
    func hasMarkedText() -> Bool { !markedText.isEmpty }
    func markedRange() -> NSRange { markedText.isEmpty ? NSRange(location: NSNotFound, length: 0) : NSRange(location: 0, length: markedText.count) }
    func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func characterIndex(for point: NSPoint) -> Int { 0 }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        // Anchor the IME candidate window near the view's bottom-left.
        guard let win = window else { return .zero }
        let p = convert(NSPoint(x: 0, y: 0), to: nil)
        return NSRect(origin: win.convertPoint(toScreen: p), size: CGSize(width: 1, height: 16))
    }
    // Special keys produce no text; keyDown emits a keycode-only event for them,
    // so doCommand is a no-op (must exist for NSTextInputClient).
    override func doCommand(by selector: Selector) {}
}
