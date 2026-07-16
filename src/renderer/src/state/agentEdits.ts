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
  // Bumped per path to ask an open editor of that file to reload from disk (used
  // when the Changes panel reverts a file that's currently open).
  reloadNonce: Record<string, number>
  set: (path: string, edit: AgentEdit) => void
  clear: (path: string) => void
  // Record an agent edit: store its diff + prepend a timeline summary entry.
  record: (workspace: string, path: string, edit: AgentEdit, isNew: boolean) => void
  markSeen: () => void
  clearTimeline: () => void
  // Resolve one file (accept, or after a revert): drop its timeline entry + edit.
  resolve: (path: string) => void
  // Accept every pending change: keep disk content, clear all reviews + timeline.
  acceptAll: () => void
  requestReload: (path: string) => void
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
  reloadNonce: {},
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
  clearTimeline: () => set({ timeline: [], unseen: 0 }),
  resolve: (path) =>
    set((s) => {
      const edits = { ...s.edits }
      delete edits[path]
      const timeline = s.timeline.filter((e) => e.path !== path)
      return { edits, timeline, unseen: Math.min(s.unseen, timeline.length) }
    }),
  acceptAll: () => set({ edits: {}, timeline: [], unseen: 0 }),
  requestReload: (path) =>
    set((s) => ({ reloadNonce: { ...s.reloadNonce, [path]: (s.reloadNonce[path] ?? 0) + 1 } }))
}))

// Last-known content per path — the baseline for diffing an agent edit. Updated
// whenever the editor loads or saves a file, and after an edit is processed.
const cache = new Map<string, string>()
export const cacheGet = (p: string): string | undefined => cache.get(p)
export const cacheSet = (p: string, content: string): void => {
  cache.set(p, content)
}

// Free a closed workspace's state. Timeline entries are wid-keyed and always
// dropped. The baseline caches (fed by snapshotContents — up to 2000 files) are
// keyed by absolute file path and thus SHARED between instances of the same
// folder, so they're only pruned when `evictBaselines` is set (i.e. the last
// instance of that path is closing) — otherwise a sibling instance keeps them.
export function evictWorkspace(wid: string, path: string, evictBaselines: boolean): void {
  const prefix = path.endsWith('/') ? path : `${path}/`
  const under = (p: string): boolean => p === path || p.startsWith(prefix)
  if (evictBaselines) for (const p of [...cache.keys()]) if (under(p)) cache.delete(p)
  useAgentEdits.setState((s) => {
    const edits: Record<string, AgentEdit> = evictBaselines
      ? Object.fromEntries(Object.entries(s.edits).filter(([p]) => !under(p)))
      : s.edits
    const timeline = s.timeline.filter((e) => e.workspace !== wid)
    return { edits, timeline, unseen: Math.min(s.unseen, timeline.length) }
  })
}
