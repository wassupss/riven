import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { columnId, tableId } from './tableIds'
import type { Cell, QueryOpts } from './driver'
import type { EditStatement } from './edit'
import type { OpenOpts, RawResult } from './sqliteCore'
import type { WorkerCall, WorkerReply } from './sqlite-worker'
import type { ConnectionConfig, QueryResult, TxStatus } from './types'

// SQLite driver. node:sqlite is synchronous, so every handle lives in a worker
// thread: a small pool per connection for one-off work, one worker per
// manual-commit session. A query that runs too long or is cancelled ends its
// worker (SQLite has no other way to stop it from outside); the next call
// opens a fresh one.

const POOL_MAX = 4
const IDLE_MS = 5 * 60_000
const SESSION_IDLE_MS = 10 * 60_000

const noop = (): void => {}

/** The file a connection points at (`host`), with ~ expanded and relative paths under home. */
export function sqliteFile(cfg: ConnectionConfig): string {
  const f = cfg.host.trim()
  if (!f || f === ':memory:') return f
  const expanded = f === '~' || f.startsWith('~/') ? path.join(os.homedir(), f.slice(1)) : f
  return path.resolve(os.homedir(), expanded)
}

const workerPath = (): string => process.env.RIVEN_SQLITE_WORKER || path.join(__dirname, 'sqlite-worker.js')

class SqlWorker {
  private readonly w: Worker
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  dead = false
  idleTimer?: ReturnType<typeof setTimeout>

  constructor(
    o: OpenOpts,
    private readonly onDeath: (w: SqlWorker) => void
  ) {
    this.w = new Worker(workerPath(), { workerData: o })
    this.w.on('message', (r: WorkerReply) => {
      const p = this.pending.get(r.id)
      if (!p) return
      this.pending.delete(r.id)
      if ('error' in r) p.reject(Object.assign(new Error(r.error.message), { code: r.error.code }))
      else p.resolve(r.value)
    })
    this.w.on('error', (err) => this.kill(err))
    this.w.on('exit', () => this.kill(new Error('The SQLite worker stopped')))
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.dead) return Promise.reject(new Error('The SQLite worker stopped'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.w.postMessage({ id, method, args } satisfies WorkerCall)
    })
  }

  /** Stop the worker; whatever it was running fails with `reason`. */
  kill(reason: Error): void {
    if (this.dead) return
    this.dead = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const p of this.pending.values()) p.reject(reason)
    this.pending.clear()
    void this.w.terminate().catch(noop)
    this.onDeath(this)
  }
}

// ---- pool -----------------------------------------------------------------------

interface Pool {
  id: string
  open: OpenOpts
  idle: SqlWorker[]
  size: number
  waiters: Array<(w: SqlWorker) => void>
}

const pools = new Map<string, Pool>()
// queryId -> the worker running it, for cancel.
const running = new Map<string, SqlWorker>()

const openOpts = (cfg: ConnectionConfig): OpenOpts => ({
  file: sqliteFile(cfg),
  readOnly: cfg.readOnly,
  startupScript: cfg.options?.startupScript
})

function poolOf(cfg: ConnectionConfig): Pool {
  let p = pools.get(cfg.id)
  if (!p) pools.set(cfg.id, (p = { id: cfg.id, open: openOpts(cfg), idle: [], size: 0, waiters: [] }))
  return p
}

function spawn(p: Pool): SqlWorker {
  p.size++
  return new SqlWorker(p.open, (w) => {
    p.size--
    p.idle = p.idle.filter((x) => x !== w)
    // A slot freed up: someone waiting gets a fresh worker.
    const next = pools.get(p.id) === p ? p.waiters.shift() : undefined
    if (next) next(spawn(p))
  })
}

function acquire(p: Pool): Promise<SqlWorker> {
  const w = p.idle.pop()
  if (w) {
    if (w.idleTimer) clearTimeout(w.idleTimer)
    return Promise.resolve(w)
  }
  if (p.size < POOL_MAX) return Promise.resolve(spawn(p))
  return new Promise((resolve) => p.waiters.push(resolve))
}

function release(p: Pool, w: SqlWorker): void {
  if (w.dead) return
  // The connection was closed (or edited) while this ran.
  if (pools.get(p.id) !== p) {
    w.kill(new Error('closed'))
    return
  }
  const next = p.waiters.shift()
  if (next) return next(w)
  p.idle.push(w)
  w.idleTimer = setTimeout(() => w.kill(new Error('idle')), IDLE_MS)
}

/**
 * Run on a pool worker. A timeout or cancel ends the worker, which is the
 * only way to stop a running SQLite statement from outside.
 */
async function onPool<T>(cfg: ConnectionConfig, o: { queryId?: string; timeoutMs?: number }, fn: (w: SqlWorker) => Promise<T>): Promise<T> {
  const p = poolOf(cfg)
  const w = await acquire(p)
  if (o.queryId) running.set(o.queryId, w)
  const timer = o.timeoutMs ? setTimeout(() => w.kill(new Error('canceling statement due to statement timeout')), o.timeoutMs) : undefined
  try {
    return await fn(w)
  } finally {
    if (timer) clearTimeout(timer)
    if (o.queryId) running.delete(o.queryId)
    release(p, w)
  }
}

function toResult(cfg: ConnectionConfig, r: RawResult, started: number): QueryResult {
  return {
    columns: r.columns.map((c) => {
      const t = c.table && c.database ? tableId(cfg.id, c.database, c.table) : 0
      return { name: c.name, type: c.type, ...(t && c.column ? { table: t, attnum: columnId(t, c.column) } : {}) }
    }),
    rows: r.rows,
    truncated: r.truncated,
    rowCount: r.rowCount,
    command: r.command,
    timeMs: Date.now() - started
  }
}

// ---- reads and writes -----------------------------------------------------------

export function slQuery(cfg: ConnectionConfig, _db: string | undefined, sql: string, o: QueryOpts & { skip?: number }): Promise<QueryResult> {
  const started = Date.now()
  return onPool(cfg, o, async (w) =>
    toResult(cfg, await w.call<RawResult>('query', sql, { limit: o.limit, skip: o.skip, readOnly: o.readOnly }), started)
  )
}

export function slStream(
  cfg: ConnectionConfig,
  _db: string | undefined,
  sql: string,
  o: { queryId?: string; max: number; batch?: number },
  onRows: (rows: Cell[][]) => Promise<void> | void
): Promise<number> {
  const size = o.batch ?? 2000
  return onPool(cfg, o, async (w) => {
    await w.call('streamOpen', sql)
    let n = 0
    try {
      // Pulled one batch at a time: the worker never runs ahead of the writer.
      while (n < o.max) {
        const rows = await w.call<Cell[][]>('streamNext', Math.min(size, o.max - n))
        if (rows.length) await onRows(rows)
        n += rows.length
        if (rows.length < size) break
      }
      return n
    } finally {
      await w.call('streamClose').catch(noop)
    }
  })
}

export function slExecute(
  cfg: ConnectionConfig,
  _db: string | undefined,
  stmts: string[],
  timeoutMs: number
): Promise<Array<{ command: string; rowCount: number | null }>> {
  return onPool(cfg, { timeoutMs }, (w) => w.call('execute', stmts))
}

export function slDdl(cfg: ConnectionConfig, _db: string | undefined, stmts: string[], atomic: boolean, timeoutMs: number): Promise<number> {
  return onPool(cfg, { timeoutMs }, (w) => w.call('ddl', stmts, atomic))
}

/** Rows of a catalog query (small results only). */
export function slRows(cfg: ConnectionConfig, sql: string, params: Array<string | number | null> = []): Promise<Cell[][]> {
  return onPool(cfg, {}, (w) => w.call('rows', sql, params))
}

// ---- sessions -------------------------------------------------------------------

interface Session {
  id: string
  conn: string
  w: SqlWorker
  chain: Promise<unknown>
  tx: boolean
  timer?: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, Session>()

function dropSession(id: string, only?: Session): Promise<void> {
  const s = sessions.get(id)
  if (!s || (only && s !== only)) return Promise.resolve()
  sessions.delete(id)
  if (s.timer) clearTimeout(s.timer)
  s.w.kill(new Error('The session was closed'))
  return Promise.resolve()
}

function newSession(cfg: ConnectionConfig, id: string): Session {
  const s: Session = { id, conn: cfg.id, w: undefined as unknown as SqlWorker, chain: Promise.resolve(), tx: false }
  // Ending the worker (cancel, timeout) ends the session with it: its open transaction is gone.
  s.w = new SqlWorker(openOpts(cfg), () => void dropSession(id, s))
  sessions.set(id, s)
  return s
}

function onSession<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const p = s.chain.then(async () => {
    try {
      return await fn()
    } finally {
      if (!s.w.dead) s.tx = await s.w.call<boolean>('inTx').catch(() => s.tx)
    }
  })
  s.chain = p.catch(noop)
  void s.chain.then(() => {
    if (s.w.dead) return
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      if (!s.tx) void dropSession(s.id, s)
    }, SESSION_IDLE_MS)
  })
  return p
}

function withSession<T>(cfg: ConnectionConfig, id: string, fn: (s: Session) => Promise<T>): Promise<T> {
  let s = sessions.get(id)
  if (s && s.conn !== cfg.id) {
    if (s.tx) return Promise.reject(new Error('Commit or roll back the open transaction before switching connection or database'))
    void dropSession(id, s)
    s = undefined
  }
  const live = s ?? newSession(cfg, id)
  return onSession(live, () => fn(live))
}

export const slHasSession = (id: string): boolean => sessions.has(id)

export function slSessionQuery(
  cfg: ConnectionConfig,
  _db: string | undefined,
  id: string,
  sql: string,
  o: { limit: number; queryId?: string; aux?: boolean; skip?: number }
): Promise<QueryResult> {
  return withSession(cfg, id, async (s) => {
    const started = Date.now()
    if (o.queryId) running.set(o.queryId, s.w)
    try {
      return toResult(cfg, await s.w.call<RawResult>('sessionQuery', sql, { limit: o.limit, skip: o.skip, aux: o.aux }), started)
    } finally {
      if (o.queryId) running.delete(o.queryId)
    }
  })
}

export function slSessionStatus(id: string): Promise<TxStatus> {
  const s = sessions.get(id)
  if (!s) return Promise.resolve('none')
  return onSession(s, async () => ((await s.w.call<boolean>('inTx')) ? 'active' : 'idle') as TxStatus).catch(() => 'none' as const)
}

export function slSessionEnd(id: string, action: 'commit' | 'rollback'): Promise<TxStatus> {
  const s = sessions.get(id)
  if (!s) return Promise.reject(new Error('No open transaction (the session was closed)'))
  return onSession(s, async () => ((await s.w.call<boolean>('sessionEnd', action)) ? 'active' : 'idle') as TxStatus)
}

export const slSessionClose = (id: string): Promise<void> => dropSession(id)

/** Grid edits, all or nothing, each touching exactly one row (RETURNING gives it back). */
export function slApply(
  cfg: ConnectionConfig,
  _db: string | undefined,
  sessionId: string | undefined,
  stmts: EditStatement[]
): Promise<Array<Cell[] | null>> {
  const plain = stmts.map((s) => ({ text: s.text, values: s.values }))
  if (sessionId) return withSession(cfg, sessionId, (s) => s.w.call('apply', plain))
  return onPool(cfg, {}, (w) => w.call('apply', plain))
}

// ---- control ------------------------------------------------------------------

export function slCancel(_cfg: ConnectionConfig, queryId: string): Promise<boolean> {
  const w = running.get(queryId)
  if (!w) return Promise.resolve(false)
  w.kill(new Error('canceling statement due to user request'))
  return Promise.resolve(true)
}

export async function slTest(cfg: ConnectionConfig): Promise<string> {
  const o = openOpts(cfg)
  if (!o.file) throw new Error('Choose a database file')
  const w = new SqlWorker(o, noop)
  try {
    return `SQLite ${await w.call<string>('version')}`
  } finally {
    w.kill(new Error('done'))
  }
}

export async function slCloseConnection(id: string): Promise<void> {
  const p = pools.get(id)
  pools.delete(id)
  if (p) {
    for (const w of [...p.idle]) w.kill(new Error('closed'))
    p.idle = []
  }
  for (const [sid, s] of sessions) if (s.conn === id) await dropSession(sid)
}

export const slCloseDatabase = (id: string): Promise<void> => slCloseConnection(id)

export async function slCloseAll(): Promise<void> {
  for (const id of [...pools.keys()]) await slCloseConnection(id)
  for (const sid of [...sessions.keys()]) await dropSession(sid)
}
