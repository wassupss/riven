import Foundation

// Per-workspace activity rollup (riven's state/workspaceStatus.ts). Each terminal
// pane reports busy / needs-attention; a workspace rolls up to the most urgent:
// attn (amber, pulsing) > busy (violet) > idle (grey).
enum PaneActivity { case idle, busy, attn }

final class WorkspaceStatus {
    static let shared = WorkspaceStatus()
    private init() {}

    private struct Pane { let ws: String; var busy: Bool; var attn: Bool }
    private var panes: [String: Pane] = [:]     // key = "ws|paneId"
    var onChange: ((_ workspace: String) -> Void)?

    func setPane(ws: String, pane: String, busy: Bool? = nil, attn: Bool? = nil) {
        let key = "\(ws)|\(pane)"
        var cur = panes[key] ?? Pane(ws: ws, busy: false, attn: false)
        if let busy { cur.busy = busy }
        if let attn { cur.attn = attn }
        panes[key] = cur
        onChange?(ws)
    }
    func clearPane(ws: String, pane: String) { panes["\(ws)|\(pane)"] = nil; onChange?(ws) }

    func rollup(_ ws: String) -> PaneActivity {
        let ps = panes.values.filter { $0.ws == ws }
        if ps.contains(where: { $0.attn }) { return .attn }
        if ps.contains(where: { $0.busy }) { return .busy }
        return .idle
    }
}
