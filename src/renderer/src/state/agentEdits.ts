import { create } from 'zustand'

// Tracks files edited by an agent (external process) so the editor can show what
// changed. `before`/`after` drive the inline diff.
export interface AgentEdit {
  before: string
  after: string
  hasBaseline: boolean
}

// One entry in the changes timeline — a summary of an agent edit. Clicking it
// opens the file (with the inline diff), so the editor is never flooded with
// auto-opened tabs when an agent touches many files at once.
export interface TimelineEntry {
  path: string
  workspace: string
  at: number
  added: number
  removed: number
  isNew: boolean
}

const MAX_TIMELINE = 300

interface AgentEditsState {
  edits: Record<string, AgentEdit>
  timeline: TimelineEntry[]
  // Count of timeline entries not yet looked at (drives the toolbar/status badge).
  unseen: number
  set: (path: string, edit: AgentEdit) => void
  clear: (path: string) => void
  // Record an agent edit: store its diff + prepend a timeline summary entry.
  record: (workspace: string, path: string, edit: AgentEdit, isNew: boolean) => void
  markSeen: () => void
  clearTimeline: () => void
}

// Rough per-line add/remove counts for the timeline summary. Uses an LCS DP for
// reasonably sized files and falls back to a net-line-delta estimate for large
// ones so a big generated file can't make this O(n²) expensive.
function diffCounts(before: string, after: string): { added: number; removed: number } {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const m = a.length
  const n = b.length
  if (m > 1500 || n > 1500) {
    const delta = n - m
    return { added: Math.max(delta, 0), removed: Math.max(-delta, 0) }
  }
  const w = n + 1
  const dp = new Uint32Array((m + 1) * w)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }
  const lcs = dp[0]
  return { removed: m - lcs, added: n - lcs }
}

export const useAgentEdits = create<AgentEditsState>((set) => ({
  edits: {},
  timeline: [],
  unseen: 0,
  set: (path, edit) => set((s) => ({ edits: { ...s.edits, [path]: edit } })),
  clear: (path) =>
    set((s) => {
      if (!(path in s.edits)) return s
      const edits = { ...s.edits }
      delete edits[path]
      return { edits }
    }),
  record: (workspace, path, edit, isNew) =>
    set((s) => {
      const { added, removed } = diffCounts(edit.before, edit.after)
      const entry: TimelineEntry = { path, workspace, at: Date.now(), added, removed, isNew }
      // Collapse repeated edits to the same file into one (latest) entry at the top.
      const rest = s.timeline.filter((e) => e.path !== path)
      const timeline = [entry, ...rest].slice(0, MAX_TIMELINE)
      return { edits: { ...s.edits, [path]: edit }, timeline, unseen: s.unseen + 1 }
    }),
  markSeen: () => set((s) => (s.unseen === 0 ? s : { unseen: 0 })),
  clearTimeline: () => set({ timeline: [], unseen: 0 })
}))

// Last-known content per path — the baseline for diffing an agent edit. Updated
// whenever the editor loads or saves a file, and after an edit is processed.
const cache = new Map<string, string>()
export const cacheGet = (p: string): string | undefined => cache.get(p)
export const cacheSet = (p: string, content: string): void => {
  cache.set(p, content)
}

// Drop every baseline + pending edit + timeline entry under a workspace. Called
// when the workspace is closed so these full-file-content caches (fed by
// snapshotContents — up to 2000 files) don't accumulate for the whole app life.
export function evictWorkspace(workspace: string): void {
  const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`
  const under = (p: string): boolean => p === workspace || p.startsWith(prefix)
  for (const p of [...cache.keys()]) if (under(p)) cache.delete(p)
  useAgentEdits.setState((s) => {
    const edits: Record<string, AgentEdit> = {}
    for (const [p, e] of Object.entries(s.edits)) if (!under(p)) edits[p] = e
    const timeline = s.timeline.filter((e) => e.workspace !== workspace && !under(e.path))
    return { edits, timeline, unseen: Math.min(s.unseen, timeline.length) }
  })
}
