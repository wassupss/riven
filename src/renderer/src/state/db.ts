import { create } from 'zustand'
import type { ConnectionInfo, ObjectKind, QueryResult } from '../../../main/db/types'

// Shared state of the two DB panels: the saved connections (owned by main, cached
// here) and the SQL console's tabs. The explorer opens tabs; the console shows
// them. Tab text persists; results live only for the session.

export interface SqlTab {
  id: string
  kind: 'sql'
  title: string
  connId: string
  db?: string
  sql: string
}

export interface ObjectTab {
  id: string
  kind: 'object'
  title: string
  connId: string
  db?: string
  schema: string
  name: string
  objKind: ObjectKind
}

export type ConsoleTab = SqlTab | ObjectTab

export interface RunResult {
  sql: string
  result?: QueryResult
  error?: string
}

export interface RunState {
  running: boolean
  queryId?: string
  results: RunResult[]
  /** Which result is shown when one run produced several. */
  shown: number
}

const LS_TABS = 'db.console.tabs.v1'

let seq = 0
export const dbUid = (): string => `t${Date.now().toString(36)}${(seq++).toString(36)}`

interface Persisted {
  tabs: ConsoleTab[]
  active: string | null
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(LS_TABS)
    if (raw) {
      const p = JSON.parse(raw) as Persisted
      if (Array.isArray(p.tabs)) return { tabs: p.tabs, active: p.active ?? p.tabs[0]?.id ?? null }
    }
  } catch {
    // corrupt: start empty
  }
  return { tabs: [], active: null }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist(p: Persisted): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(LS_TABS, JSON.stringify(p))
    } catch {
      // quota: the console still works, it just won't remember
    }
  }, 400)
}

interface DbState {
  connections: ConnectionInfo[]
  loaded: boolean
  tabs: ConsoleTab[]
  active: string | null
  runs: Record<string, RunState>
  /** A tab the console should run as soon as it shows it (explorer's "SELECT *"). */
  autoRun: string | null
  reload: () => Promise<void>
  openSql: (connId: string, db?: string, sql?: string, run?: boolean) => string
  openObject: (connId: string, db: string | undefined, schema: string, name: string, objKind: ObjectKind) => string
  closeTab: (id: string) => void
  setActive: (id: string) => void
  patchTab: (id: string, patch: Partial<SqlTab>) => void
  setRun: (id: string, run: RunState | ((prev: RunState | undefined) => RunState)) => void
  clearAutoRun: () => void
}

const initial = loadPersisted()

export const useDb = create<DbState>((set, get) => {
  const commit = (tabs: ConsoleTab[], active: string | null): void => {
    set({ tabs, active })
    persist({ tabs, active })
  }
  return {
    connections: [],
    loaded: false,
    tabs: initial.tabs,
    active: initial.active,
    runs: {},
    autoRun: null,
    reload: async () => {
      const connections = await window.api.db.list().catch(() => [] as ConnectionInfo[])
      set({ connections, loaded: true })
    },
    openSql: (connId, db, sql = '', run = false) => {
      const conn = get().connections.find((c) => c.id === connId)
      const n = get().tabs.filter((t) => t.kind === 'sql').length + 1
      const tab: SqlTab = {
        id: dbUid(),
        kind: 'sql',
        title: `${conn?.name ?? 'SQL'} ${n}`,
        connId,
        db,
        sql
      }
      commit([...get().tabs, tab], tab.id)
      if (run) set({ autoRun: tab.id })
      return tab.id
    },
    openObject: (connId, db, schema, name, objKind) => {
      const same = get().tabs.find(
        (t) => t.kind === 'object' && t.connId === connId && t.db === db && t.schema === schema && t.name === name
      )
      if (same) {
        commit(get().tabs, same.id)
        return same.id
      }
      const tab: ObjectTab = { id: dbUid(), kind: 'object', title: name, connId, db, schema, name, objKind }
      commit([...get().tabs, tab], tab.id)
      return tab.id
    },
    closeTab: (id) => {
      const tabs = get().tabs
      const i = tabs.findIndex((t) => t.id === id)
      if (i < 0) return
      const next = tabs.filter((t) => t.id !== id)
      const active = get().active === id ? (next[i] ?? next[i - 1])?.id ?? null : get().active
      const runs = { ...get().runs }
      delete runs[id]
      set({ runs })
      commit(next, active)
    },
    setActive: (id) => commit(get().tabs, id),
    patchTab: (id, patch) =>
      commit(
        get().tabs.map((t) => (t.id === id && t.kind === 'sql' ? { ...t, ...patch } : t)),
        get().active
      ),
    setRun: (id, run) =>
      set((s) => ({ runs: { ...s.runs, [id]: typeof run === 'function' ? run(s.runs[id]) : run } })),
    clearAutoRun: () => set({ autoRun: null })
  }
})
