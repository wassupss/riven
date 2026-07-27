import Foundation

// Turns agent lifecycle events into pane state: busy / needs-attention / notification.
//
// This is the replacement for the screen-diffing heuristic in TerminalView. That code
// inferred "working" from the viewport changing and "done" from it holding still for
// 0.9s, which meant a thinking pause looked like completion, an agent waiting on tool
// approval looked identical to one working, and the reply text shown in the banner had
// to be reverse-engineered out of TUI chrome with a pile of regexes. Every one of those
// is now a distinct, authoritative event.
//
// The UI verbs are injected rather than called directly so this file stays free of
// AppKit and the policy — what raises attention, when a banner fires — is reviewable on
// its own. Main queue only; AgentHookServer hops before calling in.
final class AgentActivity {
    static let shared = AgentActivity()
    private init() {}

    struct Sink {
        let setBusy: (PaneSessionRegistry.Pane, Bool) -> Void
        let setAttention: (PaneSessionRegistry.Pane, Bool) -> Void
        /// True when the user is looking at this pane right now (focused pane of the
        /// key window). Looking at it counts as having seen it, so we neither raise
        /// the ember ring nor post a banner — riven's existing convention.
        let isWatched: (PaneSessionRegistry.Pane) -> Bool
        let notify: (PaneSessionRegistry.Pane, String) -> Void
    }
    var sink: Sink?

    /// Turn currently in flight per pane, and the turn we've already posted a banner
    /// for. Claude Code gives us `prompt_id`; agents that don't are given a synthetic
    /// counter so one-banner-per-turn still holds. (cmux has to hash status+message
    /// text for this because it has no turn identifier available.)
    private var currentTurn: [String: String] = [:]
    private var notifiedTurn: [String: String] = [:]
    private var synthetic: [String: Int] = [:]

    func handle(_ event: AgentEvent) {
        guard let pane = PaneSessionRegistry.shared.pane(for: event.pane), let sink else { return }
        let key = event.pane

        switch event.kind {
        case .sessionStart:
            // A resumed or restarted session: clear anything stale from the last run.
            currentTurn[key] = nil
            notifiedTurn[key] = nil
            sink.setBusy(pane, false)
            sink.setAttention(pane, false)

        case .userPromptSubmit:
            let turn = event.promptId ?? nextSyntheticTurn(key)
            currentTurn[key] = turn
            notifiedTurn[key] = nil          // a new turn re-arms the banner
            sink.setBusy(pane, true)
            sink.setAttention(pane, false)   // submitting means you're here

        case .permissionRequest:
            // Waiting on the user is NOT busy — that distinction is the whole reason
            // to prefer hooks over screen scraping.
            sink.setBusy(pane, false)
            guard !sink.isWatched(pane) else { break }
            sink.setAttention(pane, true)
            let body = event.toolName.map { t("agent.needsApprovalTool", ["tool": $0]) }
                ?? t("agent.needsApproval")
            notifyOnce(pane, key, body, sink)

        case .notification:
            guard !sink.isWatched(pane) else { break }
            sink.setAttention(pane, true)
            // An explicit agent notification is worth surfacing even if the turn
            // already posted one, so it bypasses the per-turn gate.
            sink.notify(pane, event.message ?? t("agent.needsApproval"))

        case .stop:
            sink.setBusy(pane, false)
            currentTurn[key] = nil
            guard !sink.isWatched(pane) else { break }
            sink.setAttention(pane, true)
            notifyOnce(pane, key, event.message ?? t("term.done"), sink)

        case .stopFailure:
            sink.setBusy(pane, false)
            currentTurn[key] = nil
            sink.setAttention(pane, true)
            // Errors notify even while watched: a failed turn is easy to miss when the
            // pane is mid-scroll, and it needs action either way.
            sink.notify(pane, event.message ?? t("agent.failed"))

        case .subagentStart, .subagentStop:
            // Tracked for a future subagent count on the tab badge; no state change yet.
            break
        }
    }

    /// Post at most one completion banner per turn. Without this an agent that emits
    /// PermissionRequest and then Stop within one turn would double-notify.
    private func notifyOnce(_ pane: PaneSessionRegistry.Pane, _ key: String,
                            _ body: String, _ sink: Sink) {
        let turn = currentTurn[key] ?? "-"
        guard notifiedTurn[key] != turn else { return }
        notifiedTurn[key] = turn
        sink.notify(pane, body)
    }

    private func nextSyntheticTurn(_ key: String) -> String {
        let n = (synthetic[key] ?? 0) + 1
        synthetic[key] = n
        return "syn-\(n)"
    }

    /// Called when a pane closes so its turn bookkeeping doesn't outlive it.
    func forget(pane session: String) {
        currentTurn[session] = nil
        notifiedTurn[session] = nil
        synthetic[session] = nil
    }
}
