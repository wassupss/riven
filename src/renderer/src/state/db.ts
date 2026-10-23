import { create } from 'zustand'
import type { ConnectionInfo, ObjectKind, QueryResult, TxStatus } from '../../../main/db/types'
import { t } from '../i18n'
import type { ResultView } from '../../../main/db/sqlText'
import type { Plan } from '../../../main/db/explain'

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
  /** Manual commit: runs share one connection and transaction until Commit/Rollback. */
  manual?: boolean
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
  /** Routines: identity arguments, telling overloads apart. */
  args?: string
}

/** The table designer: an existing table (`name`) or a new one. */
export interface DesignTab {
  id: string
  kind: 'design'
  title: string
  connId: string
  db?: string
  schema: string
  name?: string
}

/** Roles of a connection (cluster-wide). `db` is where per-role privileges are read. */
export interface RolesTab {
  id: string
  kind: 'roles'
  title: string
  connId: string
  db?: string
}

/** GRANTs and default privileges of a database or a schema. */
export interface PrivsTab {
  id: string
  kind: 'privs'
  title: string
  connId: string
  db?: string
  scope: 'database' | 'schema'
  /** The database or schema name. */
  name: string
}

export type ConsoleTab = SqlTab | ObjectTab | DesignTab | RolesTab | PrivsTab

/** The schema a tab lives in, or undefined when it spans the database (or more). */
const tabSchema = (x: ConsoleTab): string | undefined =>
  x.kind === 'object' || x.kind === 'design' ? x.schema : x.kind === 'privs' && x.scope === 'schema' ? x.name : undefined

/** The last DDL change, so views of what it touched reload. */
export interface DbChange {
  seq: number
  connId: string
  /** Undefined: the connection's database list changed. */
  db?: string
  /** Undefined: the database's schema list changed. */
  schema?: string
}

export interface RunResult {
  sql: string
  /** An EXPLAIN run: the parsed plan (the raw JSON stays in result). */
  plan?: Plan
  result?: QueryResult
  error?: string
  /** A further page is being fetched (infinite scroll). */
  loadingMore?: boolean
  /** The last page fetch failed; scrolling stops until a retry. */
  moreError?: string
  /** Sort/filter applied on top of `sql` (re-run server-side, still paged). */
  view?: ResultView
  /** The view is being re-queried. */
  viewLoading?: boolean
  viewError?: string
  /** Rows the (viewed) query returns in all: undefined not counted yet, null gave up. */
  total?: number | null
  counting?: boolean
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
  /** Transaction state of manual-commit tabs, by tab id. */
  tx: Record<string, TxStatus>
  /** A tab the console should run as soon as it shows it (explorer's "SELECT *"). */
  autoRun: string | null
  changed: DbChange | null
  reload: () => Promise<void>
  openSql: (connId: string, db?: string, sql?: string, run?: boolean) => string
  openObject: (connId: string, db: string | undefined, schema: string, name: string, objKind: ObjectKind, args?: string) => string
  /** Opens the designer for `name`, or for a new table in `schema`. */
  openDesign: (connId: string, db: string | undefined, schema: string, name?: string) => string
  openRoles: (connId: string, db?: string) => string
  openPrivs: (connId: string, db: string | undefined, scope: PrivsTab['scope'], name: string) => string
  /** After DDL: reloads what shows `connId`/`db`/`schema`, and moves or closes tabs of a renamed or dropped object. */
  invalidate: (
    change: Omit<DbChange, 'seq'>,
    object?: { name: string; renamed?: string; dropped?: boolean }
  ) => void
  /** Closes object and designer tabs inside a database or schema that was dropped or renamed. */
  closeWithin: (connId: string, db: string, schema?: string) => void
  /** Points a designer tab at the table it just created or renamed. */
  retarget: (id: string, name: string) => void
  /** False when the user kept the tab (it had an open transaction). */
  closeTab: (id: string) => boolean
  setTx: (id: string, tx: TxStatus) => void
  /** Re-reads a tab's transaction state from main. */
  syncTx: (id: string) => Promise<void>
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
    tx: {},
    autoRun: null,
    changed: null,
    reload: async () => {
      const connections = await window.api.db.list().catch(() => [] as ConnectionInfo[])
      set({ connections, loaded: true })
    },
    openSql: (connId, db, sql = '', run = false) => {
      // Re-running the same canned query (double-clicking a table again) reuses
      // its tab instead of stacking copies. An edited tab no longer matches.
      const same = run && sql
        ? get().tabs.find((t) => t.kind === 'sql' && t.connId === connId && t.db === db && t.sql === sql)
        : undefined
      if (same) {
        commit(get().tabs, same.id)
        set({ autoRun: same.id })
        return same.id
      }
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
    openObject: (connId, db, schema, name, objKind, args) => {
      const same = get().tabs.find(
        (t) => t.kind === 'object' && t.connId === connId && t.db === db && t.schema === schema && t.name === name && t.args === args
      )
      if (same) {
        commit(get().tabs, same.id)
        return same.id
      }
      const tab: ObjectTab = { id: dbUid(), kind: 'object', title: name, connId, db, schema, name, objKind, args }
      commit([...get().tabs, tab], tab.id)
      return tab.id
    },
    openDesign: (connId, db, schema, name) => {
      const same = name
        ? get().tabs.find((t) => t.kind === 'design' && t.connId === connId && t.db === db && t.schema === schema && t.name === name)
        : undefined
      if (same) {
        commit(get().tabs, same.id)
        return same.id
      }
      const tab: DesignTab = { id: dbUid(), kind: 'design', title: name ?? t('db.d.newTable'), connId, db, schema, name }
      commit([...get().tabs, tab], tab.id)
      return tab.id
    },
    openRoles: (connId, db) => {
      const same = get().tabs.find((t) => t.kind === 'roles' && t.connId === connId)
      if (same) {
        commit(get().tabs.map((x) => (x.id === same.id ? { ...x, db } : x)), same.id)
        return same.id
      }
      const conn = get().connections.find((c) => c.id === connId)
      const tab: RolesTab = { id: dbUid(), kind: 'roles', title: t('db.r.rolesOf', { name: conn?.name ?? '' }), connId, db }
      commit([...get().tabs, tab], tab.id)
      return tab.id
    },
    openPrivs: (connId, db, scope, name) => {
      const same = get().tabs.find((t) => t.kind === 'privs' && t.connId === connId && t.db === db && t.scope === scope && t.name === name)
      if (same) {
        commit(get().tabs, same.id)
        return same.id
      }
      const tab: PrivsTab = { id: dbUid(), kind: 'privs', title: t('db.r.privsOf', { name }), connId, db, scope, name }
      commit([...get().tabs, tab], tab.id)
      return tab.id
    },
    closeWithin: (connId, db, schema) => {
      const inside = (x: ConsoleTab): boolean =>
        x.kind !== 'sql' &&
        x.kind !== 'roles' &&
        x.connId === connId &&
        x.db === db &&
        (schema === undefined || tabSchema(x) === schema)
      const { tabs, active } = get()
      if (!tabs.some(inside)) return
      const keep = tabs.filter((x) => !inside(x))
      commit(keep, keep.some((x) => x.id === active) ? active : (keep[0]?.id ?? null))
    },
    invalidate: (change, object) => {
      set((s) => ({ changed: { ...change, seq: (s.changed?.seq ?? 0) + 1 } }))
      if (!object || change.schema === undefined) return
      const hit = (x: ConsoleTab): boolean =>
        (x.kind === 'object' || x.kind === 'design') &&
        x.connId === change.connId &&
        x.db === change.db &&
        x.schema === change.schema &&
        x.name === object.name
      if (object.dropped) {
        commit(
          get().tabs.filter((x) => !hit(x)),
          get().tabs.some((x) => x.id === get().active && hit(x)) ? (get().tabs.find((x) => !hit(x))?.id ?? null) : get().active
        )
      } else if (object.renamed) {
        const to = object.renamed
        commit(
          get().tabs.map((x) => (hit(x) ? { ...x, name: to, title: to } : x)),
          get().active
        )
      }
    },
    retarget: (id, name) =>
      commit(
        get().tabs.map((x) => (x.id === id && x.kind === 'design' ? { ...x, name, title: name } : x)),
        get().active
      ),
    closeTab: (id) => {
      const tabs = get().tabs
      const i = tabs.findIndex((t) => t.id === id)
      if (i < 0) return false
      const tx = get().tx[id]
      if ((tx === 'active' || tx === 'failed') && !window.confirm(t('db.tx.closeConfirm'))) return false
      // Closing the session rolls back whatever it had open.
      if (tabs[i].kind === 'sql') void window.api.db.session.close(id)
      const next = tabs.filter((t) => t.id !== id)
      const active = get().active === id ? (next[i] ?? next[i - 1])?.id ?? null : get().active
      const runs = { ...get().runs }
      delete runs[id]
      const txs = { ...get().tx }
      delete txs[id]
      set({ runs, tx: txs })
      commit(next, active)
      return true
    },
    setTx: (id, tx) => {
      if (get().tx[id] !== tx) set((s) => ({ tx: { ...s.tx, [id]: tx } }))
    },
    syncTx: async (id) => {
      const tx = await window.api.db.session.status(id).catch(() => 'none' as const)
      if (get().tabs.some((x) => x.id === id)) get().setTx(id, tx)
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
