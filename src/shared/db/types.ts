import type { DbKind } from './sqlText'

export type { DbKind }

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full'

// One saved data source. The password never lives here: it's sealed separately in the store.
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
  /** Source table oid and column number when the column is a plain table column. */
  table?: number
  attnum?: number
}

/** What a result column is in its source table (for the grid's header menu). */
export interface ColumnDetail {
  table: string
  column: string
  type: string
  nullable: boolean
  default: string | null
  comment: string | null
  identity: string | null
  constraints: Array<{ type: 'p' | 'f' | 'u' | 'c' | 'x'; name: string; def: string }>
  indexes: string[]
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

/** A manual-commit session: none (no connection), idle, in a transaction, or in a failed one. */
export type TxStatus = 'none' | 'idle' | 'active' | 'failed'

// ---- roles and privileges ----------------------------------------------------

export interface RoleInfo {
  name: string
  superuser: boolean
  login: boolean
  inherit: boolean
  createDb: boolean
  createRole: boolean
  replication: boolean
  bypassRls: boolean
  /** -1: no limit. */
  connLimit: number
  validUntil: string | null
  comment: string | null
  /** Roles this one is a member of. */
  memberOf: Array<{ role: string; admin: boolean }>
  /** Built-in pg_* role. */
  system: boolean
}

/** What GRANT/REVOKE act on. Views, matviews and foreign tables are 'table'. */
export type PrivKind = 'table' | 'sequence' | 'schema' | 'database' | 'function' | 'procedure'

export interface PrivTarget {
  kind: PrivKind
  /** Empty for schemas and databases. */
  schema: string
  name: string
  /** Routines: identity arguments. */
  args?: string
}

/** One privilege held by a grantee ('PUBLIC' for everyone). */
export interface Grant {
  grantee: string
  privilege: string
  grantable: boolean
}

export interface PrivInfo {
  owner: string
  grants: Grant[]
  /** Privileges this kind of object has on this server. */
  available: string[]
}

export type DefaultObjType = 'tables' | 'sequences' | 'functions' | 'types' | 'schemas'

/** An ALTER DEFAULT PRIVILEGES rule: what `role` creates in `schema` gets granted. */
export interface DefaultAcl {
  role: string
  /** Null: everywhere (the role's global default). */
  schema: string | null
  objType: DefaultObjType
  grantee: string
  privilege: string
  grantable: boolean
}

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

export interface PolicyInfo {
  name: string
  command: PolicyCommand
  permissive: boolean
  roles: string[]
  using: string | null
  check: string | null
}

export interface RlsInfo {
  enabled: boolean
  forced: boolean
  policies: PolicyInfo[]
}

/** A role's privilege on one object in a database (the role's "what can I touch" view). */
export interface RoleGrant {
  kind: 'table' | 'view' | 'matview' | 'foreign' | 'partitioned' | 'sequence' | 'schema' | 'function' | 'procedure' | 'database'
  schema: string
  name: string
  privileges: string[]
  grantable: string[]
  /** Held through PUBLIC rather than directly. */
  viaPublic: boolean
}
