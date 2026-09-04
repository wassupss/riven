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

// Per-chat-pane state — the SINGLE SOURCE OF TRUTH for restoring a chat pane,
// stored in the workspace tree (sessions.json) so it can never desync from the
// dock layout (both are saved together). Replaces the old flat localStorage keys.
export interface PaneState {
  model?: string
  mode?: string
  session?: string | null // Claude CLI session id (for --resume)
  agent?: string | null // custom agent (.claude/agents)
  // Role/persona for this pane (agent-group member). Sent as a SYSTEM prompt at
  // spawn (--append-system-prompt) instead of burning a real turn priming the
  // agent, so it costs no conversation and survives restarts.
  persona?: string
  avatar?: string | null // colour override ("glyph.color" | "none")
  title?: string // pinned tab title
  log?: unknown[] // transcript (Msg[]), capped
}

export interface Session {
  openTabs: string[]
  activePath: string | null
  previewUrl: string
  dockLayout: unknown | null // dockview SerializedDockview
  panes?: Record<string, PaneState> // chatKey → pane state (the tree)
}

const emptySession = (): Session => ({
  openTabs: [],
  activePath: null,
  previewUrl: '',
  dockLayout: null,
  panes: {}
})

// ---- pane state (single source of truth) ------------------------------------
// Legacy flat-localStorage keys, read as a one-time fallback so existing sessions
// migrate seamlessly; new writes go into the workspace tree.
function legacy(chatKey: string, prefix: string): string | undefined {
  try {
    return localStorage.getItem(`${prefix}:${chatKey}`) ?? undefined
  } catch {
    return undefined
  }
}
export function loadPaneState(wid: string, chatKey: string): PaneState {
  const rec = useSession.getState().sessions[wid]?.panes?.[chatKey]
  let legacyLog: unknown[] | undefined
  if (!rec?.log) {
    try {
      const raw = localStorage.getItem(`chatlog:${chatKey}`)
      if (raw) legacyLog = JSON.parse(raw) as unknown[]
    } catch {
      /* ignore */
    }
  }
  return {
    model: rec?.model ?? legacy(chatKey, 'chatmodel'),
    mode: rec?.mode ?? legacy(chatKey, 'chatmode'),
    session: rec?.session ?? legacy(chatKey, 'chatsession') ?? null,
    agent: rec?.agent ?? legacy(chatKey, 'chatagent') ?? null,
    avatar: rec?.avatar ?? legacy(chatKey, 'chatavatar') ?? null,
    title: rec?.title ?? legacy(chatKey, 'chattitle'),
    log: rec?.log ?? legacyLog
  }
}
export function setPaneState(wid: string, chatKey: string, patch: Partial<PaneState>): void {
  useSession.setState((st) => {
    const s = st.sessions[wid] ?? emptySession()
    const panes = { ...(s.panes ?? {}), [chatKey]: { ...(s.panes?.[chatKey] ?? {}), ...patch } }
    return { sessions: { ...st.sessions, [wid]: { ...s, panes } } }
  })
}
export function clearPaneState(wid: string, chatKey: string): void {
  useSession.setState((st) => {
    const s = st.sessions[wid]
    if (!s?.panes?.[chatKey]) return {}
    const panes = { ...s.panes }
    delete panes[chatKey]
    return { sessions: { ...st.sessions, [wid]: { ...s, panes } } }
  })
  for (const p of ['chatlog', 'chatmodel', 'chatmode', 'chatsession', 'chattitle', 'chatavatar', 'chatagent']) {
    try {
      localStorage.removeItem(`${p}:${chatKey}`)
    } catch {
      /* ignore */
    }
  }
}
// Find which workspace holds a pane (chatKeys are globally unique). Falls back to
// the active workspace for a not-yet-recorded pane.
export function widForPane(chatKey: string): string | null {
  const st = useSession.getState()
  for (const [wid, s] of Object.entries(st.sessions)) if (s.panes?.[chatKey]) return wid
  return st.activeWorkspace
}

interface PersistShape {
  openWorkspaces: string[]
  activeWorkspace: string | null
  sessions: Record<string, Session>
  recents?: string[]
  names?: Record<string, string>
  colors?: Record<string, string>
}

interface SessionState {
  ready: boolean
  openWorkspaces: string[]
  activeWorkspace: string | null
  sessions: Record<string, Session>
  recents: string[] // most-recently-opened workspace paths (MRU), for reopening
  // Custom display names, keyed by wid. Absent ⇒ the folder name is used.
  names: Record<string, string>
  // Per-workspace dot colour (an avatar colour index, or AVATAR_NONE). Drives the
  // rail dot AND its busy pulse. Absent ⇒ the default accent.
  colors: Record<string, string>
  hydrate: (data: PersistShape) => void
  // Open (or, with forceNew, always add another instance of) a folder path.
  openWorkspace: (path: string, forceNew?: boolean) => void
  closeWorkspace: (wid: string) => void
  setActiveWorkspace: (wid: string) => void
  // Move a workspace card up/down in the rail (drag reorder).
  reorderWorkspace: (from: number, to: number) => void
  renameWorkspace: (wid: string, name: string) => void
  setWorkspaceColor: (wid: string, spec: string | null) => void
  patch: (wid: string, p: Partial<Session>) => void
  openFile: (path: string) => void
  closeTab: (path: string) => void
  reorderTabs: (from: number, to: number) => void
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
  colors: {},

  hydrate: (data) =>
    set(() => {
      const sessions: Record<string, Session> = {}
      for (const [path, s] of Object.entries(data.sessions ?? {})) {
        sessions[path] = {
          openTabs: s.openTabs ?? [],
          activePath: s.activePath ?? null,
          previewUrl: s.previewUrl ?? '',
          dockLayout: s.dockLayout ?? null,
          // Preserve per-pane state (model / mode / session id / transcript / title /
          // avatar). Dropping it here wiped the tree on every launch: the first
          // layout-change save afterwards then persisted panes-less sessions to disk.
          panes: s.panes ?? {}
        }
      }
      return {
        ready: true,
        openWorkspaces: data.openWorkspaces ?? [],
        activeWorkspace: data.activeWorkspace ?? null,
        sessions,
        recents: data.recents ?? [],
        names: data.names ?? {},
        colors: data.colors ?? {}
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

  reorderWorkspace: (from, to) =>
    set((st) => {
      const list = st.openWorkspaces
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return {}
      const next = [...list]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { openWorkspaces: next }
    }),

  renameWorkspace: (path, name) =>
    set((st) => {
      const names = { ...st.names }
      const trimmed = name.trim()
      // Empty ⇒ clear the override so it falls back to the folder name.
      if (!trimmed) delete names[path]
      else names[path] = trimmed
      return { names }
    }),

  setWorkspaceColor: (wid, spec) =>
    set((st) => {
      const colors = { ...st.colors }
      if (spec) colors[wid] = spec
      else delete colors[wid] // null ⇒ back to the default accent
      return { colors }
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
    }),

  reorderTabs: (from, to) =>
    set((st) => {
      const ws = st.activeWorkspace
      if (!ws) return {}
      const s = st.sessions[ws] ?? emptySession()
      if (from === to || from < 0 || to < 0 || from >= s.openTabs.length || to >= s.openTabs.length)
        return {}
      const openTabs = [...s.openTabs]
      const [moved] = openTabs.splice(from, 1)
      openTabs.splice(to, 0, moved)
      return { sessions: { ...st.sessions, [ws]: { ...s, openTabs } } }
    })
}))

// ---- persistence -----------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null
const snapshot = (): {
  openWorkspaces: string[]
  activeWorkspace: string | null
  sessions: unknown
  recents: unknown
  names: unknown
  colors: unknown
} => {
  const st = useSession.getState()
  return {
    openWorkspaces: st.openWorkspaces,
    activeWorkspace: st.activeWorkspace,
    sessions: st.sessions,
    recents: st.recents,
    names: st.names,
    colors: st.colors
  }
}
useSession.subscribe((st) => {
  if (!st.ready) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => window.api.sessions.save(snapshot()), 400)
})

// Force the current snapshot to disk NOW (blocking), cancelling the debounce.
// Used for structural dock changes (a panel opened/closed) so a close is durable
// immediately — otherwise quitting within the 400ms debounce loses it and the
// closed panel reappears on next launch.
export function flushSessionSaveSync(): void {
  if (!useSession.getState().ready) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    window.api.sessions.saveSync(snapshot())
  } catch {
    /* best effort */
  }
}

// Flush the pending debounced save synchronously before the page tears down
// (renderer reload / window close). Without this, a change made in the last 400ms
// — e.g. closing a panel — is lost and reappears on restore. sendSync blocks until
// the file is written, so it survives even a hard reload.
window.addEventListener('beforeunload', () => {
  if (!useSession.getState().ready) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    window.api.sessions.saveSync(snapshot())
  } catch {
    /* best effort on exit */
  }
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
