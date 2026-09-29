import { onWorkspaceClosed } from './session'
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
