import { pgRows } from './pg'
import type { IndexStat, LockInfo, ServerOverview, SessionInfo, SettingInfo, TableStat } from './monitor'
import type { ConnectionConfig } from './types'

// Catalog reads behind the monitor tab (PostgreSQL 10+). Sizes and counters
// come back as float8 so they arrive as numbers, not int8 text.

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v))
const age = (col: string): string => `extract(epoch from now() - ${col})::float8`
const pids = (v: unknown): number[] => (v ? String(v).split(',').map(Number).filter(Number.isFinite) : [])

export async function serverOverview(cfg: ConnectionConfig, db: string | undefined): Promise<ServerOverview> {
  const [head] = await pgRows(
    cfg,
    db,
    `select version(), current_setting('server_version_num')::int,
            ${age('pg_postmaster_start_time()')}, current_database()::text,
            pg_database_size(current_database())::float8,
            current_setting('max_connections')::int,
            d.xact_commit::float8, d.xact_rollback::float8, d.blks_hit::float8, d.blks_read::float8,
            d.deadlocks::float8, d.temp_bytes::float8, d.conflicts::float8, d.tup_returned::float8,
            d.tup_fetched::float8, d.tup_inserted::float8, d.tup_updated::float8, d.tup_deleted::float8,
            (select count(*)::int from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0),
            (select ${age('min(xact_start)')} from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()),
            current_setting('is_superuser') = 'on'
       from pg_stat_database d where d.datname = current_database()`
  )
  const states = await pgRows(
    cfg,
    db,
    `select coalesce(state, 'unknown'), count(*)::int from pg_stat_activity
      where backend_type = 'client backend' and pid <> pg_backend_pid() group by 1`
  )
  const dbs = await pgRows(
    cfg,
    db,
    `select datname::text, pg_database_size(datname)::float8 from pg_database
      where datallowconn and not datistemplate and has_database_privilege(datname, 'CONNECT') order by 2 desc`
  )
  const s: Record<string, number> = {}
  for (const [k, n] of states) s[str(k)] = num(n)
  const h = head ?? []
  return {
    version: str(h[0]),
    versionNum: num(h[1]),
    uptime: num(h[2]),
    database: str(h[3]),
    dbSize: num(h[4]),
    maxConnections: num(h[5]),
    connections: Object.values(s).reduce((a, b) => a + b, 0),
    states: s,
    commits: num(h[6]),
    rollbacks: num(h[7]),
    blksHit: num(h[8]),
    blksRead: num(h[9]),
    deadlocks: num(h[10]),
    tempBytes: num(h[11]),
    conflicts: num(h[12]),
    tupReturned: num(h[13]),
    tupFetched: num(h[14]),
    tupInserted: num(h[15]),
    tupUpdated: num(h[16]),
    tupDeleted: num(h[17]),
    blocked: num(h[18]),
    oldestXact: numOrNull(h[19]),
    superuser: h[20] === true,
    databases: dbs.map(([n, size]) => ({ name: str(n), size: num(size) }))
  }
}

/** Every backend but the one asking. */
export async function listSessions(cfg: ConnectionConfig, db: string | undefined): Promise<SessionInfo[]> {
  const rows = await pgRows(
    cfg,
    db,
    `select pid, coalesce(usename::text, ''), coalesce(datname::text, ''), application_name,
            coalesce(host(client_addr), case when client_port = -1 then 'local' else '' end),
            coalesce(backend_type, ''), coalesce(state, ''), coalesce(wait_event_type, ''), coalesce(wait_event, ''),
            ${age('backend_start')}, ${age('xact_start')}, ${age('query_start')}, ${age('state_change')},
            left(query, 10000), array_to_string(pg_blocking_pids(pid), ',')
       from pg_stat_activity where pid <> pg_backend_pid()
      order by (state = 'active') desc nulls last, query_start nulls last`
  )
  return rows.map((r) => ({
    pid: num(r[0]),
    user: str(r[1]),
    database: str(r[2]),
    application: str(r[3]),
    client: str(r[4]),
    backendType: str(r[5]),
    state: str(r[6]),
    waitType: str(r[7]),
    wait: str(r[8]),
    backendAge: numOrNull(r[9]),
    xactAge: numOrNull(r[10]),
    queryAge: numOrNull(r[11]),
    stateAge: numOrNull(r[12]),
    query: str(r[13]),
    blockedBy: pids(r[14])
  }))
}

/** Locks of other backends, waiting ones first. Relation names resolve in the database asked. */
export async function listLocks(cfg: ConnectionConfig, db: string | undefined): Promise<LockInfo[]> {
  const rows = await pgRows(
    cfg,
    db,
    `select l.pid, l.locktype, l.mode, l.granted,
            case when l.relation is null then ''
                 when l.database = (select oid from pg_database where datname = current_database()) then l.relation::regclass::text
                 else l.relation::text end,
            concat_ws(' ', l.transactionid::text, l.virtualxid, case when l.page is not null then 'page ' || l.page end,
                      case when l.tuple is not null then 'tuple ' || l.tuple end),
            coalesce(a.usename::text, ''), coalesce(a.state, ''), ${age('a.query_start')}, left(coalesce(a.query, ''), 2000)
       from pg_locks l left join pg_stat_activity a on a.pid = l.pid
      where l.pid is distinct from pg_backend_pid()
      order by l.granted, a.query_start nulls last, l.pid
      limit 2000`
  )
  return rows.map((r) => ({
    pid: num(r[0]),
    locktype: str(r[1]),
    mode: str(r[2]),
    granted: r[3] === true,
    relation: str(r[4]),
    target: str(r[5]),
    user: str(r[6]),
    state: str(r[7]),
    queryAge: numOrNull(r[8]),
    query: str(r[9])
  }))
}

export async function tableStats(cfg: ConnectionConfig, db: string | undefined): Promise<TableStat[]> {
  const rows = await pgRows(
    cfg,
    db,
    `select s.schemaname::text, s.relname::text, c.relkind::text,
            pg_total_relation_size(s.relid)::float8, pg_relation_size(s.relid)::float8, pg_indexes_size(s.relid)::float8,
            case when c.reltoastrelid = 0 then 0 else pg_total_relation_size(c.reltoastrelid) end::float8,
            s.n_live_tup::float8, s.n_dead_tup::float8, coalesce(s.seq_scan, 0)::float8, coalesce(s.idx_scan, 0)::float8,
            s.n_tup_ins::float8, s.n_tup_upd::float8, s.n_tup_del::float8, s.n_mod_since_analyze::float8,
            ${age('greatest(s.last_vacuum, s.last_autovacuum)')}, ${age('greatest(s.last_analyze, s.last_autoanalyze)')},
            s.last_autovacuum is not null and (s.last_vacuum is null or s.last_autovacuum > s.last_vacuum),
            s.last_autoanalyze is not null and (s.last_analyze is null or s.last_autoanalyze > s.last_analyze)
       from pg_stat_user_tables s join pg_class c on c.oid = s.relid
      order by 4 desc, 1, 2`
  )
  return rows.map((r) => ({
    schema: str(r[0]),
    name: str(r[1]),
    kind: str(r[2]),
    total: num(r[3]),
    table: num(r[4]),
    indexes: num(r[5]),
    toast: num(r[6]),
    live: num(r[7]),
    dead: num(r[8]),
    seqScan: num(r[9]),
    idxScan: num(r[10]),
    inserted: num(r[11]),
    updated: num(r[12]),
    deleted: num(r[13]),
    modSinceAnalyze: num(r[14]),
    vacuumAge: numOrNull(r[15]),
    analyzeAge: numOrNull(r[16]),
    autoVacuumed: r[17] === true,
    autoAnalyzed: r[18] === true
  }))
}

export async function indexStats(cfg: ConnectionConfig, db: string | undefined): Promise<IndexStat[]> {
  const rows = await pgRows(
    cfg,
    db,
    `select s.schemaname::text, s.relname::text, s.indexrelname::text, pg_relation_size(s.indexrelid)::float8,
            s.idx_scan::float8, s.idx_tup_read::float8, s.idx_tup_fetch::float8,
            i.indisunique, i.indisprimary, i.indisvalid, pg_get_indexdef(s.indexrelid)
       from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid
      order by 4 desc, 1, 2, 3`
  )
  return rows.map((r) => ({
    schema: str(r[0]),
    table: str(r[1]),
    name: str(r[2]),
    size: num(r[3]),
    scans: num(r[4]),
    tupRead: num(r[5]),
    tupFetch: num(r[6]),
    unique: r[7] === true,
    primary: r[8] === true,
    valid: r[9] === true,
    def: str(r[10])
  }))
}

export async function listSettings(cfg: ConnectionConfig, db: string | undefined): Promise<SettingInfo[]> {
  const rows = await pgRows(
    cfg,
    db,
    `select name, coalesce(setting, ''), coalesce(unit, ''), coalesce(category, ''), coalesce(short_desc, ''),
            context, vartype, coalesce(source, ''), coalesce(min_val, ''), coalesce(max_val, ''),
            coalesce(array_to_string(enumvals, chr(31)), ''), coalesce(boot_val, ''), coalesce(reset_val, ''),
            coalesce(pending_restart, false)
       from pg_settings order by category, name`
  )
  return rows.map((r) => ({
    name: str(r[0]),
    setting: str(r[1]),
    unit: str(r[2]),
    category: str(r[3]),
    description: str(r[4]),
    context: str(r[5]),
    vartype: str(r[6]),
    source: str(r[7]),
    min: str(r[8]),
    max: str(r[9]),
    enumvals: r[10] ? str(r[10]).split('\x1f') : [],
    boot: str(r[11]),
    reset: str(r[12]),
    pendingRestart: r[13] === true
  }))
}

/** pg_cancel_backend / pg_terminate_backend. False when the backend is gone or not ours to signal. */
export async function signalBackend(cfg: ConnectionConfig, db: string | undefined, pid: number, terminate: boolean): Promise<boolean> {
  const fn = terminate ? 'pg_terminate_backend' : 'pg_cancel_backend'
  const [r] = await pgRows(cfg, db, `select ${fn}($1::int)`, [Math.floor(pid)])
  return r?.[0] === true
}

/** Re-reads postgresql.conf / auto.conf, so sighup settings changed by ALTER SYSTEM apply. */
export async function reloadConf(cfg: ConnectionConfig, db: string | undefined): Promise<boolean> {
  const [r] = await pgRows(cfg, db, 'select pg_reload_conf()')
  return r?.[0] === true
}
