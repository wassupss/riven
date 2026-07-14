import { useEffect, useRef } from 'react'
import { useSession } from '../state/session'
import { useAgentEdits, cacheGet, cacheSet } from '../state/agentEdits'
import { ensureEditor } from '../dock/registry'

// Build/cache/vcs dirs are ignored by the watcher already; this is a second
// guard so a stray event never yanks a transient file into the editor.
const IGNORED_PATH =
  /(^|[/\\])(\.git|node_modules|out|dist|\.riven|\.cache|\.next|\.turbo|\.svelte-kit|\.nuxt|\.output|\.vercel|\.vite|\.parcel-cache|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|target)([/\\]|$)/

// Watches the active workspace for on-disk changes made by agents/terminals and
// surfaces them: opens the changed file in the editor and records before/after
// for the inline diff. Also fires a system notification naming the file.
export default function AgentWatch(): null {
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const openFile = useSession((s) => s.openFile)
  const setActiveWorkspace = useSession((s) => s.setActiveWorkspace)
  const setEdit = useAgentEdits((s) => s.set)
  const snapshotted = useRef(new Set<string>())

  // Cache current file contents as diff baselines (once per workspace) so agent
  // edits show precise changes even without git.
  useEffect(() => {
    if (!activeWorkspace || snapshotted.current.has(activeWorkspace)) return
    snapshotted.current.add(activeWorkspace)
    window.api.workspace.snapshotContents(activeWorkspace).then((map) => {
      for (const [p, c] of Object.entries(map)) {
        if (cacheGet(p) === undefined) cacheSet(p, c)
      }
    })
  }, [activeWorkspace])

  useEffect(() => {
    return window.api.bridge.onFsChanged(async ({ type, path }) => {
      if (type === 'unlink') return
      if (!activeWorkspace || !path.startsWith(activeWorkspace + '/')) return
      if (IGNORED_PATH.test(path.slice(activeWorkspace.length))) return

      const after = await window.api.workspace.readFile(path).catch(() => null)
      if (after == null) return
      const before = cacheGet(path)
      if (before === after) return // no real change (or our own save, already cached)

      cacheSet(path, after)
      setActiveWorkspace(activeWorkspace)
      openFile(path)
      ensureEditor()

      if (before !== undefined) {
        setEdit(path, { before, after, hasBaseline: true })
      } else {
        // No in-app baseline — use the committed (git HEAD) version so we can
        // still show what changed. Falls back to no-diff if not tracked.
        const rel = path.slice(activeWorkspace.length + 1)
        const gitBase = await window.api.git.showFile(activeWorkspace, rel)
        if (gitBase != null && gitBase !== after) {
          setEdit(path, { before: gitBase, after, hasBaseline: true })
        } else {
          setEdit(path, { before: '', after, hasBaseline: false })
        }
      }
    })
  }, [activeWorkspace, openFile, setActiveWorkspace, setEdit])

  return null
}
