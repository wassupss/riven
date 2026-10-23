import mysql from 'mysql2'
import { getPassword } from './store'
import { sslOption } from './pg'
import { literal, statements } from './sqlText'
import { columnId, tableId } from './tableIds'
import { commandOf, isTxControl, type Cell, type QueryOpts } from './driver'
import type { EditStatement } from './edit'
import type { ConnectionConfig, QueryColumn, QueryResult, TxStatus } from './types'

// MySQL / MariaDB driver. One pool per (connection, database); idle
// connections close on their own. Reads stream row by row and stop at
// limit+1, so a big table never lands in memory.

type Conn = mysql.Connection
type Header = mysql.ResultSetHeader
type Flavor = 'mysql' | 'mariadb'

interface PoolEntry {
  pool: mysql.Pool
}

const pools = new Map<string, PoolEntry>()
// queryId -> server thread, for KILL QUERY.
const running = new Map<string, { key: string; thread: number }>()

const ISOLATION = ['read committed', 'repeatable read', 'serializable']
const DDL_LOCK_WAIT_S = 10
const SERVER_STATUS_IN_TRANS = 1

// Bytes (BLOB, BINARY, BIT, GEOMETRY) come back as 0x-hex text; everything
// else as mysql2 reads it under dateStrings / bigNumberStrings / jsonStrings
// (lossless text for 64-bit ints, decimals, dates and json).
const typeCast = (field: { type: string; buffer: () => Buffer | null }, next: () => unknown): unknown => {
  if (field.type === 'GEOMETRY' || field.type === 'VECTOR') {
    const b = field.buffer()
    return b ? '0x' + b.toString('hex') : null
  }
  const v = next()
  return Buffer.isBuffer(v) ? '0x' + v.toString('hex') : v
}

function options(cfg: ConnectionConfig, db: string, password?: string): mysql.ConnectionOptions {
  return {
    host: cfg.host || 'localhost',
    port: cfg.port || 3306,
    user: cfg.user,
    password: password ?? getPassword(cfg.id),
    database: db || undefined,
    ssl: sslOption(cfg) as mysql.ConnectionOptions['ssl'],
    connectTimeout: 10_000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    jsonStrings: true,
    multipleStatements: false,
    typeCast: typeCast as mysql.ConnectionOptions['typeCast']
  }
}

const noop = (): void => {}

// Session setup the connection asks for, queued ahead of the first query.
function setup(cfg: ConnectionConfig, c: Conn): void {
  c.on('error', noop)
  const tz = cfg.options?.timeZone?.trim()
  if (tz) c.query(`set time_zone = ${literal('mysql', tz)}`, noop)
  const iso = cfg.options?.isolation
  if (iso && ISOLATION.includes(iso)) c.query(`set session transaction isolation level ${iso}`, noop)
  if (cfg.readOnly) c.query('set session transaction read only', noop)
  const script = cfg.options?.startupScript?.trim()
  if (script) for (const s of statements(script, 'mysql')) c.query(s, noop)
}

const dbOf = (cfg: ConnectionConfig, database?: string): string => database || cfg.database || ''

function entry(cfg: ConnectionConfig, database?: string): { key: string; e: PoolEntry } {
  const db = dbOf(cfg, database)
  const key = `${cfg.id}::${db}`
  let e = pools.get(key)
  if (!e) {
    const pool = mysql.createPool({ ...options(cfg, db), connectionLimit: 4, maxIdle: 0, idleTimeout: 5 * 60_000 })
    pool.on('connection', (c) => setup(cfg, c as unknown as Conn))
    // An idle connection dying (server restart, network drop) must not crash main.
    ;(pool as unknown as { on(ev: string, fn: () => void): void }).on('error', noop)
    e = { pool }
    pools.set(key, e)
  }
  return { key, e }
}

const getConn = (pool: mysql.Pool): Promise<mysql.PoolConnection> =>
  new Promise((resolve, reject) => pool.getConnection((err, c) => (err ? reject(err) : resolve(c))))

/** One statement, buffered (catalog reads, control statements). */
function run(c: Conn, sql: string, values?: unknown[]): Promise<{ rows: unknown; fields?: mysql.FieldPacket[] }> {
  return new Promise((resolve, reject) =>
    c.query({ sql, values, rowsAsArray: true }, (err, rows, fields) => (err ? reject(err) : resolve({ rows, fields })))
  )
}

const flavorOf = (c: Conn): Flavor =>
  /mariadb/i.test((c as unknown as { _handshakePacket?: { serverVersion?: string } })._handshakePacket?.serverVersion ?? '')
    ? 'mariadb'
    : 'mysql'

// MySQL caps SELECTs in ms; MariaDB caps every statement in seconds.
const timeoutSql = (c: Conn, ms: number): string =>
  flavorOf(c) === 'mariadb'
    ? `set session max_statement_time = ${Math.max(0.001, ms / 1000)}`
    : `set session max_execution_time = ${Math.max(1, Math.floor(ms))}`
const timeoutReset = (c: Conn): string =>
  flavorOf(c) === 'mariadb' ? 'set session max_statement_time = default' : 'set session max_execution_time = default'

async function inTx(c: Conn): Promise<boolean> {
  const r = await run(c, 'do 0')
  return ((r.rows as Header).serverStatus & SERVER_STATUS_IN_TRANS) !== 0
}

// ---- reads ----------------------------------------------------------------------

const TYPE_NAMES: Record<string, string> = {
  DECIMAL: 'decimal', NEWDECIMAL: 'decimal', TINY: 'tinyint', SHORT: 'smallint', LONG: 'int', INT24: 'mediumint',
  LONGLONG: 'bigint', FLOAT: 'float', DOUBLE: 'double', TIMESTAMP: 'timestamp', DATE: 'date', NEWDATE: 'date',
  TIME: 'time', DATETIME: 'datetime', YEAR: 'year', VARCHAR: 'varchar', VAR_STRING: 'varchar', STRING: 'char',
  BIT: 'bit', JSON: 'json', ENUM: 'enum', SET: 'set', TINY_BLOB: 'blob', MEDIUM_BLOB: 'blob', LONG_BLOB: 'blob',
  BLOB: 'blob', GEOMETRY: 'geometry', NULL: 'null', VECTOR: 'vector'
}
const TYPE_BY_ID = mysql.Types as unknown as Record<number, string>
const BINARY_CHARSET = 63
const FLAG_UNSIGNED = 32
const FLAG_ENUM = 256
const FLAG_SET = 2048

interface Field {
  name: string
  columnType: number
  characterSet: number
  flags: number
  schema: string
  orgTable: string
  orgName: string
}

function typeName(f: Field): string {
  if (f.flags & FLAG_ENUM) return 'enum'
  if (f.flags & FLAG_SET) return 'set'
  let t = TYPE_NAMES[TYPE_BY_ID[f.columnType]] ?? ''
  const bin = f.characterSet === BINARY_CHARSET
  if (t === 'blob' && !bin) t = 'text'
  else if (t === 'varchar' && bin) t = 'varbinary'
  else if (t === 'char' && bin) t = 'binary'
  if (f.flags & FLAG_UNSIGNED && /int|decimal|float|double/.test(t)) t += ' unsigned'
  return t
}

function columnsOf(cfg: ConnectionConfig, fields: Field[]): QueryColumn[] {
  return fields.map((f) => {
    const t = f.orgTable && f.orgName && f.schema ? tableId(cfg.id, f.schema, f.orgTable) : 0
    return { name: f.name, type: typeName(f), ...(t ? { table: t, attnum: columnId(t, f.orgName) } : {}) }
  })
}

/**
 * Stream one statement: keep `limit` rows (after skipping `skip`), note
 * whether more existed. Past the limit a pool connection is dropped (the
 * server stops sending), a session's is read to the end without keeping rows.
 * Only the first result set is kept (CALL can return several).
 */
function readQuery(
  cfg: ConnectionConfig,
  c: Conn,
  sql: string,
  o: { limit: number; skip?: number; drain: boolean },
  started: number
): Promise<{ result: QueryResult; destroyed: boolean }> {
  return new Promise((resolve, reject) => {
    const q = c.query({ sql, rowsAsArray: true })
    let fields: Field[] | undefined
    let header: Header | undefined
    const rows: Cell[][] = []
    let skip = o.skip ?? 0
    let truncated = false
    let done = false
    const finish = (destroyed: boolean): void => {
      if (done) return
      done = true
      resolve({
        result: {
          columns: fields ? columnsOf(cfg, fields) : [],
          rows,
          truncated,
          rowCount: fields ? null : (header?.affectedRows ?? null),
          command: commandOf(sql),
          timeMs: Date.now() - started
        },
        destroyed
      })
    }
    q.on('fields', (f: Field[] | undefined) => {
      if (fields === undefined && header === undefined && f) fields = f
    })
    q.on('result', (row: unknown, index?: number) => {
      if (done || (index ?? 0) > 0) return
      if (!Array.isArray(row)) {
        if (!fields && !header) header = row as Header
        return
      }
      if (truncated) return
      if (skip > 0) {
        skip--
        return
      }
      if (rows.length < o.limit) {
        rows.push(row as Cell[])
        return
      }
      truncated = true
      if (!o.drain) {
        c.pause()
        c.destroy()
        finish(true)
      }
    })
    q.on('error', (err: Error) => {
      if (done) return
      done = true
      reject(err)
    })
    q.on('end', () => finish(false))
  })
}

export async function myQuery(cfg: ConnectionConfig, database: string | undefined, sql: string, o: QueryOpts & { skip?: number }): Promise<QueryResult> {
  const { key, e } = entry(cfg, database)
  const started = Date.now()
  const c = await getConn(e.pool)
  if (o.queryId) running.set(o.queryId, { key, thread: c.threadId })
  let gone = false
  try {
    if (o.timeoutMs) await run(c, timeoutSql(c, o.timeoutMs))
    if (o.readOnly) await run(c, 'start transaction read only')
    const r = await readQuery(cfg, c, sql, { limit: o.limit, skip: o.skip, drain: false }, started)
    gone = r.destroyed
    return r.result
  } finally {
    if (o.queryId) running.delete(o.queryId)
    if (!gone) {
      try {
        if (o.readOnly) await run(c, 'rollback')
        if (o.timeoutMs) await run(c, timeoutReset(c))
        c.release()
      } catch {
        c.destroy()
      }
    }
  }
}

export async function myStream(
  cfg: ConnectionConfig,
  database: string | undefined,
  sql: string,
  o: { queryId?: string; max: number; batch?: number },
  onRows: (rows: Cell[][]) => Promise<void> | void
): Promise<number> {
  const { key, e } = entry(cfg, database)
  const c = await getConn(e.pool)
  if (o.queryId) running.set(o.queryId, { key, thread: c.threadId })
  const size = o.batch ?? 2000
  let n = 0
  let gone = false
  try {
    await run(c, 'start transaction read only')
    await new Promise<void>((resolve, reject) => {
      const q = c.query({ sql, rowsAsArray: true })
      let batch: Cell[][] = []
      let failed: unknown
      let busy: Promise<void> = Promise.resolve()
      // The writer is slower than the network: pause the socket while a batch is written.
      const flush = (): void => {
        const rows = batch
        batch = []
        c.pause()
        busy = busy
          .then(() => onRows(rows))
          .then(
            () => c.resume(),
            (err) => {
              failed = err
              c.destroy()
              gone = true
              reject(err)
            }
          )
      }
      q.on('result', (row: unknown, index?: number) => {
        if (failed || (index ?? 0) > 0 || !Array.isArray(row)) return
        if (n >= o.max) {
          if (!gone) {
            gone = true
            c.pause()
            c.destroy()
            void busy.then(() => (batch.length ? onRows(batch) : undefined)).then(() => resolve(), reject)
          }
          return
        }
        batch.push(row as Cell[])
        n++
        if (batch.length >= size) flush()
      })
      q.on('error', (err: Error) => {
        if (!gone) reject(err)
      })
      q.on('end', () => {
        if (gone) return
        void busy.then(() => (batch.length ? onRows(batch) : undefined)).then(() => resolve(), reject)
      })
    })
    return n
  } finally {
    if (o.queryId) running.delete(o.queryId)
    if (!gone) {
      try {
        await run(c, 'rollback')
        c.release()
      } catch {
        c.destroy()
      }
    }
  }
}

// ---- writes ---------------------------------------------------------------------

/** One statement for its effect: rows a read returns are counted, not kept. */
async function effect(cfg: ConnectionConfig, c: Conn, sql: string): Promise<{ command: string; rowCount: number | null }> {
  const r = await readQuery(cfg, c, sql, { limit: 0, drain: true }, Date.now())
  return { command: r.result.command, rowCount: r.result.rowCount }
}

export async function myExecute(
  cfg: ConnectionConfig,
  database: string | undefined,
  stmts: string[],
  timeoutMs: number
): Promise<Array<{ command: string; rowCount: number | null }>> {
  const { e } = entry(cfg, database)
  const c = await getConn(e.pool)
  let ok = false
  try {
    await run(c, timeoutSql(c, timeoutMs))
    await run(c, 'start transaction')
    const out: Array<{ command: string; rowCount: number | null }> = []
    for (const s of stmts) out.push(await effect(cfg, c, s))
    await run(c, 'commit')
    ok = true
    return out
  } finally {
    if (!ok) await run(c, 'rollback').catch(noop)
    await run(c, timeoutReset(c)).then(
      () => c.release(),
      () => c.destroy()
    )
  }
}

/**
 * DDL from the designer and object actions, one statement at a time (MySQL
 * commits each DDL statement itself, so a plan can't be all or nothing). A
 * short lock wait keeps an ALTER from queueing every other query behind it.
 */
export async function myDdl(cfg: ConnectionConfig, database: string | undefined, stmts: string[], _atomic: boolean, timeoutMs: number): Promise<number> {
  const { e } = entry(cfg, database)
  const c = await getConn(e.pool)
  try {
    await run(c, `set session lock_wait_timeout = ${DDL_LOCK_WAIT_S}`)
    if (flavorOf(c) === 'mariadb') await run(c, timeoutSql(c, timeoutMs))
    let n = 0
    for (const s of stmts) {
      await run(c, s)
      n++
    }
    return n
  } finally {
    // Session variables were changed: this connection isn't reused.
    c.destroy()
  }
}

// ---- sessions -------------------------------------------------------------------
// A manual-commit console tab owns one dedicated connection, so its
// transaction spans runs. Work on a session runs one call at a time.

interface Session {
  id: string
  key: string
  c: Conn
  chain: Promise<unknown>
  tx: boolean
  timer?: ReturnType<typeof setTimeout>
  dead?: boolean
}

const sessions = new Map<string, Session>()
const SESSION_IDLE_MS = 10 * 60_000

function dropSession(id: string, only?: Session): Promise<void> {
  const s = sessions.get(id)
  if (!s || (only && s !== only)) return Promise.resolve()
  sessions.delete(id)
  s.dead = true
  if (s.timer) clearTimeout(s.timer)
  return new Promise<void>((resolve) => s.c.end(() => resolve())).then(noop, noop)
}

function newSession(cfg: ConnectionConfig, db: string, id: string): Session {
  const c = mysql.createConnection(options(cfg, db))
  const s: Session = { id, key: `${cfg.id}::${db}`, c, chain: Promise.resolve(), tx: false }
  c.on('error', () => void dropSession(id, s))
  c.on('end', () => void dropSession(id, s))
  s.chain = new Promise<void>((resolve, reject) =>
    c.connect((err) => {
      if (err) {
        void dropSession(id, s)
        reject(err)
      } else {
        setup(cfg, c)
        resolve()
      }
    })
  )
  sessions.set(id, s)
  return s
}

function onSession<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const p = s.chain.then(async () => {
    if (s.dead) throw new Error('The session was closed')
    try {
      return await fn()
    } finally {
      if (!s.dead) s.tx = await inTx(s.c).catch(() => s.tx)
    }
  })
  s.chain = p.catch(noop)
  void s.chain.then(() => {
    if (s.dead) return
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      if (!s.tx) void dropSession(s.id, s)
    }, SESSION_IDLE_MS)
  })
  return p
}

function withSession<T>(cfg: ConnectionConfig, database: string | undefined, id: string, fn: (s: Session) => Promise<T>): Promise<T> {
  const db = dbOf(cfg, database)
  let s = sessions.get(id)
  if (s && s.key !== `${cfg.id}::${db}`) {
    if (s.tx) return Promise.reject(new Error('Commit or roll back the open transaction before switching connection or database'))
    void dropSession(id, s)
    s = undefined
  }
  const live = s ?? newSession(cfg, db, id)
  return onSession(live, () => fn(live))
}

export const myHasSession = (id: string): boolean => sessions.has(id)

/**
 * One statement on a session. A user statement opens a transaction when none
 * is open and runs under a savepoint, so a failing one is undone alone. DDL
 * commits on its own in MySQL: the savepoint is then gone with the
 * transaction. `aux` (paging, counts) never opens a transaction.
 */
export function mySessionQuery(
  cfg: ConnectionConfig,
  database: string | undefined,
  id: string,
  sql: string,
  o: { limit: number; queryId?: string; aux?: boolean; skip?: number }
): Promise<QueryResult> {
  return withSession(cfg, database, id, async (s) => {
    const started = Date.now()
    const c = s.c
    const control = isTxControl(sql)
    let tx = await inTx(c)
    let began = false
    if (!o.aux && !control && !tx) {
      await run(c, 'start transaction')
      began = true
      tx = true
    }
    const guard = !control && tx
    if (o.queryId) running.set(o.queryId, { key: s.key, thread: c.threadId })
    try {
      if (guard) await run(c, 'savepoint riven_stmt')
      const r = await readQuery(cfg, c, sql, { limit: o.limit, skip: o.skip, drain: true }, started)
      if (guard && (await inTx(c))) await run(c, 'release savepoint riven_stmt')
      return r.result
    } catch (err) {
      if (began) await run(c, 'rollback').catch(noop)
      else if (guard) await run(c, 'rollback to savepoint riven_stmt').catch(noop)
      throw err
    } finally {
      if (o.queryId) running.delete(o.queryId)
    }
  })
}

export function mySessionStatus(id: string): Promise<TxStatus> {
  const s = sessions.get(id)
  if (!s) return Promise.resolve('none')
  return onSession(s, async () => ((await inTx(s.c)) ? 'active' : 'idle') as TxStatus).catch(() => 'none' as const)
}

export function mySessionEnd(id: string, action: 'commit' | 'rollback'): Promise<TxStatus> {
  const s = sessions.get(id)
  if (!s) return Promise.reject(new Error('No open transaction (the session was closed)'))
  return onSession(s, async () => {
    await run(s.c, action)
    return ((await inTx(s.c)) ? 'active' : 'idle') as TxStatus
  })
}

export const mySessionClose = (id: string): Promise<void> => dropSession(id)

/**
 * Grid edits, all or nothing, each required to touch exactly one row (the
 * connection reports matched rows, so an update to the same value counts).
 * MySQL has no RETURNING: each statement's row is read back by its key.
 */
export async function myApply(
  cfg: ConnectionConfig,
  database: string | undefined,
  sessionId: string | undefined,
  stmts: EditStatement[]
): Promise<Array<Cell[] | null>> {
  const exec = async (c: Conn): Promise<Array<Cell[] | null>> => {
    const out: Array<Cell[] | null> = []
    for (const st of stmts) {
      const h = (await run(c, st.text, st.values)).rows as Header
      if (h.affectedRows !== 1) {
        const verb = st.text.slice(0, st.text.indexOf(' '))
        throw new Error(`${verb} matched ${h.affectedRows ?? 0} rows instead of 1; nothing was applied`)
      }
      if (!st.fetch) {
        out.push(null)
        continue
      }
      const values = st.fetch.insertId ? [...st.fetch.values, h.insertId] : st.fetch.values
      const rows = (await run(c, st.fetch.text, values)).rows as Cell[][]
      out.push(rows[0] ?? null)
    }
    return out
  }
  if (sessionId) {
    return withSession(cfg, database, sessionId, async (s) => {
      const began = !(await inTx(s.c))
      if (began) await run(s.c, 'start transaction')
      await run(s.c, 'savepoint riven_apply')
      try {
        const out = await exec(s.c)
        await run(s.c, 'release savepoint riven_apply')
        return out
      } catch (err) {
        await run(s.c, began ? 'rollback' : 'rollback to savepoint riven_apply').catch(noop)
        throw err
      }
    })
  }
  const { e } = entry(cfg, database)
  const c = await getConn(e.pool)
  let ok = false
  try {
    await run(c, 'start transaction')
    const out = await exec(c)
    await run(c, 'commit')
    ok = true
    return out
  } finally {
    if (!ok) await run(c, 'rollback').catch(noop)
    c.release()
  }
}

// ---- control ------------------------------------------------------------------

function connectOnce(cfg: ConnectionConfig, db: string, password?: string): Promise<Conn> {
  const c = mysql.createConnection(options(cfg, db, password))
  c.on('error', noop)
  return new Promise((resolve, reject) =>
    c.connect((err) => {
      if (err) {
        c.destroy()
        reject(err)
      } else resolve(c)
    })
  )
}

/** Stop a running query from a separate connection (KILL QUERY). */
export async function myCancel(cfg: ConnectionConfig, queryId: string): Promise<boolean> {
  const r = running.get(queryId)
  if (!r) return false
  const c = await connectOnce(cfg, '')
  try {
    await run(c, 'kill query ?', [r.thread])
    return true
  } finally {
    c.destroy()
  }
}

export async function myTest(cfg: ConnectionConfig, password?: string): Promise<string> {
  const c = await connectOnce(cfg, dbOf(cfg), password)
  try {
    const r = (await run(c, 'select version()')).rows as Cell[][]
    const v = String(r[0]?.[0] ?? '')
    return /mariadb/i.test(v) ? `MariaDB ${v.replace(/-MariaDB.*$/i, '')}` : `MySQL ${v}`
  } finally {
    c.destroy()
  }
}

/** Rows of a catalog query (small results only). */
export async function myRows(cfg: ConnectionConfig, database: string | undefined, sql: string, params: unknown[] = []): Promise<Cell[][]> {
  const { e } = entry(cfg, database)
  const c = await getConn(e.pool)
  try {
    return (await run(c, sql, params)).rows as Cell[][]
  } finally {
    c.release()
  }
}

const endPool = (e: PoolEntry): Promise<void> => new Promise((resolve) => e.pool.end(() => resolve()))

export async function myCloseConnection(id: string): Promise<void> {
  const ends: Array<Promise<void>> = []
  for (const [k, e] of pools) {
    if (k.startsWith(id + '::')) {
      pools.delete(k)
      ends.push(endPool(e))
    }
  }
  for (const [sid, s] of sessions) if (s.key.startsWith(id + '::')) ends.push(dropSession(sid))
  await Promise.all(ends)
}

export async function myCloseDatabase(id: string, db: string): Promise<void> {
  const key = `${id}::${db}`
  const e = pools.get(key)
  pools.delete(key)
  await Promise.all([e ? endPool(e) : undefined, ...[...sessions].filter(([, s]) => s.key === key).map(([sid]) => dropSession(sid))])
}

export async function myCloseAll(): Promise<void> {
  const all = [...pools.values()]
  pools.clear()
  await Promise.all([...all.map(endPool), ...[...sessions.keys()].map((sid) => dropSession(sid))])
}
