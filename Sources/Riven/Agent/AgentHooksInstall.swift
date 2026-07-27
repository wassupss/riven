import Foundation

// Builds the hook configuration each agent CLI needs so its lifecycle events reach
// riven, WITHOUT writing to the user's own agent config.
//
// That constraint is the main place this design departs from cmux, which installs its
// hooks into the user's settings files. riven doesn't have to: it launches the agent
// itself, so it can hand the config in on the command line and leave ~/.claude and
// ~/.codex untouched. Nothing to migrate, nothing to clean up, nothing to corrupt.
enum AgentHooksInstall {

    // Verified against Claude Code on 2026-07-27 with `claude --init-only`:
    //  • `--settings` DEEP-MERGES the `hooks` key — a user's own hooks still fire
    //    alongside riven's, so passing our file is not destructive.
    //  • the hook process inherits the pane's environment, so RIVEN_PANE_SESSION is
    //    readable from `riven-hook`'s own env (this is what makes routing work for
    //    agents like Codex that can't be launched with a caller-chosen session id).
    //  • the payload arrives on stdin as JSON with session_id / cwd / hook_event_name.

    /// Events worth waking riven for. Deliberately excludes the per-tool-call firehose
    /// (PreToolUse / PostToolUse): those fire many times per turn and none of them
    /// change the pane's user-visible state.
    private static let claudeEvents = [
        "SessionStart", "UserPromptSubmit", "PermissionRequest",
        "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
    ]
    /// Codex documents a smaller set — no Notification / StopFailure.
    private static let codexEvents = [
        "SessionStart", "UserPromptSubmit", "PermissionRequest",
        "Stop", "SubagentStart", "SubagentStop",
    ]

    /// Absolute path to the bridge helper, which ships beside the app binary. It must
    /// be absolute: a GUI-launched app has a minimal PATH (the same trap documented in
    /// [[AgentDiscovery]]), and the agent inherits that PATH when it spawns the hook.
    static var helperPath: String? {
        guard let exe = Bundle.main.executableURL else { return nil }
        let path = exe.deletingLastPathComponent().appendingPathComponent("riven-hook").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
    private static func command(_ helper: String, _ agent: String, _ event: String) -> String {
        "\(shellQuote(helper)) \(agent) \(event)"
    }

    /// One matcher group per event, each running the bridge.
    ///   async  — never make the agent wait on us; delivery is fire-and-forget.
    ///   timeout— a floor under a wedged socket; the helper already self-limits to ~1s.
    private static func hooksBlock(agent: String, events: [String], helper: String) -> [String: Any] {
        var out: [String: Any] = [:]
        for event in events {
            out[event] = [[
                "hooks": [[
                    "type": "command",
                    "command": command(helper, agent, event),
                    "async": true,
                    "timeout": 5,
                ]]
            ]]
        }
        return out
    }

    // ---- Claude Code -------------------------------------------------------
    /// Writes riven's hook settings and returns the path to pass as `--settings`.
    /// Regenerated every launch so an app move/upgrade can't leave a stale helper path.
    static func claudeSettingsPath() -> String? {
        guard let helper = helperPath else {
            RLog.log("HOOKS riven-hook helper missing — agent hooks disabled")
            return nil
        }
        let url = AgentHookServer.ensureSupportDir().appendingPathComponent("claude-hooks.json")
        let doc: [String: Any] = ["hooks": hooksBlock(agent: "claude", events: claudeEvents, helper: helper)]
        guard let data = try? JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys]),
              (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return url.path
    }

    // ---- Codex -------------------------------------------------------------
    // UNVERIFIED. Codex is not installed on the machine this was developed on, so the
    // shape below follows the published config reference but has NOT been exercised
    // end to end. It is therefore gated behind a setting that defaults to OFF — an
    // unrecognized `-c` key would make the agent fail to launch, and breaking a pane
    // is a far worse failure than losing status badges on it.
    //
    // To validate on a machine with Codex:
    //   1. codex -c features.hooks=true -c 'hooks.Stop=[{hooks=[{type="command",command="/bin/echo hi"}]}]'
    //   2. confirm it starts and the hook runs on turn end
    //   3. flip `codexHooks` on by default and delete this notice
    static var codexEnabled: Bool { Settings.shared.bool("codexHooks", false) }

    /// Extra argv for a Codex launch. Empty when disabled or unavailable, so the
    /// caller can always splice the result in unconditionally.
    static func codexLaunchOverrides() -> [String] {
        guard codexEnabled, let helper = helperPath else { return [] }
        var argv = ["-c", "features.hooks=true"]
        for event in codexEvents {
            // Inline TOML value; the command string is single-quoted for the shell that
            // ultimately runs the launch line, and TOML-quoted inside it.
            let cmd = command(helper, "codex", event).replacingOccurrences(of: "\"", with: "\\\"")
            argv += ["-c", "hooks.\(event)=[{hooks=[{type=\"command\",command=\"\(cmd)\"}]}]"]
        }
        return argv
    }
}
