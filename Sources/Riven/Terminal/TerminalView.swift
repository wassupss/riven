import AppKit
import QuartzCore
import GhosttyKit

// A Metal-backed NSView hosting one libghostty surface (GPU terminal + real
// shell spawned by libghostty). Working directory can be set per instance.
final class TerminalView: NSView, NSMenuItemValidation {
    private var surface: ghostty_surface_t?
    private var link: CVDisplayLink?
    private let workdir: String?
    private let command: String?          // initial command (agent launch) — runs directly
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

    init(frame: NSRect, workdir: String? = nil, command: String? = nil) {
        self.workdir = workdir
        self.command = command
        super.init(frame: frame)
        wantsLayer = true
        layer = CAMetalLayer()
        setupSurface()
        setupDisplayLink()
        attnRing.frame = bounds
        attnRing.autoresizingMask = [.width, .height]
        addSubview(attnRing)
        startActivityPolling()
    }
    required init?(coder: NSCoder) { fatalError() }

    // ---- Activity-based busy/idle detection (riven's pty.ts model) ----
    // ghostty actions (PROGRESS_REPORT / COMMAND_FINISHED / notifications) are an
    // unreliable "done" signal: long-running agents never emit COMMAND_FINISHED, and
    // Claude Code suppresses its desktop notification while its terminal is focused.
    // So — exactly like riven — we watch the terminal's OWN OUTPUT: poll the visible
    // viewport text, and treat "content is changing" as busy and "content has been
    // stable for a gap" as done. This needs no cooperation from the agent.
    private var pollTimer: Timer?
    private var lastViewport = ""
    private var lastScreenHash: Int = 0
    private var lastChange = Date()
    private var busyState = false
    private var busyStart = Date()
    private let idleGap: TimeInterval = 0.9    // riven ACTIVE_MS — stable this long ⇒ done
    private let minTurn: TimeInterval = 2.5    // only a turn this long pings (skips quick commands / typing)

    private func startActivityPolling() {
        let t = Timer(timeInterval: 0.3, repeats: true) { [weak self] _ in self?.pollActivity() }
        RunLoop.main.add(t, forMode: .common)
        pollTimer = t
    }

    // Hash the visible viewport; drive busy on change, done on a stable gap.
    private func pollActivity() {
        guard let s = surface else { return }
        var sel = ghostty_selection_s()
        sel.top_left = ghostty_point_s(tag: GHOSTTY_POINT_VIEWPORT, coord: GHOSTTY_POINT_COORD_TOP_LEFT, x: 0, y: 0)
        sel.bottom_right = ghostty_point_s(tag: GHOSTTY_POINT_VIEWPORT, coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT, x: 0, y: 0)
        sel.rectangle = false
        var out = ghostty_text_s()
        guard ghostty_surface_read_text(s, sel, &out) else { return }
        var hash = 0
        if let cstr = out.text {
            // FNV-1a over the raw bytes — cheap and stable within a run.
            hash = 1469598103934665603 &* 1
            var p = cstr
            while p.pointee != 0 { hash = (hash ^ Int(bitPattern: UInt(bitPattern: Int(p.pointee)))) &* 1099511628211; p = p.advanced(by: 1) }
            lastViewport = String(cString: cstr)
        }
        ghostty_surface_free_text(s, &out)

        let now = Date()
        if hash != lastScreenHash {
            lastScreenHash = hash
            lastChange = now
            if !busyState {
                busyState = true
                busyStart = now
                onBusy?()
            }
        } else if busyState, now.timeIntervalSince(lastChange) >= idleGap {
            // Output has been stable → the turn ended.
            busyState = false
            let duration = lastChange.timeIntervalSince(busyStart)
            onIdle?()
            // A substantial turn (not a quick command / typing echo) → raise attention.
            if duration >= minTurn { onTurnDone?() }
        }
    }

    // The agent's last meaningful reply line(s), scraped from the visible viewport for
    // the completion notification body. Filters out TUI chrome / status / timing lines
    // ("esc to interrupt", spinners, "baked for 5m 43s", token counters, box borders,
    // the input prompt) so the banner shows what the agent actually SAID.
    func lastAgentMessage() -> String? {
        let junk = [
            "esc to interrupt", "esc to ", "ctrl+", "tokens", "token", "context left",
            "auto-accept", "accept edits", "to interrupt", "⏵", "⏸", "▐", "press up",
            "for \u{2026}", "…)",
        ]
        // A line that's only a timer / spinner / box-drawing / prompt / Claude Code's
        // "✻ Churned for 12m 44s · … · esc to interrupt" status line is NOT content.
        func isChrome(_ l: String) -> Bool {
            let t = l.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { return true }
            let low = t.lowercased()
            if junk.contains(where: { low.contains($0) }) { return true }
            // Claude Code's gerund status line: "<Word>ed/ing for 12m 44s" (Churned,
            // Baked, Herding, Cerebrating, Noodling…). Any "… for <time>" is chrome.
            if low.range(of: #"\bfor\s+\d+m\b|\bfor\s+\d+s\b|\bfor\s+\d+m\s*\d+s\b"#, options: .regularExpression) != nil { return true }
            // Pure timing like "5m 43s" / "· 12s" / "(43s)".
            if t.range(of: #"^[·•∙✻✽✳*●\-\s\(]*\d+m?\s*\d*s\)?$"#, options: .regularExpression) != nil { return true }
            // Braille spinner frames / box borders / prompt carets only.
            let strip = t.trimmingCharacters(in: CharacterSet(charactersIn: "⠀⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟⠠⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿╭╮╯╰│─┌┐└┘├┤┬┴┼>❯✳✻✽*● "))
            if strip.isEmpty { return true }
            return false
        }
        let lines = lastViewport.components(separatedBy: "\n")
        // Claude Code prints each assistant reply prefixed with a filled bullet "⏺"
        // (U+23FA) or "●" (U+25CF). Take the LAST such line (the newest answer) + its
        // wrapped continuation. Only these two markers — NOT "•"/"◦", which appear in
        // Claude's status/config UI ("high effort", permission hints) and produced the
        // "high /effort" garbage. If there's no bullet line, return nil (generic banner).
        func isBullet(_ scalar: Unicode.Scalar?) -> Bool { scalar == "\u{23FA}" || scalar == "\u{25CF}" }
        guard let bulletIdx = lines.lastIndex(where: { line in
            let tr = line.trimmingCharacters(in: .whitespaces)
            guard isBullet(tr.unicodeScalars.first) else { return false }
            let rest = tr.dropFirst().trimmingCharacters(in: .whitespaces)
            return rest.count >= 2 && !isChrome(rest)   // bullet must precede real text
        }) else { return nil }

        var parts = [lines[bulletIdx].trimmingCharacters(in: CharacterSet(charactersIn: "\u{23FA}\u{25CF} \t"))]
        var i = bulletIdx + 1
        while i < lines.count {
            let l = lines[i]
            let tr = l.trimmingCharacters(in: .whitespaces)
            if tr.isEmpty { break }
            if isBullet(tr.unicodeScalars.first) { break }   // next assistant turn
            if isChrome(l) { break }
            parts.append(tr)
            if parts.count >= 5 { break }
            i += 1
        }
        let msg = parts.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return msg.count >= 2 ? String(msg.prefix(200)) : nil
    }

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
    override func becomeFirstResponder() -> Bool {
        if let s = surface { ghostty_surface_set_focus(s, true) }
        TerminalView.focused = self
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
        paste.isEnabled = NSPasteboard.general.string(forType: .string) != nil; paste.target = self
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
        guard let s = surface, let str = NSPasteboard.general.string(forType: .string) else { return }
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
        sc.font_size = 13
        // Optionally start in a directory and/or run a command directly (agent launch
        // — e.g. `claude` runs immediately instead of being typed into a shell).
        switch (workdir, command) {
        case let (wd?, cmd?):
            wd.withCString { w in cmd.withCString { c in sc.working_directory = w; sc.command = c; surface = ghostty_surface_new(app, &sc) } }
        case let (wd?, nil):
            wd.withCString { w in sc.working_directory = w; surface = ghostty_surface_new(app, &sc) }
        case let (nil, cmd?):
            cmd.withCString { c in sc.command = c; surface = ghostty_surface_new(app, &sc) }
        default:
            surface = ghostty_surface_new(app, &sc)
        }
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

    private func setupDisplayLink() {
        CVDisplayLinkCreateWithActiveCGDisplays(&link)
        guard let link else { return }
        CVDisplayLinkSetOutputCallback(link, { (_, _, _, _, _, ctx) -> CVReturn in
            let view = Unmanaged<TerminalView>.fromOpaque(ctx!).takeUnretainedValue()
            DispatchQueue.main.async { view.drawIfNeeded() }
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

    // Give this terminal keyboard focus (⌘J). Making the NSView first responder
    // triggers becomeFirstResponder, which forwards focus to the ghostty surface.
    func focusTerminal() {
        window?.makeFirstResponder(self)
        // Assert ghostty focus EVEN IF we were already first responder — after a
        // workspace swap the view can stay first responder while the surface lost
        // focus, so keystrokes went nowhere until you clicked again.
        if let s = surface { ghostty_surface_set_focus(s, true) }
        TerminalView.focused = self
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
        pollTimer?.invalidate(); pollTimer = nil
        if let l = link { CVDisplayLinkStop(l) }
        link = nil
        if let s = surface { ghostty_surface_free(s) }
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
    private func sendKeyEvent(_ event: NSEvent, action: ghostty_input_action_e, text: String?) {
        guard let s = surface else { return }
        var k = ghostty_input_key_s()
        k.action = action
        k.keycode = UInt32(event.keyCode)
        k.mods = ghosttyMods(event.modifierFlags)
        if let text, let first = text.utf8.first, first >= 0x20 {
            text.withCString { k.text = $0; _ = ghostty_surface_key(s, k) }
        } else {
            _ = ghostty_surface_key(s, k)
        }
    }

    // Key flow — matches ghostty's official macOS app (Surface.keyDown):
    // interpretKeyEvents routes the event to the IME, which calls back into
    // insertText / setMarkedText / doCommand. We do NOT send anything to the
    // shell from those callbacks; instead insertText only *captures* the
    // committed text into pendingText. Then, back here, we emit exactly ONE
    // ghostty_surface_key carrying the keycode AND that committed text.
    //
    // This is the critical difference from the old code (which called
    // ghostty_surface_text directly): a printable char sent via
    // ghostty_surface_text bypasses ghostty's key pipeline, and its cursor
    // bookkeeping diverged from the shell's echoed cursor — that mismatch was
    // rendered as TWO cursors on different rows. Routing everything through a
    // single ghostty_surface_key keeps one authoritative cursor. It also fixes
    // Enter-first-press: a plain Enter produces no insertText, so pendingText
    // stays nil and we emit a keycode-only Return in the same pass.
    override func keyDown(with event: NSEvent) {
        needsDraw = true
        if event.keyCode == 0x24 { turnArmed = true }   // Return → a user turn begins; arm one notification
        if event.modifierFlags.contains(.command) { super.keyDown(with: event); return }
        pendingText = nil
        interpretKeyEvents([event])
        // Committed text (a letter, or a finished 한글 syllable) → one key event
        // carrying the keycode + text. Sent even while a NEW composition is in
        // progress, so a syllable that commits as another begins isn't dropped.
        if let t = pendingText, !t.isEmpty {
            sendKeyEvent(event, action: GHOSTTY_ACTION_PRESS, text: t); return
        }
        if hasMarkedText() { return }     // still composing, nothing committed → preedit shown, swallow
        sendKeyEvent(event, action: GHOSTTY_ACTION_PRESS, text: nil)   // special key / keycode-only
    }

    deinit {
        pollTimer?.invalidate()
        if let s = surface { ghostty_surface_free(s) }
        if let link { CVDisplayLinkStop(link) }
    }
}

// IME support: committed text → shell; composing text → ghostty preedit overlay.
extension TerminalView: NSTextInputClient {
    func insertText(_ string: Any, replacementRange: NSRange) {
        let chars = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        markedText = ""
        // Only CAPTURE the committed text — keyDown emits it as a single key event.
        // Clear the preedit now (the composing 한글 that just committed); if a new
        // composition follows in this same event, setMarkedText re-sets it after.
        pendingText = chars
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
