import type { EditStatement, EditTarget } from './edit'
import type { CompletionMeta } from './complete'
import type { ColumnDetail, ConnectionConfig, DbObject, QueryResult, SchemaInfo, TableInfo, TxStatus } from './types'

// What every SQL engine provides. engine.ts picks the driver by the
// connection's kind; features beyond this set (roles, monitoring, backup...)
// stay PostgreSQL-only and are gated by engines.ts caps.

export type Cell = string | number | boolean | null

export interface QueryOpts {
  limit: number
  /** Run inside a read-only transaction. */
  readOnly?: boolean
  timeoutMs?: number
  queryId?: string
  /** Rows to drop from the front (engines that page on the client). */
  skip?: number
}

export interface Driver {
  /** Connect once and report the server (for "test connection"). */
  test(cfg: ConnectionConfig, password?: string): Promise<string>
  /** One statement; stops after `limit` rows (truncated when more existed). */
  query(cfg: ConnectionConfig, db: string | undefined, sql: string, o: QueryOpts): Promise<QueryResult>
  /** A read in batches (export): at most `max` rows, never all in memory. */
  stream(
    cfg: ConnectionConfig,
    db: string | undefined,
    sql: string,
    o: { queryId?: string; max: number; batch?: number },
    onRows: (rows: Cell[][]) => Promise<void> | void
  ): Promise<number>
  /** Statements in one transaction, all or nothing. */
  execute(cfg: ConnectionConfig, db: string | undefined, stmts: string[], timeoutMs: number): Promise<Array<{ command: string; rowCount: number | null }>>
  /** Designer / object-action DDL. */
  ddl(cfg: ConnectionConfig, db: string | undefined, stmts: string[], atomic: boolean, timeoutMs: number, searchPath?: string): Promise<number>
  sessionQuery(
    cfg: ConnectionConfig,
    db: string | undefined,
    id: string,
    sql: string,
    o: { limit: number; queryId?: string; aux?: boolean; skip?: number }
  ): Promise<QueryResult>
  sessionStatus(id: string): Promise<TxStatus>
  sessionEnd(id: string, action: 'commit' | 'rollback'): Promise<TxStatus>
  sessionClose(id: string): Promise<void>
  hasSession(id: string): boolean
  /** Grid edits, each touching exactly one row; returns each row as stored. */
  apply(cfg: ConnectionConfig, db: string | undefined, session: string | undefined, stmts: EditStatement[]): Promise<Array<Cell[] | null>>
  cancel(cfg: ConnectionConfig, queryId: string): Promise<boolean>
  closeConnection(id: string): Promise<void>
  closeDatabase(id: string, db: string): Promise<void>
  closeAll(): Promise<void>

  listDatabases(cfg: ConnectionConfig): Promise<string[]>
  listSchemas(cfg: ConnectionConfig, db?: string): Promise<SchemaInfo[]>
  listObjects(cfg: ConnectionConfig, db: string | undefined, schema: string): Promise<DbObject[]>
  findSchema(cfg: ConnectionConfig, db: string | undefined, name: string): Promise<string | null>
  tableInfo(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<TableInfo | null>
  columnDetail(cfg: ConnectionConfig, db: string | undefined, table: number, attnum: number): Promise<ColumnDetail | null>
  objectDdl(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<string>
  editTarget(cfg: ConnectionConfig, db: string | undefined, table: number): Promise<EditTarget | null>
  completionMeta(cfg: ConnectionConfig, db: string | undefined): Promise<CompletionMeta>
}

// Statements that manage the transaction themselves are run as they are.
const TX_CONTROL = /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction|set\s+transaction|xa\s)\b/i
const leadingComments = /^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/
export const isTxControl = (sql: string): boolean => TX_CONTROL.test(sql.replace(leadingComments, ''))

/** First word of a statement, upper-cased (the command tag engines without one report). */
export const commandOf = (sql: string): string => (/^[a-z]+/i.exec(sql.replace(leadingComments, ''))?.[0] ?? '').toUpperCase()
