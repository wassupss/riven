import { create } from 'zustand'

// Per-terminal agent/activity state, keyed so we can roll it up per workspace for
// the workspace rail cards. Fed by TerminalPanel from the pty status/bell/done
// signals. (A richer descriptive status — "Claude is waiting for your input" —
// will arrive with the OSC agent-status feature; this is the activity rollup.)
export type PaneActivity = 'idle' | 'busy' | 'attn'

interface PaneStatus {
  workspace: string
  busy: boolean
  attention: boolean
}

interface WorkspaceStatusState {
  panes: Record<string, PaneStatus>
  setPane: (workspace: string, paneId: number, patch: Partial<Omit<PaneStatus, 'workspace'>>) => void
  clearPane: (workspace: string, paneId: number) => void
}

export const useWorkspaceStatus = create<WorkspaceStatusState>((set) => ({
  panes: {},
  setPane: (workspace, paneId, patch) =>
    set((st) => {
      const key = `${workspace}|${paneId}`
      const prev = st.panes[key] ?? { workspace, busy: false, attention: false }
      return { panes: { ...st.panes, [key]: { ...prev, workspace, ...patch } } }
    }),
  clearPane: (workspace, paneId) =>
    set((st) => {
      const key = `${workspace}|${paneId}`
      if (!(key in st.panes)) return st
      const next = { ...st.panes }
      delete next[key]
      return { panes: next }
    })
}))

// Roll the per-pane state up to one activity level for a workspace.
export function rollupActivity(
  panes: Record<string, PaneStatus>,
  workspace: string
): PaneActivity {
  let busy = false
  for (const p of Object.values(panes)) {
    if (p.workspace !== workspace) continue
    if (p.attention) return 'attn'
    if (p.busy) busy = true
  }
  return busy ? 'busy' : 'idle'
}
