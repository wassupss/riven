import { literal, quoteIdent } from './sqlText'
import { qualify, type DdlPlan } from './ddl'

// Server monitoring: sessions, locks, table/index stats and settings.
// Types and pure builders shared with the renderer; the catalog reads live in
// monitorMeta.ts. PostgreSQL syntax.

const qi = (s: string): string => quoteIdent('postgres', s)
const lit = (s: string): string => literal('postgres', s)

export interface ServerOverview {
  version: string
  versionNum: number
  /** Seconds since the postmaster started. */
  uptime: number
  database: string
  dbSize: number
  connections: number
  maxConnections: number
  /** Client backends per state (active, idle, idle in transaction, ...). */
  states: Record<string, number>
  commits: number
  rollbacks: number
  blksHit: number
  blksRead: number
  deadlocks: number
  tempBytes: number
  conflicts: number
  tupReturned: number
  tupFetched: number
  tupInserted: number
  tupUpdated: number
  tupDeleted: number
  /** Sessions waiting on a lock held by another. */
  blocked: number
  /** Age of the oldest open transaction, seconds. */
  oldestXact: number | null
  superuser: boolean
  databases: Array<{ name: string; size: number }>
}

export interface SessionInfo {
  pid: number
  user: string
  database: string
  application: string
  client: string
  backendType: string
  state: string
  waitType: string
  wait: string
  /** Seconds since the backend, transaction, query and state started (null when none). */
  backendAge: number | null
  xactAge: number | null
  queryAge: number | null
  stateAge: number | null
  query: string
  blockedBy: number[]
}

export interface LockInfo {
  pid: number
  locktype: string
  mode: string
  granted: boolean
  relation: string
  /** transactionid / virtualxid / tuple target, when the lock isn't on a relation. */
  target: string
  user: string
  state: string
  queryAge: number | null
  query: string
}

export interface TableStat {
  schema: string
  name: string
  kind: string
  total: number
  table: number
  indexes: number
  toast: number
  live: number
  dead: number
  seqScan: number
  idxScan: number
  inserted: number
  updated: number
  deleted: number
  modSinceAnalyze: number
  /** Seconds since the last (auto)vacuum and (auto)analyze; null when never. */
  vacuumAge: number | null
  analyzeAge: number | null
  autoVacuumed: boolean
  autoAnalyzed: boolean
}

export interface IndexStat {
  schema: string
  table: string
  name: string
  size: number
  scans: number
  tupRead: number
  tupFetch: number
  unique: boolean
  primary: boolean
  valid: boolean
  def: string
}

export interface SettingInfo {
  name: string
  setting: string
  unit: string
  category: string
  description: string
  /** internal / postmaster / sighup / superuser / user ... */
  context: string
  vartype: string
  source: string
  min: string
  max: string
  enumvals: string[]
  boot: string
  reset: string
  pendingRestart: boolean
}

export type MonitorView = 'overview' | 'sessions' | 'locks' | 'tables' | 'indexes' | 'settings'

/** Dead tuples as a share of all tuples, 0..100. */
export const deadPct = (s: Pick<TableStat, 'live' | 'dead'>): number =>
  s.live + s.dead > 0 ? (s.dead / (s.live + s.dead)) * 100 : 0

/** Buffer cache hit ratio, 0..100 (null before any read). */
export const hitRatio = (o: Pick<ServerOverview, 'blksHit' | 'blksRead'>): number | null =>
  o.blksHit + o.blksRead > 0 ? (o.blksHit / (o.blksHit + o.blksRead)) * 100 : null

/** An index nobody reads that isn't holding up a constraint: a drop candidate. */
export const unusedIndex = (i: IndexStat): boolean => i.scans === 0 && !i.unique && !i.primary

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`
  const units = ['kB', 'MB', 'GB', 'TB', 'PB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

/** A duration in seconds as "45s", "12m 3s", "5h 2m", "3d 4h". */
export function fmtAge(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return ''
  const n = Math.max(0, Math.floor(s))
  if (n < 60) return `${n}s`
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`
  if (n < 86400) return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`
  return `${Math.floor(n / 86400)}d ${Math.floor((n % 86400) / 3600)}h`
}

export function fmtCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

// ---- maintenance -------------------------------------------------------------

export type Maintenance = 'vacuum' | 'vacuumAnalyze' | 'vacuumFull' | 'analyze' | 'reindex'

/** Maintenance that takes an ACCESS EXCLUSIVE lock (blocks reads and writes while it runs). */
export const blocking = (m: Maintenance, concurrently: boolean): boolean =>
  m === 'vacuumFull' || (m === 'reindex' && !concurrently)

/** VACUUM / ANALYZE / REINDEX of tables, each its own statement (none can run in a transaction block). */
export function maintenanceSql(
  m: Maintenance,
  tables: Array<{ schema: string; name: string }>,
  o: { verbose?: boolean; concurrently?: boolean } = {}
): DdlPlan {
  const v = o.verbose ? ' VERBOSE' : ''
  const stmts = tables.map(({ schema, name }) => {
    const t = qualify(schema, name)
    switch (m) {
      case 'vacuum':
        return `VACUUM${o.verbose ? ' (VERBOSE)' : ''} ${t}`
      case 'vacuumAnalyze':
        return `VACUUM (${o.verbose ? 'VERBOSE, ' : ''}ANALYZE) ${t}`
      case 'vacuumFull':
        return `VACUUM (${o.verbose ? 'VERBOSE, ' : ''}FULL) ${t}`
      case 'analyze':
        return `ANALYZE${v} ${t}`
      case 'reindex':
        return `REINDEX TABLE${o.concurrently ? ' CONCURRENTLY' : ''} ${t}`
    }
  })
  return { stmts, atomic: false }
}

export function reindexIndexSql(schema: string, name: string, concurrently: boolean): DdlPlan {
  return { stmts: [`REINDEX INDEX${concurrently ? ' CONCURRENTLY' : ''} ${qualify(schema, name)}`], atomic: false }
}

// ---- settings ------------------------------------------------------------------

/** Where a changed setting is stored: postgresql.auto.conf (ALTER SYSTEM) or the database (ALTER DATABASE). */
export type SettingScope = 'system' | 'database'

/** Settings that ALTER DATABASE can't set (they apply cluster-wide or at server start). */
export const databaseSettable = (s: Pick<SettingInfo, 'context'>): boolean =>
  s.context === 'user' || s.context === 'superuser'

/** Settings that only take effect after a server restart. */
export const needsRestart = (s: Pick<SettingInfo, 'context'>): boolean => s.context === 'postmaster'

/** Settings the server never lets you change. */
export const readOnlySetting = (s: Pick<SettingInfo, 'context'>): boolean => s.context === 'internal'

/** Sets (or with value null, resets) a setting. ALTER SYSTEM can't run in a transaction block. */
export function settingSql(scope: SettingScope, name: string, value: string | null, database?: string): DdlPlan {
  const target = scope === 'system' ? 'ALTER SYSTEM' : `ALTER DATABASE ${qi(database ?? '')}`
  // Extension settings are dotted (pg_stat_statements.max): quote each part.
  const n = name.split('.').map(qi).join('.')
  const stmt = value === null ? `${target} RESET ${n}` : `${target} SET ${n} = ${lit(value)}`
  return { stmts: [stmt], atomic: false }
}
