import { readFileSync } from 'fs'
import { homedir } from 'os'
import pg from 'pg'
import Cursor from 'pg-cursor'
import { getPassword } from './store'
import { statements } from './sqlText'
import type { EditStatement } from './edit'
import type { ConnectionConfig, QueryColumn, QueryResult, TxStatus } from './types'

// PostgreSQL driver. One pool per (connection, database); clients idle out on
// their own so an unused pool holds no sockets. Reads go through a cursor and
// stop at limit+1 rows, so `select * from big_table` never lands in memory.

type Cell = string | number | boolean | null

// Only types that map losslessly to JS stay parsed; everything else (int8,
// numeric, dates, json, arrays, bytea) comes back as the server's text.
const asNumber = (v: string): number | string => {
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}
const PARSERS: Record<number, (v: string) => Cell> = {
  16: (v) => v === 't',
  21: asNumber,
  23: asNumber,
  26: asNumber,
  700: asNumber,
  701: asNumber
}
const TYPES = {
  getTypeParser: (oid: number) => PARSERS[oid] ?? ((v: string) => v)
} as unknown as pg.CustomTypesConfig

// Names for result columns; unknown oids are looked up once per pool.
const TYPE_NAMES: Record<number, string> = {
  16: 'boolean', 17: 'bytea', 18: 'char', 19: 'name', 20: 'bigint', 21: 'smallint', 23: 'integer', 25: 'text',
  26: 'oid', 114: 'json', 700: 'real', 701: 'double precision', 1042: 'character', 1043: 'character varying',
  1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1700: 'numeric',
  2950: 'uuid', 3802: 'jsonb'
}

interface PoolEntry {
  pool: pg.Pool
  typeNames: Map<number, string>
}

const pools = new Map<string, PoolEntry>()
// queryId -> backend pid, for cancel.
const running = new Map<string, { connKey: string; pid: number }>()

const expand = (p: string): string => (p.startsWith('~') ? homedir() + p.slice(1) : p)

function sslOption(cfg: ConnectionConfig): pg.PoolConfig['ssl'] {
  const s = cfg.ssl
  if (!s || s.mode === 'disable') return undefined
  const files = {
    ca: s.ca ? readFileSync(expand(s.ca), 'utf8') : undefined,
    cert: s.cert ? readFileSync(expand(s.cert), 'utf8') : undefined,
    key: s.key ? readFileSync(expand(s.key), 'utf8') : undefined
  }
  if (s.mode === 'require') return { rejectUnauthorized: false, cert: files.cert, key: files.key }
  if (s.mode === 'verify-ca') return { ...files, rejectUnauthorized: true, checkServerIdentity: () => undefined }
  return { ...files, rejectUnauthorized: true }
}

const ISOLATION = ['read committed', 'repeatable read', 'serializable']

export function clientConfig(cfg: ConnectionConfig, database?: string, password?: string): pg.ClientConfig {
  const opts: string[] = []
  if (cfg.readOnly) opts.push('-c default_transaction_read_only=on')
  const iso = cfg.options?.isolation
  if (iso && ISOLATION.includes(iso)) opts.push(`-c default_transaction_isolation=${iso.replace(' ', '\\ ')}`)
  return {
    host: cfg.host || 'localhost',
    port: cfg.port || 5432,
    user: cfg.user,
    password: password ?? getPassword(cfg.id),
    database: database || cfg.database || 'postgres',
    application_name: 'riven',
    ssl: sslOption(cfg),
    options: opts.length ? opts.join(' ') : undefined,
    connectionTimeoutMillis: 10_000,
    types: TYPES
  }
}

// Session setup the connection asks for (time zone, startup script), queued
// ahead of the first query on a fresh client.
function onConnect(cfg: ConnectionConfig, client: pg.ClientBase): void {
  const tz = cfg.options?.timeZone?.trim()
  const script = cfg.options?.startupScript?.trim()
  if (tz) client.query(`set time zone '${tz.replace(/'/g, "''")}'`).catch(() => {})
  if (script) for (const s of statements(script, 'postgres')) client.query(s).catch(() => {})
}

function entry(cfg: ConnectionConfig, database?: string): { key: string; e: PoolEntry } {
  const db = database || cfg.database || 'postgres'
  const key = `${cfg.id}::${db}`
  let e = pools.get(key)
  if (!e) {
    const pool = new pg.Pool({ ...clientConfig(cfg, db), max: 4, idleTimeoutMillis: 5 * 60_000, allowExitOnIdle: true })
    // An idle client dying (server restart, network drop) emits here; unhandled it would crash main.
    pool.on('error', () => {})
    if (cfg.options?.timeZone?.trim() || cfg.options?.startupScript?.trim()) pool.on('connect', (client) => onConnect(cfg, client))
    e = { pool, typeNames: new Map() }
    pools.set(key, e)
  }
  return { key, e }
}

/** Close every pool and session of a connection (after its config changed or it was deleted). */
export async function closeConnection(id: string): Promise<void> {
  const ends: Array<Promise<void>> = []
  for (const [k, e] of pools) {
    if (k.startsWith(id + '::')) {
      pools.delete(k)
      ends.push(e.pool.end().catch(() => {}))
    }
  }
  for (const [sid, s] of sessions) if (s.key.startsWith(id + '::')) ends.push(dropSession(sid))
  await Promise.all(ends)
}

export async function closeAll(): Promise<void> {
  const all = [...pools.values()]
  pools.clear()
  await Promise.all([...all.map((e) => e.pool.end().catch(() => {})), ...[...sessions.keys()].map((sid) => dropSession(sid))])
}

/** Run a metadata query (rows as arrays). */
export async function pgRows(cfg: ConnectionConfig, database: string | undefined, sql: string, params: unknown[] = []): Promise<Cell[][]> {
  const { e } = entry(cfg, database)
  const r = await e.pool.query({ text: sql, values: params, rowMode: 'array' })
  return r.rows as Cell[][]
}

async function columnTypes(e: PoolEntry, client: pg.ClientBase, oids: number[]): Promise<void> {
  const missing = [...new Set(oids)].filter((o) => !TYPE_NAMES[o] && !e.typeNames.has(o))
  if (!missing.length) return
  try {
    const r = await client.query({ text: 'select oid::int, format_type(oid, null) from pg_type where oid = any($1)', values: [missing], rowMode: 'array' })
    for (const [oid, name] of r.rows as Array<[number, string]>) e.typeNames.set(oid, name)
  } catch {
    // Names are cosmetic; an aborted transaction just leaves them blank.
  }
}

function readCursor(cursor: Cursor, n: number): Promise<{ rows: Cell[][]; fields: pg.FieldDef[]; command: string; rowCount: number | null }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) => {
      if (err) reject(err)
      else
        resolve({
          rows: rows as unknown as Cell[][],
          fields: result?.fields ?? [],
          command: result?.command ?? '',
          rowCount: result?.rowCount ?? null
        })
    })
  })
}

export interface PgQueryOpts {
  limit: number
  /** Wrap in BEGIN READ ONLY ... ROLLBACK. */
  readOnly?: boolean
  timeoutMs?: number
  queryId?: string
}

async function cursorQuery(e: PoolEntry, client: pg.ClientBase, sql: string, limit: number, started: number): Promise<QueryResult> {
  const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: TYPES }))
  let res: Awaited<ReturnType<typeof readCursor>>
  try {
    res = await readCursor(cursor, limit + 1)
  } finally {
    await cursor.close().catch(() => {})
  }
  await columnTypes(e, client, res.fields.map((f) => f.dataTypeID))
  const columns: QueryColumn[] = res.fields.map((f) => ({
    name: f.name,
    type: TYPE_NAMES[f.dataTypeID] ?? e.typeNames.get(f.dataTypeID) ?? '',
    ...(f.tableID ? { table: f.tableID, attnum: f.columnID } : {})
  }))
  const truncated = res.rows.length > limit
  return {
    columns,
    rows: truncated ? res.rows.slice(0, limit) : res.rows,
    truncated,
    rowCount: res.fields.length ? null : res.rowCount,
    command: res.command,
    timeMs: Date.now() - started
  }
}

/** One statement through a cursor. Stops after limit rows (truncated=true when more existed). */
export async function pgQuery(cfg: ConnectionConfig, database: string | undefined, sql: string, o: PgQueryOpts): Promise<QueryResult> {
  const { key, e } = entry(cfg, database)
  const started = Date.now()
  const client = await e.pool.connect()
  const pid = (client as unknown as { processID: number }).processID
  if (o.queryId) running.set(o.queryId, { connKey: key, pid })
  try {
    if (o.readOnly) await client.query('begin read only')
    if (o.timeoutMs) await client.query(`set ${o.readOnly ? 'local ' : ''}statement_timeout = ${Math.floor(o.timeoutMs)}`)
    return await cursorQuery(e, client, sql, o.limit, started)
  } finally {
    if (o.queryId) running.delete(o.queryId)
    try {
      if (o.readOnly) await client.query('rollback')
      else if (o.timeoutMs) await client.query('set statement_timeout = default')
      client.release()
    } catch {
      // Connection is unusable: drop it from the pool instead of reusing it.
      client.release(true)
    }
  }
}

/**
 * Stream a read through a cursor in batches (for export): at most `max` rows,
 * never all in memory. Runs in a read-only transaction; cancellable by queryId.
 */
export async function pgStream(
  cfg: ConnectionConfig,
  database: string | undefined,
  sql: string,
  o: { queryId?: string; max: number; batch?: number },
  onRows: (rows: Cell[][]) => Promise<void> | void
): Promise<number> {
  const { key, e } = entry(cfg, database)
  const client = await e.pool.connect()
  const pid = (client as unknown as { processID: number }).processID
  if (o.queryId) running.set(o.queryId, { connKey: key, pid })
  let n = 0
  try {
    await client.query('begin read only')
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: TYPES }))
    try {
      while (n < o.max) {
        const { rows } = await readCursor(cursor, Math.min(o.batch ?? 2000, o.max - n))
        if (!rows.length) break
        n += rows.length
        await onRows(rows)
      }
    } finally {
      await cursor.close().catch(() => {})
    }
    return n
  } finally {
    if (o.queryId) running.delete(o.queryId)
    try {
      await client.query('rollback')
      client.release()
    } catch {
      client.release(true)
    }
  }
}

/** Run statements in one transaction; all or nothing. Returns per-statement results. */
export async function pgExecute(
  cfg: ConnectionConfig,
  database: string | undefined,
  stmts: string[],
  timeoutMs: number
): Promise<Array<{ command: string; rowCount: number | null }>> {
  const { e } = entry(cfg, database)
  const client = await e.pool.connect()
  let ok = false
  try {
    await client.query('begin')
    await client.query(`set local statement_timeout = ${Math.floor(timeoutMs)}`)
    const out: Array<{ command: string; rowCount: number | null }> = []
    for (const s of stmts) {
      const r = await client.query(s)
      out.push({ command: r.command, rowCount: r.rowCount })
    }
    await client.query('commit')
    ok = true
    return out
  } finally {
    if (!ok) await client.query('rollback').catch(() => {})
    client.release()
  }
}

// ---- sessions ------------------------------------------------------------------
// A console tab in manual-commit mode owns one dedicated connection, so its
// transaction spans runs. Work on a session runs one call at a time.

interface Session {
  id: string
  key: string
  e: PoolEntry
  client: pg.Client
  chain: Promise<unknown>
  timer?: ReturnType<typeof setTimeout>
  dead?: boolean
}

const sessions = new Map<string, Session>()
// A session with no open transaction disconnects after this long unused.
const SESSION_IDLE_MS = 10 * 60_000

const txOf = (c: pg.Client): TxStatus => {
  const v = (c as unknown as { _txStatus?: string })._txStatus
  return v === 'T' ? 'active' : v === 'E' ? 'failed' : 'idle'
}

function dropSession(id: string, only?: Session): Promise<void> {
  const s = sessions.get(id)
  if (!s || (only && s !== only)) return Promise.resolve()
  sessions.delete(id)
  s.dead = true
  if (s.timer) clearTimeout(s.timer)
  return s.client.end().catch(() => {})
}

function newSession(cfg: ConnectionConfig, db: string, id: string): Session {
  const key = `${cfg.id}::${db}`
  const client = new pg.Client(clientConfig(cfg, db))
  const s: Session = { id, key, e: entry(cfg, db).e, client, chain: Promise.resolve() }
  // The server or network dropped it: the transaction is gone either way.
  client.on('error', () => void dropSession(id, s))
  client.on('end', () => void dropSession(id, s))
  s.chain = client.connect().then(
    () => onConnect(cfg, client),
    (err) => {
      void dropSession(id, s)
      throw err
    }
  )
  sessions.set(id, s)
  return s
}

function onSession<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const p = s.chain.then(() => {
    if (s.dead) throw new Error('The session was closed')
    return fn()
  })
  s.chain = p.catch(() => {})
  void s.chain.then(() => {
    if (s.dead) return
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      if (txOf(s.client) === 'idle') void dropSession(s.id, s)
    }, SESSION_IDLE_MS)
  })
  return p
}

function withSession<T>(cfg: ConnectionConfig, database: string | undefined, id: string, fn: (s: Session) => Promise<T>): Promise<T> {
  const db = database || cfg.database || 'postgres'
  let s = sessions.get(id)
  if (s && s.key !== `${cfg.id}::${db}`) {
    if (txOf(s.client) !== 'idle') return Promise.reject(new Error('Commit or roll back the open transaction before switching connection or database'))
    void dropSession(id, s)
    s = undefined
  }
  const live = s ?? newSession(cfg, db, id)
  return onSession(live, () => fn(live))
}

export const hasSession = (id: string): boolean => sessions.has(id)

// Statements that manage the transaction themselves are run as they are.
const TX_CONTROL = /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction|set\s+transaction)\b/i
const leadingComments = /^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/
export const isTxControl = (sql: string): boolean => TX_CONTROL.test(sql.replace(leadingComments, ''))

/**
 * One statement on a session. A user statement opens a transaction when none
 * is open, and runs under a savepoint, so a failing statement is undone alone
 * instead of aborting everything before it. `aux` (paging, counts) never opens
 * one: it only joins a transaction already open, to see its uncommitted rows.
 */
export function pgSessionQuery(
  cfg: ConnectionConfig,
  database: string | undefined,
  id: string,
  sql: string,
  o: { limit: number; queryId?: string; aux?: boolean }
): Promise<QueryResult> {
  return withSession(cfg, database, id, async (s) => {
    const started = Date.now()
    const c = s.client
    const control = isTxControl(sql)
    let tx = txOf(c)
    if (o.aux && tx === 'failed') throw new Error('The transaction failed; roll it back first')
    let began = false
    if (!o.aux && !control && tx === 'idle') {
      await c.query('begin')
      began = true
      tx = 'active'
    }
    const guard = !control && tx === 'active'
    if (o.queryId) running.set(o.queryId, { connKey: s.key, pid: (c as unknown as { processID: number }).processID })
    try {
      if (guard) await c.query('savepoint riven_stmt')
      const r = await cursorQuery(s.e, c, sql, o.limit, started)
      if (guard) await c.query('release savepoint riven_stmt')
      return r
    } catch (err) {
      // A transaction this call opened is closed again rather than left empty.
      if (began) await c.query('rollback').catch(() => {})
      else if (guard) await c.query('rollback to savepoint riven_stmt').catch(() => {})
      throw err
    } finally {
      if (o.queryId) running.delete(o.queryId)
    }
  })
}

export function pgSessionStatus(id: string): Promise<TxStatus> {
  const s = sessions.get(id)
  if (!s) return Promise.resolve('none')
  return onSession(s, async () => txOf(s.client)).catch(() => 'none' as const)
}

export function pgSessionEnd(id: string, action: 'commit' | 'rollback'): Promise<TxStatus> {
  const s = sessions.get(id)
  if (!s) return Promise.reject(new Error('No open transaction (the session was closed)'))
  return onSession(s, async () => {
    await s.client.query(action)
    return txOf(s.client)
  })
}

/** Disconnect a session; whatever it had open is rolled back by the server. */
export const pgSessionClose = (id: string): Promise<void> => dropSession(id)

/**
 * Grid edits: parameterized statements, all or nothing, each required to touch
 * exactly one row. On a session they join (or open) its transaction under a
 * savepoint and are left for the user to commit; otherwise they commit here.
 * Returns each statement's RETURNING row.
 */
export async function pgApply(
  cfg: ConnectionConfig,
  database: string | undefined,
  sessionId: string | undefined,
  stmts: EditStatement[]
): Promise<Array<Cell[] | null>> {
  const exec = async (c: pg.ClientBase): Promise<Array<Cell[] | null>> => {
    const out: Array<Cell[] | null> = []
    for (const st of stmts) {
      const r = await c.query({ text: st.text, values: st.values, rowMode: 'array', types: TYPES })
      if (r.rowCount !== 1) {
        const verb = st.text.slice(0, st.text.indexOf(' '))
        throw new Error(`${verb} matched ${r.rowCount ?? 0} rows instead of 1; nothing was applied`)
      }
      out.push((r.rows[0] as Cell[] | undefined) ?? null)
    }
    return out
  }
  if (sessionId) {
    return withSession(cfg, database, sessionId, async (s) => {
      const c = s.client
      const tx = txOf(c)
      if (tx === 'failed') throw new Error('The transaction failed; roll it back first')
      const began = tx === 'idle'
      if (began) await c.query('begin')
      await c.query('savepoint riven_apply')
      try {
        const out = await exec(c)
        await c.query('release savepoint riven_apply')
        return out
      } catch (err) {
        await c.query(began ? 'rollback' : 'rollback to savepoint riven_apply').catch(() => {})
        throw err
      }
    })
  }
  const { e } = entry(cfg, database)
  const client = await e.pool.connect()
  let ok = false
  try {
    await client.query('begin')
    const out = await exec(client)
    await client.query('commit')
    ok = true
    return out
  } finally {
    if (!ok) await client.query('rollback').catch(() => {})
    client.release()
  }
}

/** Ask the server to cancel a running query (from a separate connection). */
export async function pgCancel(cfg: ConnectionConfig, queryId: string): Promise<boolean> {
  const r = running.get(queryId)
  if (!r) return false
  const db = r.connKey.slice(r.connKey.indexOf('::') + 2)
  const c = new pg.Client(clientConfig(cfg, db))
  c.on('error', () => {})
  try {
    await c.connect()
    const res = await c.query({ text: 'select pg_cancel_backend($1)', values: [r.pid], rowMode: 'array' })
    return res.rows[0]?.[0] === true
  } finally {
    await c.end().catch(() => {})
  }
}

/** Connect once and report the server version (for the "test connection" button). */
export async function pgTest(cfg: ConnectionConfig, password?: string): Promise<string> {
  const c = new pg.Client(clientConfig(cfg, undefined, password))
  c.on('error', () => {})
  try {
    await c.connect()
    const r = await c.query({ text: 'show server_version', rowMode: 'array' })
    return `PostgreSQL ${r.rows[0]?.[0] ?? ''}`.trim()
  } finally {
    await c.end().catch(() => {})
  }
}
