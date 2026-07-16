import { create } from 'zustand'
import { evictWorkspace } from './agentEdits'

// The editor model store registers here (avoids a session ↔ modelStore import
// cycle) so closeWorkspace can dispose models that were open only in the closed
// workspace instead of leaking them.
let orphanModelDisposer: ((paths: string[]) => void) | null = null
export function setOrphanModelDisposer(fn: (paths: string[]) => void): void {
  orphanModelDisposer = fn
}

// Per-workspace session. Each workspace keeps its own editor tabs, active file,
// preview URL and dockview layout (the arrangement of explorer/editor/terminals/
// preview panels). Inactive workspaces stay mounted (hidden) so terminals live.

export interface Session {
  openTabs: string[]
  activePath: string | null
  previewUrl: string
  dockLayout: unknown | null // dockview SerializedDockview
}

const emptySession = (): Session => ({
  openTabs: [],
  activePath: null,
  previewUrl: '',
  dockLayout: null
})

interface PersistShape {
  openWorkspaces: string[]
  activeWorkspace: string | null
  sessions: Record<string, Session>
  recents?: string[]
  names?: Record<string, string>
}

interface SessionState {
  ready: boolean
  openWorkspaces: string[]
  activeWorkspace: string | null
  sessions: Record<string, Session>
  recents: string[] // most-recently-opened workspace paths (MRU), for reopening
  // Custom display names, keyed by wid. Absent ⇒ the folder name is used.
  names: Record<string, string>
  hydrate: (data: PersistShape) => void
  // Open (or, with forceNew, always add another instance of) a folder path.
  openWorkspace: (path: string, forceNew?: boolean) => void
  closeWorkspace: (wid: string) => void
  setActiveWorkspace: (wid: string) => void
  renameWorkspace: (wid: string, name: string) => void
  patch: (wid: string, p: Partial<Session>) => void
  openFile: (path: string) => void
  closeTab: (path: string) => void
}

// A workspace is identified by a `wid`, NOT its path, so the same folder can be
// opened as several independent workspaces (issue #6). The first instance of a
// path uses the plain path as its wid (backward compatible with older sessions);
// further instances append `<ordinal>` — an invisible control char that
// can't appear in a real path. FS operations resolve the real folder via pathOf.
const WID_SEP = String.fromCharCode(1)
export function pathOf(wid: string): string {
  const i = wid.indexOf(WID_SEP)
  return i < 0 ? wid : wid.slice(0, i)
}
function widOrdinal(wid: string): number {
  const i = wid.indexOf(WID_SEP)
  return i < 0 ? 1 : parseInt(wid.slice(i + 1), 10) || 1
}
// Pick a fresh wid for opening `path`: the plain path if free, else the next
// ordinal not already open.
function freshWid(path: string, open: string[]): string {
  if (!open.includes(path)) return path
  let n = 2
  while (open.includes(`${path}${WID_SEP}${n}`)) n++
  return `${path}${WID_SEP}${n}`
}

// The display name for a workspace: the custom name if set, else the folder name
// (with a `(2)`, `(3)`… suffix to disambiguate additional instances of a path).
export function workspaceName(wid: string, names: Record<string, string>): string {
  const custom = names[wid]?.trim()
  if (custom) return custom
  const dir = pathOf(wid)
  const base = dir.split('/').filter(Boolean).pop() || dir
  const ord = widOrdinal(wid)
  return ord > 1 ? `${base} (${ord})` : base
}

export const useSession = create<SessionState>((set) => ({
  ready: false,
  openWorkspaces: [],
  activeWorkspace: null,
  sessions: {},
  recents: [],
  names: {},

  hydrate: (data) =>
    set(() => {
      const sessions: Record<string, Session> = {}
      for (const [path, s] of Object.entries(data.sessions ?? {})) {
        sessions[path] = {
          openTabs: s.openTabs ?? [],
          activePath: s.activePath ?? null,
          previewUrl: s.previewUrl ?? '',
          dockLayout: s.dockLayout ?? null
        }
      }
      return {
        ready: true,
        openWorkspaces: data.openWorkspaces ?? [],
        activeWorkspace: data.activeWorkspace ?? null,
        sessions,
        recents: data.recents ?? [],
        names: data.names ?? {}
      }
    }),

  openWorkspace: (path, forceNew = false) =>
    set((st) => {
      const recents = [path, ...st.recents.filter((r) => r !== path)].slice(0, 8)
      // Default: focus an existing instance of this path. forceNew always adds a
      // fresh, independent instance (its own tabs / terminals / layout).
      if (!forceNew) {
        const existing = st.openWorkspaces.find((w) => pathOf(w) === path)
        if (existing) return { activeWorkspace: existing, recents }
      }
      const wid = freshWid(path, st.openWorkspaces)
      return {
        activeWorkspace: wid,
        openWorkspaces: [...st.openWorkspaces, wid],
        sessions: st.sessions[wid] ? st.sessions : { ...st.sessions, [wid]: emptySession() },
        recents
      }
    }),

  closeWorkspace: (wid) => {
    const closedTabs = useSession.getState().sessions[wid]?.openTabs ?? []
    set((st) => {
      const openWorkspaces = st.openWorkspaces.filter((w) => w !== wid)
      // Only drop the shared (path-keyed) baseline caches when NO other open
      // instance still points at the same folder, so closing one instance can't
      // wipe the other's diffs. Timeline entries are wid-keyed and always freed.
      const path = pathOf(wid)
      const pathStillOpen = openWorkspaces.some((w) => pathOf(w) === path)
      evictWorkspace(wid, path, !pathStillOpen)
      const sessions = { ...st.sessions }
      delete sessions[wid]
      const activeWorkspace =
        st.activeWorkspace === wid ? (openWorkspaces.at(-1) ?? null) : st.activeWorkspace
      return { openWorkspaces, sessions, activeWorkspace }
    })
    // Dispose models for files that were open only in the just-closed workspace
    // (a sibling same-folder workspace still open keeps its shared model alive).
    const remaining = new Set(
      Object.values(useSession.getState().sessions).flatMap((s) => s.openTabs)
    )
    const orphans = closedTabs.filter((p) => !remaining.has(p))
    if (orphans.length) orphanModelDisposer?.(orphans)
  },

  setActiveWorkspace: (path) => set({ activeWorkspace: path }),

  renameWorkspace: (path, name) =>
    set((st) => {
      const names = { ...st.names }
      const trimmed = name.trim()
      // Empty ⇒ clear the override so it falls back to the folder name.
      if (!trimmed) delete names[path]
      else names[path] = trimmed
      return { names }
    }),

  patch: (path, p) =>
    set((st) => ({
      sessions: { ...st.sessions, [path]: { ...(st.sessions[path] ?? emptySession()), ...p } }
    })),

  openFile: (path) =>
    set((st) => {
      const ws = st.activeWorkspace
      if (!ws) return {}
      const s = st.sessions[ws] ?? emptySession()
      const openTabs = s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path]
      return { sessions: { ...st.sessions, [ws]: { ...s, openTabs, activePath: path } } }
    }),

  closeTab: (path) =>
    set((st) => {
      const ws = st.activeWorkspace
      if (!ws) return {}
      const s = st.sessions[ws] ?? emptySession()
      const openTabs = s.openTabs.filter((t) => t !== path)
      const activePath = s.activePath === path ? (openTabs.at(-1) ?? null) : s.activePath
      return { sessions: { ...st.sessions, [ws]: { ...s, openTabs, activePath } } }
    })
}))

// ---- persistence -----------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null
useSession.subscribe((st) => {
  if (!st.ready) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(
    () =>
      window.api.sessions.save({
        openWorkspaces: st.openWorkspaces,
        activeWorkspace: st.activeWorkspace,
        sessions: st.sessions,
        recents: st.recents,
        names: st.names
      }),
    400
  )
})

// Keep the main process's file-mutation confinement list (workspace roots) in
// sync with what's open, so it can reject writes/deletes outside them.
let lastRoots = ''
useSession.subscribe((st) => {
  // Resolve wids to real folder paths (deduped) — the main-process confinement
  // list must contain paths, and several instances can share one folder.
  const roots = [...new Set(st.openWorkspaces.map(pathOf))]
  const key = roots.join('\n')
  if (key === lastRoots) return
  lastRoots = key
  void window.api.workspace.setRoots(roots)
})

export async function loadPersistedSessions(): Promise<void> {
  const data = (await window.api.sessions.load()) as PersistShape | null
  useSession.getState().hydrate(data ?? { openWorkspaces: [], activeWorkspace: null, sessions: {} })
}
