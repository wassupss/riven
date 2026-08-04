import Foundation

// Per-workspace activity rollup (riven's state/workspaceStatus.ts). Each terminal
// pane reports busy / needs-attention; a workspace rolls up to the most urgent:
// needs-you > busy > idle. 상태 어휘 자체는 [[AgentStatus]] 하나로 통일돼 있다
// (UI/AgentStatus.swift) — 여기서는 워크스페이스 단위로 접기만 한다.

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

    func rollup(_ ws: String) -> AgentStatus {
        let ps = panes.values.filter { $0.ws == ws }
        if ps.contains(where: { $0.attn }) { return .done }
        if ps.contains(where: { $0.busy }) { return .busy }
        return .idle
    }
}
