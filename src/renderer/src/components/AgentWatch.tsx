import { useEffect, useRef } from 'react'
import { useSession, pathOf } from '../state/session'
import { useAgentEdits, cacheGet, cacheSet } from '../state/agentEdits'
import { contextBus } from '../bridge/contextBus'

// Build/cache/vcs dirs are ignored by the watcher already; this is a second
// guard so a stray event never yanks a transient file into the editor.
const IGNORED_PATH =
  /(^|[/\\])(\.git|node_modules|out|dist|\.riven|\.cache|\.next|\.turbo|\.svelte-kit|\.nuxt|\.output|\.vercel|\.vite|\.parcel-cache|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|target|Library|\.Trash|\.Trashes)([/\\]|$)/

// Watches the active workspace for on-disk changes made by agents/terminals and
// summarizes them into the changes timeline (see ChangesPanel) — recording
// before/after for the inline diff. It deliberately does NOT auto-open each file:
// an agent touching many files would otherwise flood the editor with tabs, so the
// user reviews the timeline and clicks in to see any one change.
export default function AgentWatch(): null {
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const record = useAgentEdits((s) => s.record)
  const snapshotted = useRef(new Set<string>())

  // Cache current file contents as diff baselines (once per workspace) so agent
  // edits show precise changes even without git.
  useEffect(() => {
    if (!activeWorkspace || snapshotted.current.has(activeWorkspace)) return
    snapshotted.current.add(activeWorkspace)
    window.api.workspace.snapshotContents(pathOf(activeWorkspace)).then((map) => {
      for (const [p, c] of Object.entries(map)) {
        if (cacheGet(p) === undefined) cacheSet(p, c)
      }
    })
  }, [activeWorkspace])

  useEffect(() => {
    // The wid identifies the session (agent routing / timeline); root is the real
    // folder on disk that the fs events are relative to.
    const root = activeWorkspace ? pathOf(activeWorkspace) : null
    return window.api.bridge.onFsChanged(async ({ type, path }) => {
      if (type === 'unlink') return
      if (!activeWorkspace || !root || !path.startsWith(root + '/')) return
      if (IGNORED_PATH.test(path.slice(root.length))) return

      // Only surface changes that come from a riven agent SESSION — i.e. a
      // terminal in this workspace currently has an LLM agent running. Without
      // this, every on-disk change (an external editor, a background process, a
      // git checkout, macOS reindexing a huge folder) was treated as an agent
      // edit and yanked into the editor — the "flood" when a big/root folder is
      // the workspace. No agent running ⇒ the change isn't ours to show.
      if (!contextBus.hasAgent(activeWorkspace)) return

      const after = await window.api.workspace.readFile(path).catch(() => null)
      if (after == null) return
      const before = cacheGet(path)
      if (before === after) return // no real change (or our own save, already cached)

      cacheSet(path, after)

      if (before !== undefined) {
        record(activeWorkspace, path, { before, after, hasBaseline: true }, false)
      } else {
        // No in-app baseline — use the committed (git HEAD) version so we can
        // still show what changed. Falls back to no-diff (treated as a new file).
        const rel = path.slice(root.length + 1)
        const gitBase = await window.api.git.showFile(root, rel)
        if (gitBase != null && gitBase !== after) {
          record(activeWorkspace, path, { before: gitBase, after, hasBaseline: true }, false)
        } else {
          record(activeWorkspace, path, { before: '', after, hasBaseline: false }, true)
        }
      }
    })
  }, [activeWorkspace, record])

  return null
}
