import Foundation

// Maps a pane's session UUID (RIVEN_PANE_SESSION) back to the pane that owns it, so
// an incoming hook event can be routed to the right tab/badge/ring.
//
// riven already mints one UUID per terminal pane and threads it through the launch
// command, the shell shim and the persisted session snapshot; this is just the reverse
// index. Main-queue only, like [[AgentEdits]] — AgentHookServer hops to main before
// touching it.
final class PaneSessionRegistry {
    static let shared = PaneSessionRegistry()
    private init() {}

    struct Pane: Equatable { let workspace: String; let paneId: String }

    private var panes: [String: Pane] = [:]        // session UUID -> pane
    /// Panes whose agent has proven it can deliver hooks (a SessionStart arrived).
    /// Activity detection stays on the passive OSC/bell path until then, so a pane
    /// running a plain shell — or an agent whose hooks aren't wired — never gets stuck
    /// looking idle because we waited for events that will not come.
    private var hookBacked: Set<String> = []

    func register(session: String, workspace: String, paneId: String) {
        guard UUID(uuidString: session) != nil else { return }
        panes[session] = Pane(workspace: workspace, paneId: paneId)
    }

    func unregister(session: String) {
        panes[session] = nil
        hookBacked.remove(session)
    }

    func pane(for session: String) -> Pane? { panes[session] }

    /// True once this pane has delivered at least one hook event.
    func isHookBacked(_ session: String) -> Bool { hookBacked.contains(session) }

    /// Called on every routed event — the first one promotes the pane to hook-backed.
    /// Returns true if this was the promotion, so the caller can log the handover.
    @discardableResult
    func markHookBacked(_ session: String) -> Bool {
        guard panes[session] != nil else { return false }
        return hookBacked.insert(session).inserted
    }

    /// Drop every pane belonging to a closed workspace.
    func clearWorkspace(_ workspace: String) {
        for (session, pane) in panes where pane.workspace == workspace {
            panes[session] = nil
            hookBacked.remove(session)
        }
    }
}
