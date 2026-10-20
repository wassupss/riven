import { readFileSync } from 'fs'
import { homedir } from 'os'
import pg from 'pg'
import Cursor from 'pg-cursor'
import { getPassword } from './store'
import { statements } from './sqlText'
import type { ConnectionConfig, QueryColumn, QueryResult } from './types'

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

function entry(cfg: ConnectionConfig, database?: string): { key: string; e: PoolEntry } {
  const db = database || cfg.database || 'postgres'
  const key = `${cfg.id}::${db}`
  let e = pools.get(key)
  if (!e) {
    const pool = new pg.Pool({ ...clientConfig(cfg, db), max: 4, idleTimeoutMillis: 5 * 60_000, allowExitOnIdle: true })
    // An idle client dying (server restart, network drop) emits here; unhandled it would crash main.
    pool.on('error', () => {})
    const tz = cfg.options?.timeZone?.trim()
    const script = cfg.options?.startupScript?.trim()
    if (tz || script) {
      pool.on('connect', (client) => {
        // Queued ahead of the caller's queries on this client.
        if (tz) client.query(`set time zone '${tz.replace(/'/g, "''")}'`).catch(() => {})
        if (script) for (const s of statements(script, 'postgres')) client.query(s).catch(() => {})
      })
    }
    e = { pool, typeNames: new Map() }
    pools.set(key, e)
  }
  return { key, e }
}

/** Close every pool of a connection (after its config changed or it was deleted). */
export async function closeConnection(id: string): Promise<void> {
  const ends: Array<Promise<void>> = []
  for (const [k, e] of pools) {
    if (k.startsWith(id + '::')) {
      pools.delete(k)
      ends.push(e.pool.end().catch(() => {}))
    }
  }
  await Promise.all(ends)
}

export async function closeAll(): Promise<void> {
  const all = [...pools.values()]
  pools.clear()
  await Promise.all(all.map((e) => e.pool.end().catch(() => {})))
}

/** Run a metadata query (rows as arrays). */
export async function pgRows(cfg: ConnectionConfig, database: string | undefined, sql: string, params: unknown[] = []): Promise<Cell[][]> {
  const { e } = entry(cfg, database)
  const r = await e.pool.query({ text: sql, values: params, rowMode: 'array' })
  return r.rows as Cell[][]
}

async function columnTypes(e: PoolEntry, client: pg.PoolClient, oids: number[]): Promise<void> {
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

/** One statement through a cursor. Stops after limit rows (truncated=true when more existed). */
export async function pgQuery(cfg: ConnectionConfig, database: string | undefined, sql: string, o: PgQueryOpts): Promise<QueryResult> {
  const { key, e } = entry(cfg, database)
  const started = Date.now()
  const client = await e.pool.connect()
  const pid = (client as unknown as { processID: number }).processID
  if (o.queryId) running.set(o.queryId, { connKey: key, pid })
  let broken: Error | undefined
  try {
    if (o.readOnly) await client.query('begin read only')
    if (o.timeoutMs) await client.query(`set ${o.readOnly ? 'local ' : ''}statement_timeout = ${Math.floor(o.timeoutMs)}`)
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: TYPES }))
    let res: Awaited<ReturnType<typeof readCursor>>
    try {
      res = await readCursor(cursor, o.limit + 1)
    } finally {
      await cursor.close().catch(() => {})
    }
    await columnTypes(e, client, res.fields.map((f) => f.dataTypeID))
    const columns: QueryColumn[] = res.fields.map((f) => ({
      name: f.name,
      type: TYPE_NAMES[f.dataTypeID] ?? e.typeNames.get(f.dataTypeID) ?? ''
    }))
    const truncated = res.rows.length > o.limit
    return {
      columns,
      rows: truncated ? res.rows.slice(0, o.limit) : res.rows,
      truncated,
      rowCount: res.fields.length ? null : res.rowCount,
      command: res.command,
      timeMs: Date.now() - started
    }
  } catch (err) {
    broken = err instanceof Error ? err : new Error(String(err))
    throw broken
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
