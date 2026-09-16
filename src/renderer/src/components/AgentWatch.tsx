import { useEffect } from 'react'
import { pathOf } from '../state/session'
import { useAgentEdits, cacheSet } from '../state/agentEdits'
import { workspaceOfPane } from '../state/roster'
import { ensureChanges } from '../dock/registry'

// Feeds the changes timeline (see ChangesPanel) with the files riven's agents
// actually wrote.
//
// This used to watch the filesystem and treat every change under the active
// workspace as an agent edit as long as SOME agent was running there. That is
// not attribution, it is coincidence: build output, a formatter, a `npm i` and
// above all a `git checkout` — which rewrites half the tree at once — all
// landed in the review queue, and the panel stopped answering the question it
// exists for. Main now reports edits from the agent's own tool calls
// (main/agentEdits.ts), so a file that no agent wrote never appears, and a
// change with no tool behind it (an editor of the user's own, a build, a branch
// switch) belongs to the Git panel instead.
//
// Every window receives every edit; `workspaceOfPane` returns null for a pane
// this window's layout doesn't own, which is how a popout keeps its own queue.
// It reads the PERSISTED layout, so an agent working in a workspace that is
// open but not currently mounted is still recorded.
export default function AgentWatch(): null {
  const record = useAgentEdits((s) => s.record)

  useEffect(
    () =>
      window.api.onAgentFileEdit(async ({ pane, path, before, after }) => {
        const workspace = workspaceOfPane(pane)
        if (!workspace) return
        cacheSet(path, after)
        // Surface the timeline automatically (idempotent, no focus steal).
        ensureChanges()

        if (before !== null) {
          record(workspace, path, { before, after, hasBaseline: true }, false)
          return
        }
        // No baseline — riven didn't see the file before the tool ran. It may
        // still be a tracked file, so diff against the committed version rather
        // than calling everything in it new.
        const root = pathOf(workspace)
        const rel = path.startsWith(root + '/') ? path.slice(root.length + 1) : null
        const gitBase = rel ? await window.api.git.showFile(root, rel) : null
        if (gitBase != null && gitBase !== after) {
          record(workspace, path, { before: gitBase, after, hasBaseline: true }, false)
        } else {
          record(workspace, path, { before: '', after, hasBaseline: false }, true)
        }
      }),
    [record]
  )

  return null
}
