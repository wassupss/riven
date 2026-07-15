import { create } from 'zustand'
import { evictWorkspace } from './agentEdits'

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
  // Custom display names, keyed by path. Absent ⇒ the folder name is used.
  names: Record<string, string>
  hydrate: (data: PersistShape) => void
  openWorkspace: (path: string) => void
  closeWorkspace: (path: string) => void
  setActiveWorkspace: (path: string) => void
  renameWorkspace: (path: string, name: string) => void
  patch: (path: string, p: Partial<Session>) => void
  openFile: (path: string) => void
  closeTab: (path: string) => void
}

// The display name for a workspace: the custom name if set, else the folder name.
export function workspaceName(path: string, names: Record<string, string>): string {
  return names[path]?.trim() || path.split('/').filter(Boolean).pop() || path
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

  openWorkspace: (path) =>
    set((st) => ({
      activeWorkspace: path,
      openWorkspaces: st.openWorkspaces.includes(path) ? st.openWorkspaces : [...st.openWorkspaces, path],
      sessions: st.sessions[path] ? st.sessions : { ...st.sessions, [path]: emptySession() },
      recents: [path, ...st.recents.filter((r) => r !== path)].slice(0, 8)
    })),

  closeWorkspace: (path) => {
    // Free this workspace's agent-edit baselines/diffs (can be ~2000 file
    // contents) so they don't leak for the app's lifetime.
    evictWorkspace(path)
    set((st) => {
      const openWorkspaces = st.openWorkspaces.filter((w) => w !== path)
      const sessions = { ...st.sessions }
      delete sessions[path]
      const activeWorkspace =
        st.activeWorkspace === path ? (openWorkspaces.at(-1) ?? null) : st.activeWorkspace
      return { openWorkspaces, sessions, activeWorkspace }
    })
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
  const key = st.openWorkspaces.join('\n')
  if (key === lastRoots) return
  lastRoots = key
  void window.api.workspace.setRoots(st.openWorkspaces)
})

export async function loadPersistedSessions(): Promise<void> {
  const data = (await window.api.sessions.load()) as PersistShape | null
  useSession.getState().hydrate(data ?? { openWorkspaces: [], activeWorkspace: null, sessions: {} })
}
