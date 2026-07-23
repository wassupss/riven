import AppKit
import GhosttyKit

// Owns the single libghostty app + config for the whole process. Surfaces
// (terminal views) are created against this app.
final class GhosttyApp {
    static let shared = GhosttyApp()

    private(set) var app: ghostty_app_t?
    private(set) var config: ghostty_config_t?

    // Build a finalized ghostty config for the CURRENT theme. Colors are applied via
    // a temp .conf loaded with ghostty_config_load_file — they need a leading '#' or
    // ghostty rejects the value and the config never finalizes → surfaces fail.
    private func makeConfig() -> ghostty_config_t? {
        let cfg = ghostty_config_new()
        ghostty_config_load_default_files(cfg)
        let t = Theme.current
        let hex: (String) -> String = { $0.hasPrefix("#") ? $0 : "#\($0)" }
        // Full 16-color ANSI palette matching riven's TerminalPane.terminalTheme().
        let palette = """

        palette = 0=#2a2e35
        palette = 1=\(hex(t.danger))
        palette = 2=\(hex(t.success))
        palette = 3=\(hex(t.warning))
        palette = 4=\(hex(t.info))
        palette = 5=\(hex(t.accent2))
        palette = 6=#3ec5b7
        palette = 7=\(hex(t.fgDim))
        palette = 8=#5a616b
        palette = 9=#ff6b63
        palette = 10=#6ad39b
        palette = 11=#f0c56a
        palette = 12=#7cc4f5
        palette = 13=#b9a9ff
        palette = 14=#5fd6c9
        palette = 15=\(hex(t.fg))
        """
        let themeConf = """
        background = \(hex(t.bg))
        foreground = \(hex(t.fg))
        cursor-color = \(hex(t.accent))
        selection-background = #34363b
        selection-foreground = \(hex(t.fg))
        font-size = \(UIScale.terminalFontSize)
        desktop-notifications = true
        bell-features = system,audio,attention,title
        shell-integration = detect
        shell-integration-features = cursor,title
        """ + palette
        let tmp = NSTemporaryDirectory() + "riven-ghostty.conf"
        if (try? themeConf.write(toFile: tmp, atomically: true, encoding: .utf8)) != nil {
            tmp.withCString { ghostty_config_load_file(cfg, $0) }
        }
        ghostty_config_finalize(cfg)
        return cfg
    }

    // Live-apply the current theme's colors to the app + every open surface (riven's
    // terminalTheme() re-apply). ghostty supports this via update_config.
    func reloadTheme() {
        guard let app, let cfg = makeConfig() else { return }
        ghostty_app_update_config(app, cfg)
        for s in TerminalView.liveSurfaces() {
            ghostty_surface_update_config(s, cfg)
            ghostty_surface_refresh(s)
        }
        let old = config
        config = cfg
        if let old { ghostty_config_free(old) }
    }

    private init() {
        _ = ghostty_init(0, nil)
        let cfg = makeConfig()
        self.config = cfg

        var rt = ghostty_runtime_config_s()
        rt.userdata = Unmanaged.passUnretained(self).toOpaque()
        rt.supports_selection_clipboard = false
        rt.wakeup_cb = { ud in
            guard let ud else { return }
            let me = Unmanaged<GhosttyApp>.fromOpaque(ud).takeUnretainedValue()
            DispatchQueue.main.async { me.scheduleTick() }
        }
        // Handle ghostty actions we care about — desktop notifications (OSC 9 /
        // OSC 777 from the shell / agent) and the terminal bell.
        rt.action_cb = { _, target, action in
            let surface = target.tag == GHOSTTY_TARGET_SURFACE ? target.target.surface : nil
            switch action.tag {
            case GHOSTTY_ACTION_DESKTOP_NOTIFICATION:
                // Do NOT post here — the activity poller (onTurnDone) is the SINGLE,
                // gated notification source (one per user turn). Posting the agent's own
                // desktop notification too caused duplicate banners. Just mark activity
                // (attn ember + dedup timestamp).
                DispatchQueue.main.async {
                    let v = TerminalView.view(for: surface)
                    v?.externalNotifyAt = Date()
                    v?.onActivity?()
                }
            case GHOSTTY_ACTION_RING_BELL:
                DispatchQueue.main.async {
                    Notifications.bell()
                    // Bell = turn done / needs input → attention (onActivity clears busy).
                    TerminalView.view(for: surface)?.onActivity?()
                }
            // NOTE: busy/idle is driven by TerminalView's activity poller (reliable for
            // long-running agents), NOT by PROGRESS_REPORT / COMMAND_FINISHED — those are
            // absent or misleading for agent TUIs, so they are intentionally ignored.
            case GHOSTTY_ACTION_SHOW_CHILD_EXITED:
                DispatchQueue.main.async { TerminalView.view(for: surface)?.onIdle?() }
            case GHOSTTY_ACTION_RENDER:
                DispatchQueue.main.async { TerminalView.view(for: surface)?.setNeedsDraw() }
            case GHOSTTY_ACTION_SET_TITLE:
                if let t = action.action.set_title.title.map({ String(cString: $0) }) {
                    DispatchQueue.main.async { TerminalView.view(for: surface)?.onTitle?(t) }
                }
            default: break
            }
            return true
        }
        // Clipboard bridge so terminal ⌘C / ⌘V (and OSC 52) reach NSPasteboard.
        // read: hand the current pasteboard string back to the surface that asked.
        rt.read_clipboard_cb = { _, _, state in
            let str = NSPasteboard.general.string(forType: .string) ?? ""
            if let s = TerminalView.focused?.surfaceHandle {
                str.withCString { ghostty_surface_complete_clipboard_request(s, $0, state, true) }
            }
            return true
        }
        rt.confirm_read_clipboard_cb = { _, _, _, _ in }
        // write: copy the terminal's selection/OSC-52 payload into NSPasteboard.
        rt.write_clipboard_cb = { _, _, content, _, _ in
            guard let content, let dataPtr = content.pointee.data else { return }
            let str = String(cString: dataPtr)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(str, forType: .string)
        }
        rt.close_surface_cb = { _, _ in }
        self.app = ghostty_app_new(&rt, cfg)
    }

    // Coalesce ghostty wakeups: ghostty can call wakeup_cb in a tight burst, and
    // ticking once per call floods the main queue → the kqueue event loop pegs a core
    // (was ~100% idle). Collapse all pending wakeups into a single tick per run-loop turn.
    private var tickScheduled = false
    func scheduleTick() {
        guard !tickScheduled else { return }
        tickScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.tickScheduled = false
            if let app = self.app { ghostty_app_tick(app) }
        }
    }
    func tick() { if let app { ghostty_app_tick(app) } }
}
