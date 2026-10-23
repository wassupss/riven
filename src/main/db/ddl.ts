import { literal, quoteIdent } from './sqlText'
import type { TableInfo } from './types'

// DDL builders for the table designer and the explorer's object actions.
// Pure functions shared with the renderer (preview) and main (apply).
// PostgreSQL syntax.

const qi = (s: string): string => quoteIdent('postgres', s)
const lit = (s: string): string => literal('postgres', s)
export const qualify = (schema: string, name: string): string => `${qi(schema)}.${qi(name)}`

/** A batch of DDL to run. `atomic: false` runs each on its own (CREATE DATABASE can't be in a transaction). */
export interface DdlPlan {
  stmts: string[]
  atomic: boolean
  /** A database whose open connections (ours) must close first: dropping or renaming it needs it unused. */
  release?: string
}

// ---- table designer ---------------------------------------------------------

export interface ColumnDraft {
  /** Name in the database; undefined for a column being added. */
  orig?: string
  name: string
  type: string
  nullable: boolean
  /** SQL expression, or empty for none. */
  default: string
  comment: string
  pk: boolean
  dropped?: boolean
}

export type ConstraintType = 'foreign key' | 'unique' | 'check'

export interface ConstraintDraft {
  /** Name in the database for an existing constraint (only dropping it is supported). */
  orig?: string
  type: ConstraintType
  name: string
  /** Comma separated column list (foreign key, unique). */
  columns: string
  /** Referenced table, `schema.table` or `table` (foreign key). */
  refTable: string
  refColumns: string
  onDelete: string
  onUpdate: string
  /** Boolean expression (check). */
  expr: string
  /** Definition text of an existing constraint, for display. */
  def?: string
  dropped?: boolean
}

export interface IndexDraft {
  orig?: string
  name: string
  columns: string
  unique: boolean
  method: string
  /** Partial index predicate. */
  where: string
  def?: string
  dropped?: boolean
}

export interface TableDraft {
  schema: string
  name: string
  comment: string
  columns: ColumnDraft[]
  constraints: ConstraintDraft[]
  indexes: IndexDraft[]
}

export const FK_ACTIONS = ['', 'NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']
export const INDEX_METHODS = ['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']

/** An editable draft of an existing table. */
export function draftFromTable(t: TableInfo): TableDraft {
  const conNames = new Set(t.constraints.map((c) => c.name))
  return {
    schema: t.schema,
    name: t.name,
    comment: t.comment ?? '',
    columns: t.columns.map((c) => ({
      orig: c.name,
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      default: c.default ?? '',
      comment: c.comment ?? '',
      pk: c.primaryKey
    })),
    constraints: t.constraints
      .filter((c) => c.type !== 'primary key')
      .map((c) => ({ ...emptyConstraint(c.type as ConstraintType), orig: c.name, name: c.name, def: c.def })),
    // Indexes behind a constraint go with the constraint.
    indexes: t.indexes
      .filter((i) => !conNames.has(i.name))
      .map((i) => ({ ...emptyIndex(), orig: i.name, name: i.name, unique: i.unique, def: i.def }))
  }
}

export const emptyColumn = (): ColumnDraft => ({ name: '', type: 'text', nullable: true, default: '', comment: '', pk: false })
export const emptyConstraint = (type: ConstraintType): ConstraintDraft => ({
  type,
  name: '',
  columns: '',
  refTable: '',
  refColumns: '',
  onDelete: '',
  onUpdate: '',
  expr: ''
})
export const emptyIndex = (): IndexDraft => ({ name: '', columns: '', unique: false, method: 'btree', where: '' })
export const newTable = (schema: string): TableDraft => ({
  schema,
  name: '',
  comment: '',
  columns: [{ ...emptyColumn(), name: 'id', type: 'bigint generated always as identity', nullable: false, pk: true }],
  constraints: [],
  indexes: []
})

/** `a, "B c"` -> quoted identifiers. Already-quoted names pass through. */
export function identList(s: string): string {
  return splitList(s)
    .map((p) => (/^".*"$/.test(p) ? p : qi(p)))
    .join(', ')
}

const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

/** `schema.table` or `table` (in `schema`). */
function refName(ref: string, schema: string): string {
  const parts = ref.split('.').map((p) => p.trim())
  const q = (p: string): string => (/^".*"$/.test(p) ? p : qi(p))
  return parts.length >= 2 ? `${q(parts[0])}.${q(parts.slice(1).join('.'))}` : `${qi(schema)}.${q(parts[0])}`
}

function constraintBody(c: ConstraintDraft, schema: string): string {
  if (c.type === 'check') return `CHECK (${c.expr.trim()})`
  if (c.type === 'unique') return `UNIQUE (${identList(c.columns)})`
  let s = `FOREIGN KEY (${identList(c.columns)}) REFERENCES ${refName(c.refTable, schema)}`
  if (c.refColumns.trim()) s += ` (${identList(c.refColumns)})`
  if (c.onDelete) s += ` ON DELETE ${c.onDelete}`
  if (c.onUpdate) s += ` ON UPDATE ${c.onUpdate}`
  return s
}

const constraintSql = (c: ConstraintDraft, schema: string): string =>
  (c.name.trim() ? `CONSTRAINT ${qi(c.name.trim())} ` : '') + constraintBody(c, schema)

function indexSql(i: IndexDraft, schema: string, table: string): string {
  const name = i.name.trim() ? `${qi(i.name.trim())} ` : ''
  const using = i.method && i.method !== 'btree' ? ` USING ${i.method}` : ''
  // Expressions (lower(email)) stay as written; plain names are quoted.
  const cols = splitList(i.columns)
    .map((p) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(p) ? qi(p) : p))
    .join(', ')
  let s = `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${name}ON ${qualify(schema, table)}${using} (${cols})`
  if (i.where.trim()) s += ` WHERE ${i.where.trim()}`
  return s
}

const columnDef = (c: ColumnDraft): string => {
  let s = `${qi(c.name.trim())} ${c.type.trim()}`
  if (c.default.trim()) s += ` DEFAULT ${c.default.trim()}`
  if (!c.nullable) s += ' NOT NULL'
  return s
}

// Short spellings of the names format_type() reports, so retyping `int` for an
// `integer` column doesn't rewrite the table.
const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  int2: 'smallint',
  int8: 'bigint',
  bool: 'boolean',
  float8: 'double precision',
  float4: 'real',
  varchar: 'character varying',
  char: 'character',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
  decimal: 'numeric'
}
export function normType(t: string): string {
  const s = t.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')')
  const m = /^([a-z0-9_]+)(\(.*\))?(\[\])?$/.exec(s)
  if (!m) return s
  const base = TYPE_ALIASES[m[1]] ?? m[1]
  // `timestamp(3)` reports as `timestamp(3) without time zone`.
  if (m[2] && / (with|without) time zone$/.test(base)) return base.replace(/ (with|without)/, `${m[2]} $1`) + (m[3] ?? '')
  return base + (m[2] ?? '') + (m[3] ?? '')
}

/** Problems that would make the DDL invalid, as i18n keys with params. */
export function draftProblems(d: TableDraft): Array<{ key: string; name?: string }> {
  const out: Array<{ key: string; name?: string }> = []
  if (!d.name.trim()) out.push({ key: 'db.d.err.tableName' })
  const live = d.columns.filter((c) => !c.dropped)
  if (!live.length) out.push({ key: 'db.d.err.noColumns' })
  const seen = new Set<string>()
  for (const c of live) {
    const n = c.name.trim()
    if (!n) out.push({ key: 'db.d.err.columnName' })
    else if (seen.has(n)) out.push({ key: 'db.d.err.duplicate', name: n })
    seen.add(n)
    if (!c.type.trim()) out.push({ key: 'db.d.err.columnType', name: n })
  }
  for (const c of d.constraints.filter((c) => !c.orig && !c.dropped)) {
    if (c.type === 'check' ? !c.expr.trim() : !c.columns.trim()) out.push({ key: 'db.d.err.constraint', name: c.name })
    else if (c.type === 'foreign key' && !c.refTable.trim()) out.push({ key: 'db.d.err.constraint', name: c.name })
  }
  for (const i of d.indexes.filter((i) => !i.orig && !i.dropped)) if (!i.columns.trim()) out.push({ key: 'db.d.err.index', name: i.name })
  return out
}

/** CREATE TABLE plus its indexes and comments. */
export function createTableSql(d: TableDraft): DdlPlan {
  const table = d.name.trim()
  const full = qualify(d.schema, table)
  const cols = d.columns.filter((c) => !c.dropped)
  const lines = cols.map((c) => `    ${columnDef(c)}`)
  const pk = cols.filter((c) => c.pk)
  if (pk.length) lines.push(`    PRIMARY KEY (${pk.map((c) => qi(c.name.trim())).join(', ')})`)
  for (const c of d.constraints.filter((c) => !c.dropped)) lines.push(`    ${constraintSql(c, d.schema)}`)
  const stmts = [`CREATE TABLE ${full} (\n${lines.join(',\n')}\n)`]
  for (const i of d.indexes.filter((i) => !i.dropped)) stmts.push(indexSql(i, d.schema, table))
  if (d.comment.trim()) stmts.push(`COMMENT ON TABLE ${full} IS ${lit(d.comment.trim())}`)
  for (const c of cols.filter((c) => c.comment.trim()))
    stmts.push(`COMMENT ON COLUMN ${full}.${qi(c.name.trim())} IS ${lit(c.comment.trim())}`)
  return { stmts, atomic: true }
}

/**
 * ALTER statements turning `orig` into `d`. Order: drop constraints and
 * indexes, drop/rename/add columns, change columns, comments, then the new
 * primary key, constraints and indexes; renaming the table comes last so
 * everything before it can use the old name.
 */
export function alterTableSql(orig: TableInfo, d: TableDraft): DdlPlan {
  const full = qualify(orig.schema, orig.name)
  const at = `ALTER TABLE ${full}`
  const stmts: string[] = []
  const before = new Map(orig.columns.map((c) => [c.name, c]))

  // Primary key: compared as the ordered list of (final) column names.
  const pkBefore = orig.columns.filter((c) => c.primaryKey).map((c) => c.name)
  const pkAfter = d.columns.filter((c) => !c.dropped && c.pk).map((c) => c.name.trim())
  const pkCols = d.columns.filter((c) => !c.dropped && c.pk)
  const pkSame =
    pkCols.length === pkBefore.length && pkCols.every((c, i) => c.orig === pkBefore[i])
  const pkCon = orig.constraints.find((c) => c.type === 'primary key')

  for (const c of d.constraints.filter((c) => c.orig && c.dropped)) stmts.push(`${at} DROP CONSTRAINT ${qi(c.orig!)}`)
  if (!pkSame && pkCon) stmts.push(`${at} DROP CONSTRAINT ${qi(pkCon.name)}`)
  for (const i of d.indexes.filter((i) => i.orig && i.dropped)) stmts.push(`DROP INDEX ${qualify(orig.schema, i.orig!)}`)

  for (const c of d.columns.filter((c) => c.orig && c.dropped)) stmts.push(`${at} DROP COLUMN ${qi(c.orig!)}`)
  for (const c of d.columns.filter((c) => c.orig && !c.dropped && c.name.trim() !== c.orig))
    stmts.push(`${at} RENAME COLUMN ${qi(c.orig!)} TO ${qi(c.name.trim())}`)
  for (const c of d.columns.filter((c) => !c.orig && !c.dropped)) stmts.push(`${at} ADD COLUMN ${columnDef(c)}`)

  for (const c of d.columns.filter((c) => c.orig && !c.dropped)) {
    const o = before.get(c.orig!)
    if (!o) continue
    const col = `${at} ALTER COLUMN ${qi(c.name.trim())}`
    const type = c.type.trim()
    if (normType(type) !== normType(o.type)) stmts.push(`${col} TYPE ${type} USING ${qi(c.name.trim())}::${type}`)
    const def = c.default.trim()
    if (def !== (o.default ?? '')) stmts.push(def ? `${col} SET DEFAULT ${def}` : `${col} DROP DEFAULT`)
    // A primary key column is NOT NULL anyway; dropping the key doesn't relax it.
    if (c.nullable !== o.nullable) stmts.push(`${col} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`)
  }

  if (d.comment.trim() !== (orig.comment ?? '').trim())
    stmts.push(`COMMENT ON TABLE ${full} IS ${d.comment.trim() ? lit(d.comment.trim()) : 'NULL'}`)
  for (const c of d.columns.filter((c) => !c.dropped)) {
    const was = c.orig ? (before.get(c.orig)?.comment ?? '') : ''
    if (c.comment.trim() !== was.trim())
      stmts.push(`COMMENT ON COLUMN ${full}.${qi(c.name.trim())} IS ${c.comment.trim() ? lit(c.comment.trim()) : 'NULL'}`)
  }

  if (!pkSame && pkAfter.length) stmts.push(`${at} ADD PRIMARY KEY (${pkAfter.map(qi).join(', ')})`)
  for (const c of d.constraints.filter((c) => !c.orig && !c.dropped)) stmts.push(`${at} ADD ${constraintSql(c, orig.schema)}`)
  for (const i of d.indexes.filter((i) => !i.orig && !i.dropped)) stmts.push(indexSql(i, orig.schema, orig.name))

  if (d.name.trim() !== orig.name) stmts.push(`${at} RENAME TO ${qi(d.name.trim())}`)
  return { stmts, atomic: true }
}

/** Plain-text preview of a plan. */
export const planText = (p: DdlPlan): string => (p.stmts.length ? p.stmts.map((s) => `${s};`).join('\n\n') : '')

// ---- object actions ---------------------------------------------------------

export type DropKind = 'table' | 'view' | 'matview' | 'sequence' | 'foreign' | 'function' | 'procedure' | 'aggregate' | 'index' | 'schema' | 'database'

const KEYWORD: Record<DropKind, string> = {
  table: 'TABLE',
  view: 'VIEW',
  matview: 'MATERIALIZED VIEW',
  sequence: 'SEQUENCE',
  foreign: 'FOREIGN TABLE',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  aggregate: 'AGGREGATE',
  index: 'INDEX',
  schema: 'SCHEMA',
  database: 'DATABASE'
}

/** Kinds `DROP` takes; partitioned tables drop as tables. */
export const dropKindOf = (k: string): DropKind | null =>
  k === 'partitioned' ? 'table' : k === 'window' ? 'function' : k in KEYWORD ? (k as DropKind) : null

/** `args` is a routine's identity argument list (routines are overloadable). */
function target(kind: DropKind, schema: string, name: string, args?: string): string {
  if (kind === 'schema' || kind === 'database') return qi(name)
  const base = qualify(schema, name)
  return kind === 'function' || kind === 'procedure' || kind === 'aggregate' ? `${base}(${args ?? ''})` : base
}

export function dropSql(kind: DropKind, schema: string, name: string, o: { cascade?: boolean; args?: string; force?: boolean } = {}): DdlPlan {
  if (kind === 'database')
    return { stmts: [`DROP DATABASE ${qi(name)}${o.force ? ' WITH (FORCE)' : ''}`], atomic: false, release: name }
  return { stmts: [`DROP ${KEYWORD[kind]} ${target(kind, schema, name, o.args)}${o.cascade ? ' CASCADE' : ''}`], atomic: true }
}

export function renameSql(kind: DropKind, schema: string, name: string, to: string, args?: string): DdlPlan {
  const stmt =
    kind === 'database' || kind === 'schema'
      ? `ALTER ${KEYWORD[kind]} ${qi(name)} RENAME TO ${qi(to.trim())}`
      : `ALTER ${KEYWORD[kind]} ${target(kind, schema, name, args)} RENAME TO ${qi(to.trim())}`
  return kind === 'database' ? { stmts: [stmt], atomic: false, release: name } : { stmts: [stmt], atomic: true }
}

export function truncateSql(schema: string, name: string, o: { restartIdentity?: boolean; cascade?: boolean } = {}): DdlPlan {
  let s = `TRUNCATE TABLE ${qualify(schema, name)}`
  if (o.restartIdentity) s += ' RESTART IDENTITY'
  if (o.cascade) s += ' CASCADE'
  return { stmts: [s], atomic: true }
}

export function createSchemaSql(name: string, owner?: string): DdlPlan {
  return { stmts: [`CREATE SCHEMA ${qi(name.trim())}${owner?.trim() ? ` AUTHORIZATION ${qi(owner.trim())}` : ''}`], atomic: true }
}

export function createDatabaseSql(name: string, o: { owner?: string; template?: string; encoding?: string } = {}): DdlPlan {
  let s = `CREATE DATABASE ${qi(name.trim())}`
  if (o.owner?.trim()) s += ` OWNER ${qi(o.owner.trim())}`
  if (o.template?.trim()) s += ` TEMPLATE ${qi(o.template.trim())}`
  if (o.encoding?.trim()) s += ` ENCODING ${lit(o.encoding.trim())}`
  return { stmts: [s], atomic: false }
}

export function createViewSql(schema: string, name: string, query: string, materialized: boolean): DdlPlan {
  const body = query.trim().replace(/;+\s*$/, '')
  const head = materialized ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'
  return { stmts: [`${head} ${qualify(schema, name.trim())} AS\n${body}`], atomic: true }
}

export function refreshMatviewSql(schema: string, name: string, concurrently: boolean): DdlPlan {
  // CONCURRENTLY can't run inside a transaction block.
  return {
    stmts: [`REFRESH MATERIALIZED VIEW ${concurrently ? 'CONCURRENTLY ' : ''}${qualify(schema, name)}`],
    atomic: !concurrently
  }
}

/** Statements an apply call accepts: DDL only, so the IPC can't be used to run arbitrary reads or DML. */
export const DDL_VERBS = /^(create|alter|drop|truncate|comment|refresh|reindex|vacuum|analyze|grant|revoke|cluster)\b/i
