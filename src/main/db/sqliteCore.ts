import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { statements } from './sqlText'
import { commandOf, isTxControl, type Cell } from './driver'

// One SQLite database handle and everything run on it. node:sqlite is
// synchronous, so this lives in a worker thread (sqlite-worker.ts); main
// talks to it over messages and stops a runaway query by ending the worker.

export interface OpenOpts {
  file: string
  readOnly: boolean
  startupScript?: string
}

/** A result column as SQLite describes it; main turns table/column into ids. */
export interface RawColumn {
  name: string
  type: string
  database?: string
  table?: string
  column?: string
}

export interface RawResult {
  columns: RawColumn[]
  rows: Cell[][]
  truncated: boolean
  rowCount: number | null
  command: string
}

export interface ApplyStatement {
  text: string
  values: Array<string | null>
}

const BUSY_TIMEOUT_MS = 5000

const hex = (b: Uint8Array): string => '0x' + Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex')

/** 64-bit integers stay exact: a number when it fits, text otherwise. Blobs as 0x-hex. */
export function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()
  if (v instanceof Uint8Array) return hex(v)
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  return String(v)
}

const row = (r: unknown[]): Cell[] => r.map(cell)

// An expression column has no declared type: name it after its first value.
function valueType(rows: Cell[][], i: number): string {
  for (const r of rows) {
    const v = r[i]
    if (v === null) continue
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'real'
    return typeof v === 'string' && /^0x[0-9a-f]*$/.test(v) ? 'blob' : 'text'
  }
  return ''
}

function columnsOf(st: StatementSync, rows: Cell[][]): RawColumn[] {
  return st.columns().map((c, i) => ({
    name: c.name,
    type: c.type ? c.type.toLowerCase() : valueType(rows, i),
    ...(c.table && c.column && c.database ? { database: c.database, table: c.table, column: c.column } : {})
  }))
}

export class SqliteCore {
  readonly db: DatabaseSync
  private stream?: { st: StatementSync; it: Iterator<unknown[]> }

  constructor(o: OpenOpts) {
    if (!o.file) throw new Error('No database file')
    this.db = new DatabaseSync(o.file, { readOnly: o.readOnly })
    this.db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`)
    const script = o.startupScript?.trim()
    if (script) for (const s of statements(script, 'sqlite')) this.db.exec(s)
  }

  close(): void {
    this.stream = undefined
    if (this.db.isOpen) this.db.close()
  }

  get inTx(): boolean {
    return this.db.isTransaction
  }

  private prepare(sql: string): StatementSync {
    const st = this.db.prepare(sql)
    st.setReadBigInts(true)
    st.setReturnArrays(true)
    return st
  }

  /** One statement; keeps `limit` rows after skipping `skip`, notes whether more existed. */
  query(sql: string, o: { limit: number; skip?: number; readOnly?: boolean }): RawResult {
    if (o.readOnly) this.db.exec('pragma query_only = 1')
    try {
      return this.read(sql, o.limit, o.skip ?? 0)
    } finally {
      if (o.readOnly) this.db.exec('pragma query_only = 0')
    }
  }

  private read(sql: string, limit: number, skip: number): RawResult {
    const st = this.prepare(sql)
    const command = commandOf(sql)
    if (!st.columns().length) {
      const r = st.run()
      return { columns: [], rows: [], truncated: false, rowCount: Number(r.changes), command }
    }
    const rows: Cell[][] = []
    let truncated = false
    // Breaking out of the loop resets the statement: the rest is never read.
    for (const r of st.iterate() as Iterable<unknown[]>) {
      if (skip > 0) {
        skip--
        continue
      }
      if (rows.length >= limit) {
        truncated = true
        break
      }
      rows.push(row(r))
    }
    return { columns: columnsOf(st, rows), rows, truncated, rowCount: null, command }
  }

  /** For its effect: rows a statement returns are counted, not kept. */
  private effect(sql: string): { command: string; rowCount: number | null } {
    const st = this.prepare(sql)
    if (!st.columns().length) return { command: commandOf(sql), rowCount: Number(st.run().changes) }
    let n = 0
    for (const _ of st.iterate()) n++
    return { command: commandOf(sql), rowCount: n }
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.exec('begin')
    try {
      const out = fn()
      this.db.exec('commit')
      return out
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('rollback')
      throw err
    }
  }

  /** Statements in one transaction, all or nothing. */
  execute(stmts: string[]): Array<{ command: string; rowCount: number | null }> {
    return this.inTransaction(() => stmts.map((s) => this.effect(s)))
  }

  /** Designer / object-action DDL. SQLite DDL is transactional, so atomic plans are. */
  ddl(stmts: string[], atomic: boolean): number {
    const run = (): number => {
      for (const s of stmts) this.db.exec(s)
      return stmts.length
    }
    return atomic ? this.inTransaction(run) : run()
  }

  /** Small catalog reads. */
  rows(sql: string, params: Array<string | number | null> = []): Cell[][] {
    return (this.prepare(sql).all(...params) as unknown as unknown[][]).map(row)
  }

  /**
   * Grid edits, all or nothing, each required to touch exactly one row; each
   * returns its row as stored (RETURNING). Inside an open transaction the
   * edits run under a savepoint so a failure undoes only them.
   */
  apply(stmts: ApplyStatement[]): Array<Cell[] | null> {
    const exec = (): Array<Cell[] | null> =>
      stmts.map((s) => {
        const st = this.prepare(s.text)
        // DELETE has no RETURNING: its row count is the change count.
        const returns = st.columns().length > 0
        const got = returns ? (st.all(...s.values) as unknown as unknown[][]) : null
        const n = got ? got.length : Number(st.run(...s.values).changes)
        if (n !== 1) {
          const verb = s.text.slice(0, s.text.indexOf(' '))
          throw new Error(`${verb} matched ${n} rows instead of 1; nothing was applied`)
        }
        return got ? row(got[0]) : null
      })
    if (!this.db.isTransaction) return this.inTransaction(exec)
    this.db.exec('savepoint riven_apply')
    try {
      const out = exec()
      this.db.exec('release riven_apply')
      return out
    } catch (err) {
      this.db.exec('rollback to riven_apply')
      this.db.exec('release riven_apply')
      throw err
    }
  }

  // ---- manual-commit session -------------------------------------------------------

  /**
   * One statement on a session. A user statement opens a transaction when
   * none is open and runs under a savepoint, so a failing one is undone alone.
   * `aux` (paging, counts) never opens a transaction.
   */
  sessionQuery(sql: string, o: { limit: number; skip?: number; aux?: boolean }): RawResult {
    const control = isTxControl(sql)
    let began = false
    if (!o.aux && !control && !this.db.isTransaction) {
      this.db.exec('begin')
      began = true
    }
    const guard = !control && this.db.isTransaction
    try {
      if (guard) this.db.exec('savepoint riven_stmt')
      const r = this.read(sql, o.limit, o.skip ?? 0)
      if (guard && this.db.isTransaction) this.db.exec('release riven_stmt')
      return r
    } catch (err) {
      if (began) {
        if (this.db.isTransaction) this.db.exec('rollback')
      } else if (guard && this.db.isTransaction) {
        this.db.exec('rollback to riven_stmt')
        this.db.exec('release riven_stmt')
      }
      throw err
    }
  }

  sessionEnd(action: 'commit' | 'rollback'): boolean {
    if (this.db.isTransaction) this.db.exec(action)
    return this.db.isTransaction
  }

  // ---- export stream (pulled in batches) ------------------------------------------

  streamOpen(sql: string): void {
    const st = this.prepare(sql)
    this.stream = { st, it: (st.iterate() as IterableIterator<unknown[]>)[Symbol.iterator]() }
  }

  /** Up to `n` more rows; fewer means the end. */
  streamNext(n: number): Cell[][] {
    const s = this.stream
    if (!s) return []
    const out: Cell[][] = []
    while (out.length < n) {
      const r = s.it.next()
      if (r.done) {
        this.stream = undefined
        break
      }
      out.push(row(r.value))
    }
    return out
  }

  streamClose(): void {
    this.stream?.it.return?.()
    this.stream = undefined
  }
}

/** The SQLite version (for "test connection"). */
export const sqliteVersion = (c: SqliteCore): string => String(c.rows('select sqlite_version()')[0]?.[0] ?? '')
