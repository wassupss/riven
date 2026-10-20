import type { DbKind } from './sqlText'

export type { DbKind }

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

// One saved data source. Field names follow dbtool's ConnectionConfig so its
// export file ({app:"dbtool", connections}) can be imported later. The password
// never lives here: it's sealed separately in the store.
export interface ConnectionConfig {
  id: string
  name: string
  kind: DbKind
  host: string
  port: number
  user: string
  database: string
  readOnly: boolean
  color?: string
  ssl?: { mode: SslMode; ca?: string; cert?: string; key?: string }
  options?: {
    timeZone?: string
    isolation?: 'read committed' | 'repeatable read' | 'serializable'
    startupScript?: string
  }
}

/** What the renderer sees: config plus whether a password is stored (never the password). */
export interface ConnectionInfo extends ConnectionConfig {
  hasPassword: boolean
}

export interface QueryColumn {
  name: string
  type: string
}

export interface QueryResult {
  columns: QueryColumn[]
  rows: Array<Array<string | number | boolean | null>>
  /** More rows existed than `limit`. */
  truncated: boolean
  /** For non-SELECT statements: affected row count. */
  rowCount: number | null
  command: string
  timeMs: number
}

export type ObjectKind =
  | 'table'
  | 'partitioned'
  | 'view'
  | 'matview'
  | 'foreign'
  | 'sequence'
  | 'function'
  | 'procedure'
  | 'aggregate'
  | 'window'

export interface DbObject {
  name: string
  kind: ObjectKind
  comment?: string | null
  rows?: number | null
  /** Routines: identity arguments and result type. */
  args?: string
  result?: string
}

export interface SchemaInfo {
  name: string
  isSystem: boolean
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  default: string | null
  comment: string | null
  primaryKey: boolean
}

export interface TableInfo {
  schema: string
  name: string
  kind: ObjectKind
  comment: string | null
  columns: ColumnInfo[]
  indexes: Array<{ name: string; def: string; unique: boolean; primary: boolean }>
  constraints: Array<{ name: string; type: string; def: string }>
}
