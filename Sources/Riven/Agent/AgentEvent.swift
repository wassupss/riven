import Foundation

// A normalized agent lifecycle event, decoded from the JSON line that `riven-hook`
// forwards over the hook socket.
//
// Claude Code and Codex use the SAME hook event names (SessionStart, UserPromptSubmit,
// PermissionRequest, Stop, …) and the same payload schema, so one model covers both.
// Events we don't care about are dropped at decode time rather than plumbed through.
struct AgentEvent {
    enum Kind: String {
        case sessionStart      = "SessionStart"       // pane ↔ session binding confirmed
        case userPromptSubmit  = "UserPromptSubmit"   // a turn began (replaces the Enter-key guess)
        case permissionRequest = "PermissionRequest"  // waiting on the user - NOT working
        case notification      = "Notification"       // agent asked for attention
        case stop              = "Stop"               // turn finished (authoritative)
        case stopFailure       = "StopFailure"        // turn ended on an API error
        case subagentStart     = "SubagentStart"
        case subagentStop      = "SubagentStop"
        case postToolUse       = "PostToolUse"        // a file-editing tool ran → drives the Changes panel
    }

    let kind: Kind
    /// RIVEN_PANE_SESSION - the routing key. Always a validated UUID string.
    let pane: String
    /// Which CLI produced this ("claude" / "codex"), for per-agent quirks + logging.
    let agent: String
    /// The agent's own session id. Diagnostics only - routing never depends on it,
    /// because Codex has no way to be launched with a caller-chosen session id.
    let sessionId: String?
    /// Present on turn-scoped events; lets notifications dedupe per turn instead of
    /// per message-hash (which is all cmux can do without this field).
    let promptId: String?
    /// Human-readable text for the banner: `last_assistant_message` (Stop),
    /// `message` (Notification), or `error_message` (StopFailure).
    let message: String?
    /// Tool awaiting approval (permissionRequest) or the tool that ran (postToolUse).
    let toolName: String?
    /// Absolute path the tool edited (postToolUse for Edit/Write/MultiEdit) - the
    /// precise, per-pane signal that drives the Changes panel. nil for other events.
    let filePath: String?

    // ---- decoding ----------------------------------------------------------
    // Envelope shape (see Sources/RivenHook):
    //   {"v":1,"agent":"claude","event":"Stop","pane":"<uuid>","payload":{…}}
    // Anything malformed, unknown, or carrying a non-UUID pane is rejected: this data
    // crosses a socket, so it is treated as untrusted input even though the socket is
    // owner-only. Same rule the persisted session snapshot already follows.
    static func decode(_ line: Data) -> AgentEvent? {
        guard let root = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              (root["v"] as? Int) == 1,
              let rawEvent = root["event"] as? String,
              let kind = Kind(rawValue: rawEvent),
              let pane = root["pane"] as? String,
              UUID(uuidString: pane) != nil
        else { return nil }

        let agent = (root["agent"] as? String).map { String($0.prefix(32)) } ?? "unknown"
        let payload = root["payload"] as? [String: Any] ?? [:]

        // Trim every free-text field: it lands in a notification banner, and an agent
        // could emit a very long assistant message.
        func text(_ key: String) -> String? {
            guard let s = payload[key] as? String else { return nil }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : String(t.prefix(400))
        }

        // Edit / Write / MultiEdit all put the target under tool_input.file_path. Accept
        // only an absolute path (a well-formed edit target); anything else is dropped so a
        // malformed payload can't inject a bogus Changes entry.
        let toolInput = payload["tool_input"] as? [String: Any]
        let editedPath = (toolInput?["file_path"] as? String).flatMap { $0.hasPrefix("/") ? $0 : nil }

        return AgentEvent(
            kind: kind,
            pane: pane,
            agent: agent,
            sessionId: payload["session_id"] as? String,
            promptId: payload["prompt_id"] as? String,
            message: text("last_assistant_message") ?? text("message") ?? text("error_message"),
            toolName: (payload["tool_name"] as? String).map { String($0.prefix(64)) },
            filePath: editedPath
        )
    }
}
