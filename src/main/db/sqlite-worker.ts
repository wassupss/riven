import { parentPort, workerData } from 'node:worker_threads'
import { SqliteCore, sqliteVersion, type OpenOpts } from './sqliteCore'

// Worker thread owning one SQLite handle (see sqlite.ts). Calls arrive one at
// a time as { id, method, args }; each answers { id, value } or { id, error }.

export interface WorkerCall {
  id: number
  method: string
  args: unknown[]
}

export type WorkerReply = { id: number; value: unknown } | { id: number; error: { message: string; code?: string } }

let core: SqliteCore | undefined
let openError: unknown
try {
  core = new SqliteCore(workerData as OpenOpts)
} catch (err) {
  openError = err
}

const methods: Record<string, (c: SqliteCore, ...args: never[]) => unknown> = {
  version: (c) => sqliteVersion(c),
  query: (c, sql: string, o: Parameters<SqliteCore['query']>[1]) => c.query(sql, o),
  execute: (c, stmts: string[]) => c.execute(stmts),
  ddl: (c, stmts: string[], atomic: boolean) => c.ddl(stmts, atomic),
  rows: (c, sql: string, params: Array<string | number | null>) => c.rows(sql, params),
  apply: (c, stmts: Parameters<SqliteCore['apply']>[0]) => c.apply(stmts),
  sessionQuery: (c, sql: string, o: Parameters<SqliteCore['sessionQuery']>[1]) => c.sessionQuery(sql, o),
  sessionEnd: (c, action: 'commit' | 'rollback') => c.sessionEnd(action),
  inTx: (c) => c.inTx,
  streamOpen: (c, sql: string) => c.streamOpen(sql),
  streamNext: (c, n: number) => c.streamNext(n),
  streamClose: (c) => c.streamClose()
}

parentPort?.on('message', (m: WorkerCall) => {
  let reply: WorkerReply
  try {
    if (!core) throw openError
    const fn = methods[m.method]
    if (!fn) throw new Error(`Unknown method ${m.method}`)
    reply = { id: m.id, value: fn(core, ...(m.args as never[])) }
  } catch (err) {
    const e = err as { message?: string; code?: string }
    reply = { id: m.id, error: { message: e?.message ?? String(err), code: e?.code } }
  }
  parentPort?.postMessage(reply)
})
