import { onWorkspaceClosed, clearPaneState } from './session'
import { getApiFor } from '../dock/registry'
import { useJobs } from './jobs'
import { useAgentGroups } from './agentGroups'
import { useGoals } from './goals'
import { useGroupLog } from './groupLog'
import { usePipelines } from './pipelines'
import { useBrowser } from './browser'

// Everything that belongs to a workspace, released when the workspace is closed.
//
// Closing a workspace removes it from riven, and with it every panel — the
// terminals and agent chats are already stopped by the dock as it goes (see
// dock/Workbench). What this file covers is the rest, kept in stores of their
// own that the session tree never knew about:
//
//   · scheduled jobs — the one that did real damage: a closed workspace's job
//     kept firing, failed ("워크스페이스가 열려 있지 않아…"), notified, and
//     recording the failure wrote the workspace back into sessions.json;
//   · agent groups, goal boards, the group timeline and saved pipelines;
//   · browser tabs, each a live WebContentsView (a renderer process) in main;
//   · language servers for the folder — only once no other open workspace
//     is looking at the same folder, since those share them.
//
// Notes are NOT removed. They are files the user wrote, kept per folder, and
// come back if the folder is opened again.
//
// One file, imported once at startup, so a store is cleaned up even if nothing
// has loaded its module yet this session.

function drop<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

onWorkspaceClosed((wid, path, pathStillOpen) => {
  useJobs.setState((s) => ({ byWorkspace: drop(s.byWorkspace, wid) }))
  useAgentGroups.setState((s) => ({ byWorkspace: drop(s.byWorkspace, wid) }))
  useGoals.setState((s) => ({ byWorkspace: drop(s.byWorkspace, wid) }))
  useGroupLog.setState((s) => ({ byWorkspace: drop(s.byWorkspace, wid) }))

  // Pipelines persist themselves (localStorage), so dropping goes through the
  // store's own write rather than around it.
  const pipelines = usePipelines.getState().byWorkspace[wid]
  if (pipelines) for (const p of pipelines) usePipelines.getState().remove(wid, p.id)

  const tabs = useBrowser.getState().byWs[wid]?.tabs ?? []
  for (const t of tabs) void window.api.browser.destroy(t.id)
  useBrowser.setState((s) => ({ byWs: drop(s.byWs, wid) }))

  if (!pathStillOpen) void window.api.lsp.stopRoot(path)
})

// A team member's closed pane keeps its conversation so the org chart can bring
// it back (dock/Workbench, reopenChat). Once the member leaves the team — removed,
// or the group deleted — nothing can reopen it any more, so a conversation kept
// only for that is let go. An OPEN pane is left alone: it is still somebody's
// chat, just no longer on a team.
let members: Record<string, Set<string>> = {}
const snapshot = (): Record<string, Set<string>> =>
  Object.fromEntries(
    Object.entries(useAgentGroups.getState().byWorkspace).map(([ws, gs]) => [
      ws,
      new Set(gs.flatMap((g) => g.members.map((m) => m.chatKey)))
    ])
  )
members = snapshot()
useAgentGroups.subscribe(() => {
  const next = snapshot()
  for (const [ws, before] of Object.entries(members)) {
    const now = next[ws] ?? new Set<string>()
    for (const key of before) {
      if (now.has(key)) continue
      if (getApiFor(ws)?.getPanel(key)) continue
      clearPaneState(ws, key)
    }
  }
  members = next
})
