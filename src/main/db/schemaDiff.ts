import { literal, quoteIdent } from './sqlText'
import type { DdlPlan } from './ddl'

// Schema comparison: two snapshots of one schema each, the objects that
// differ, and the DDL that makes the target match the source. Pure, shared
// with the renderer. Snapshots are read with search_path set to the schema
// itself, so references inside it come out unqualified and the two sides
// compare even when the schema names differ; the migration runs with the
// target schema as its search_path for the same reason.

const qi = (s: string): string => quoteIdent('postgres', s)
const lit = (s: string | null): string => literal('postgres', s)

export interface SnapColumn {
  name: string
  type: string
  notNull: boolean
  default: string | null
  /** 'a': GENERATED ALWAYS AS IDENTITY, 'd': BY DEFAULT, '': none. */
  identity: '' | 'a' | 'd'
  /** Expression of a stored generated column. */
  generated: string | null
  comment: string | null
}

export interface SnapNamedDef {
  name: string
  def: string
}

export interface SnapConstraint extends SnapNamedDef {
  /** p primary key, u unique, c check, f foreign key, x exclusion. */
  type: string
}

export interface SnapTable {
  name: string
  partitioned: boolean
  unlogged: boolean
  partKey: string | null
  columns: SnapColumn[]
  constraints: SnapConstraint[]
  /** Indexes that don't back a constraint. */
  indexes: SnapNamedDef[]
  triggers: SnapNamedDef[]
  comment: string | null
}

export interface SnapView {
  name: string
  materialized: boolean
  def: string
  columns: Array<{ name: string; type: string }>
  indexes: SnapNamedDef[]
  comment: string | null
  /** Creation order (oid), so views come after the views they read. */
  order: number
}

export interface SnapSequence {
  name: string
  type: string
  start: string
  increment: string
  min: string
  max: string
  cache: string
  cycle: boolean
  /** "table.column" quoted, for serial columns. */
  ownedBy: string | null
}

export interface SnapEnum {
  name: string
  labels: string[]
  comment: string | null
}

export interface SnapRoutine {
  name: string
  procedure: boolean
  /** Identity arguments: what tells overloads apart. */
  args: string
  /** Full argument list with names and defaults. */
  argsFull: string
  result: string | null
  /** pg_get_functiondef with the name unqualified. */
  def: string
  comment: string | null
}

export interface SchemaSnapshot {
  schema: string
  tables: SnapTable[]
  views: SnapView[]
  sequences: SnapSequence[]
  enums: SnapEnum[]
  routines: SnapRoutine[]
}

export type DiffKind = 'table' | 'view' | 'matview' | 'sequence' | 'enum' | 'function' | 'procedure'
/** added: only in the source (created in the target); removed: only in the target (dropped). */
export type DiffStatus = 'added' | 'removed' | 'changed'

export interface DiffItem {
  key: string
  kind: DiffKind
  name: string
  status: DiffStatus
  /** DDL of each side, for the side-by-side view ('' when missing). */
  source: string
  target: string
  /** Statements this item contributes and whether any of them loses data. */
  stmts: number
  destructive: boolean
  warnings: string[]
}

export interface Migration {
  stmts: string[]
  warnings: string[]
  /** Statements that drop data: tables, columns, type changes. */
  destructive: number
}

// ---- rendering --------------------------------------------------------------

const sorted = <T extends { name: string }>(a: T[]): T[] => [...a].sort((x, y) => x.name.localeCompare(y.name))

function columnSql(c: SnapColumn, withDefault = true): string {
  let s = `${qi(c.name)} ${c.type}`
  if (c.generated !== null) s += ` GENERATED ALWAYS AS (${c.generated}) STORED`
  else if (c.identity) s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`
  else if (withDefault && c.default !== null) s += ` DEFAULT ${c.default}`
  if (c.notNull && !c.identity) s += ' NOT NULL'
  return s
}

const seqSql = (s: SnapSequence, name: string): string =>
  `CREATE SEQUENCE ${name} AS ${s.type} INCREMENT BY ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} START WITH ${s.start} CACHE ${s.cache}${s.cycle ? ' CYCLE' : ' NO CYCLE'}`

const enumSql = (e: SnapEnum, name: string): string => `CREATE TYPE ${name} AS ENUM (${e.labels.map(lit).join(', ')})`

const viewSql = (v: SnapView, name: string): string => `CREATE ${v.materialized ? 'MATERIALIZED VIEW' : 'VIEW'} ${name} AS\n${v.def.replace(/;\s*$/, '')}`

const commentSql = (what: string, name: string, c: string | null): string => `COMMENT ON ${what} ${name} IS ${c === null ? 'NULL' : lit(c)}`

/** The whole object as DDL, for reading and for the side-by-side diff. */
function renderTable(t: SnapTable): string {
  const lines = t.columns.map((c) => `    ${columnSql(c)}`)
  for (const k of sorted(t.constraints)) lines.push(`    CONSTRAINT ${qi(k.name)} ${k.def}`)
  let s = `CREATE ${t.unlogged ? 'UNLOGGED ' : ''}TABLE ${qi(t.name)} (\n${lines.join(',\n')}\n)${t.partKey ? ` PARTITION BY ${t.partKey}` : ''};`
  for (const i of sorted(t.indexes)) s += `\n${i.def};`
  for (const g of sorted(t.triggers)) s += `\n${g.def};`
  if (t.comment !== null) s += `\n${commentSql('TABLE', qi(t.name), t.comment)};`
  for (const c of t.columns) if (c.comment !== null) s += `\n${commentSql('COLUMN', `${qi(t.name)}.${qi(c.name)}`, c.comment)};`
  return s
}

function renderView(v: SnapView): string {
  let s = viewSql(v, qi(v.name)).replace(/\s*$/, ';')
  for (const i of sorted(v.indexes)) s += `\n${i.def};`
  if (v.comment !== null) s += `\n${commentSql(v.materialized ? 'MATERIALIZED VIEW' : 'VIEW', qi(v.name), v.comment)};`
  return s
}

function renderSequence(s: SnapSequence): string {
  return `${seqSql(s, qi(s.name))};${s.ownedBy ? `\nALTER SEQUENCE ${qi(s.name)} OWNED BY ${s.ownedBy};` : ''}`
}

function renderEnum(e: SnapEnum): string {
  return `${enumSql(e, qi(e.name))};${e.comment !== null ? `\n${commentSql('TYPE', qi(e.name), e.comment)};` : ''}`
}

const routineWhat = (r: SnapRoutine): string => (r.procedure ? 'PROCEDURE' : 'FUNCTION')

function renderRoutine(r: SnapRoutine): string {
  const body = r.def.replace(/\s*$/, '')
  return `${body}${/;$/.test(body) ? '' : ';'}${r.comment !== null ? `\n${commentSql(routineWhat(r), `${qi(r.name)}(${r.args})`, r.comment)};` : ''}`
}

// ---- items ------------------------------------------------------------------

interface Obj {
  key: string
  kind: DiffKind
  name: string
  src?: unknown
  tgt?: unknown
  /** Sort order among views (creation order). */
  order: number
}

const routineKey = (r: SnapRoutine): string => `${r.name}(${r.args})`

function objects(src: SchemaSnapshot, tgt: SchemaSnapshot): Obj[] {
  const out = new Map<string, Obj>()
  const add = (kind: DiffKind, name: string, side: 'src' | 'tgt', o: unknown, order = 0): void => {
    // Views and matviews share a namespace with tables; one kind per name.
    const key = `${kind === 'matview' ? 'view' : kind === 'procedure' ? 'function' : kind}:${name}`
    const cur = out.get(key) ?? { key, kind, name, order }
    cur[side] = o
    if (side === 'src') {
      cur.kind = kind
      cur.order = order
    } else if (!cur.src) cur.order = order
    out.set(key, cur)
  }
  for (const [side, s] of [['tgt', tgt], ['src', src]] as const) {
    for (const t of s.tables) add('table', t.name, side, t)
    for (const v of s.views) add(v.materialized ? 'matview' : 'view', v.name, side, v, v.order)
    for (const q of s.sequences) add('sequence', q.name, side, q)
    for (const e of s.enums) add('enum', e.name, side, e)
    for (const r of s.routines) add(r.procedure ? 'procedure' : 'function', routineKey(r), side, r)
  }
  return [...out.values()]
}

function render(o: Obj, side: 'src' | 'tgt'): string {
  const v = o[side]
  if (!v) return ''
  switch (o.kind) {
    case 'table':
      return renderTable(v as SnapTable)
    case 'view':
    case 'matview':
      return renderView(v as SnapView)
    case 'sequence':
      return renderSequence(v as SnapSequence)
    case 'enum':
      return renderEnum(v as SnapEnum)
    default:
      return renderRoutine(v as SnapRoutine)
  }
}

// ---- migration --------------------------------------------------------------

// Statements go into phases so that, whatever objects are picked, dependents
// are dropped before what they depend on and created after it.
enum Ph {
  DropTrigger,
  DropView,
  DropFk,
  DropCons,
  Sequence,
  Type,
  Table,
  Routine,
  Defaults,
  DropRoutine,
  DropTable,
  DropSeq,
  DropType,
  AddCons,
  AddFk,
  View,
  Trigger,
  Late,
  Count
}

interface Fragment {
  ph: string[][]
  warnings: string[]
  destructive: number
}

const fragment = (): Fragment => ({ ph: Array.from({ length: Ph.Count }, () => []), warnings: [], destructive: 0 })

interface Ctx {
  /** Target schema, for qualifying the names our own statements create. */
  schema: string
  /** Routine names in the source, so defaults calling them wait until they exist. */
  routines: string[]
}

const byName = <T extends { name: string }>(a: T[]): Map<string, T> => new Map(a.map((x) => [x.name, x]))

function tablePlan(f: Fragment, c: Ctx, s: SnapTable | undefined, t: SnapTable | undefined): void {
  const q = (n: string): string => `${qi(c.schema)}.${qi(n)}`
  const usesRoutine = (expr: string): boolean => c.routines.some((r) => expr.includes(`${qi(r)}(`) || expr.includes(`${r}(`))
  if (!s && t) {
    for (const g of t.triggers) f.ph[Ph.DropTrigger].push(`DROP TRIGGER IF EXISTS ${qi(g.name)} ON ${q(t.name)}`)
    for (const k of t.constraints) if (k.type === 'f') f.ph[Ph.DropFk].push(`ALTER TABLE ${q(t.name)} DROP CONSTRAINT IF EXISTS ${qi(k.name)}`)
    f.ph[Ph.DropTable].push(`DROP TABLE IF EXISTS ${q(t.name)}`)
    f.destructive++
    return
  }
  if (!s) return
  const name = q(s.name)
  const late: string[] = []
  if (!t) {
    const cols = s.columns.map((col) => {
      const deferred = col.default !== null && !col.identity && col.generated === null && usesRoutine(col.default)
      if (deferred) f.ph[Ph.Defaults].push(`ALTER TABLE ${name} ALTER COLUMN ${qi(col.name)} SET DEFAULT ${col.default}`)
      return `    ${columnSql(col, !deferred)}`
    })
    f.ph[Ph.Table].push(`CREATE ${s.unlogged ? 'UNLOGGED ' : ''}TABLE ${name} (\n${cols.join(',\n')}\n)${s.partKey ? ` PARTITION BY ${s.partKey}` : ''}`)
    for (const k of sorted(s.constraints)) f.ph[k.type === 'f' ? Ph.AddFk : Ph.AddCons].push(`ALTER TABLE ${name} ADD CONSTRAINT ${qi(k.name)} ${k.def}`)
    for (const i of sorted(s.indexes)) f.ph[Ph.AddCons].push(i.def)
    for (const g of sorted(s.triggers)) f.ph[Ph.Trigger].push(g.def)
    if (s.comment !== null) late.push(commentSql('TABLE', name, s.comment))
    for (const col of s.columns) if (col.comment !== null) late.push(commentSql('COLUMN', `${name}.${qi(col.name)}`, col.comment))
    f.ph[Ph.Late].push(...late)
    return
  }

  if (s.partKey !== t.partKey || s.partitioned !== t.partitioned)
    f.warnings.push(`${s.name}: partitioning differs; recreate the table to change it`)
  if (s.unlogged !== t.unlogged) f.ph[Ph.Table].push(`ALTER TABLE ${name} SET ${s.unlogged ? 'UNLOGGED' : 'LOGGED'}`)

  // Constraints and indexes: anything changed is dropped and added again.
  const sk = byName(s.constraints)
  const tk = byName(t.constraints)
  for (const k of sorted(t.constraints)) {
    const n = sk.get(k.name)
    if (n && n.def === k.def && n.type === k.type) continue
    f.ph[k.type === 'f' ? Ph.DropFk : Ph.DropCons].push(`ALTER TABLE ${name} DROP CONSTRAINT ${qi(k.name)}`)
  }
  for (const k of sorted(s.constraints)) {
    const o = tk.get(k.name)
    if (o && o.def === k.def && o.type === k.type) continue
    f.ph[k.type === 'f' ? Ph.AddFk : Ph.AddCons].push(`ALTER TABLE ${name} ADD CONSTRAINT ${qi(k.name)} ${k.def}`)
  }
  const si = byName(s.indexes)
  const ti = byName(t.indexes)
  for (const i of sorted(t.indexes)) if (si.get(i.name)?.def !== i.def) f.ph[Ph.DropCons].push(`DROP INDEX ${q(i.name)}`)
  for (const i of sorted(s.indexes)) if (ti.get(i.name)?.def !== i.def) f.ph[Ph.AddCons].push(i.def)
  const sg = byName(s.triggers)
  const tg = byName(t.triggers)
  for (const g of sorted(t.triggers)) if (sg.get(g.name)?.def !== g.def) f.ph[Ph.DropTrigger].push(`DROP TRIGGER ${qi(g.name)} ON ${name}`)
  for (const g of sorted(s.triggers)) if (tg.get(g.name)?.def !== g.def) f.ph[Ph.Trigger].push(g.def)

  // Columns: drop, alter in place, add. A renamed column reads as one dropped and one added.
  const sc = byName(s.columns)
  const tc = byName(t.columns)
  const alter = (sql: string): string => `ALTER TABLE ${name} ${sql}`
  for (const col of t.columns) {
    const n = sc.get(col.name)
    if (n && n.generated === col.generated) continue
    f.ph[Ph.Table].push(alter(`DROP COLUMN ${qi(col.name)}`))
    f.destructive++
  }
  for (const col of s.columns) {
    const o = tc.get(col.name)
    const recreate = o && o.generated !== col.generated
    if (!o || recreate) {
      const deferred = col.default !== null && !col.identity && col.generated === null && usesRoutine(col.default)
      f.ph[Ph.Table].push(alter(`ADD COLUMN ${columnSql(col, !deferred)}`))
      if (deferred) f.ph[Ph.Defaults].push(alter(`ALTER COLUMN ${qi(col.name)} SET DEFAULT ${col.default}`))
      if (col.comment !== null) late.push(commentSql('COLUMN', `${name}.${qi(col.name)}`, col.comment))
      continue
    }
    const c = `ALTER COLUMN ${qi(col.name)}`
    const typeChanged = o.type !== col.type
    const defaultChanged = o.default !== col.default
    let defaultDropped = false
    if (o.default !== null && (defaultChanged || typeChanged)) {
      f.ph[Ph.Table].push(alter(`${c} DROP DEFAULT`))
      defaultDropped = true
    }
    if (o.identity && !col.identity) f.ph[Ph.Table].push(alter(`${c} DROP IDENTITY IF EXISTS`))
    if (typeChanged) {
      f.ph[Ph.Table].push(alter(`${c} TYPE ${col.type} USING ${qi(col.name)}::${col.type}`))
      f.destructive++
    }
    if (col.notNull && !o.notNull && !col.identity) f.ph[Ph.Table].push(alter(`${c} SET NOT NULL`))
    if (col.identity && !o.identity) {
      if (!o.notNull) f.ph[Ph.Table].push(alter(`${c} SET NOT NULL`))
      f.ph[Ph.Table].push(alter(`${c} ADD GENERATED ${col.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`))
    } else if (col.identity && o.identity !== col.identity) f.ph[Ph.Table].push(alter(`${c} SET GENERATED ${col.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'}`))
    if (col.default !== null && !col.identity && (defaultChanged || defaultDropped)) f.ph[Ph.Defaults].push(alter(`${c} SET DEFAULT ${col.default}`))
    if (!col.notNull && o.notNull && !col.identity) f.ph[Ph.Table].push(alter(`${c} DROP NOT NULL`))
    if (col.comment !== o.comment) late.push(commentSql('COLUMN', `${name}.${qi(col.name)}`, col.comment))
  }
  if (s.comment !== t.comment) late.unshift(commentSql('TABLE', name, s.comment))
  f.ph[Ph.Late].push(...late)
}

const sameColumns = (a: SnapView['columns'], b: SnapView['columns']): boolean => a.length === b.length && a.every((c, i) => c.name === b[i].name && c.type === b[i].type)

function viewPlan(f: Fragment, c: Ctx, s: SnapView | undefined, t: SnapView | undefined): void {
  const q = (n: string): string => `${qi(c.schema)}.${qi(n)}`
  const what = (v: SnapView): string => (v.materialized ? 'MATERIALIZED VIEW' : 'VIEW')
  if (s && t && s.materialized === t.materialized && s.def === t.def) {
    // Same query; only the indexes or the comment can differ.
    const si = byName(s.indexes)
    const ti = byName(t.indexes)
    for (const i of t.indexes) if (si.get(i.name)?.def !== i.def) f.ph[Ph.DropCons].push(`DROP INDEX ${q(i.name)}`)
    for (const i of s.indexes) if (ti.get(i.name)?.def !== i.def) f.ph[Ph.View].push(i.def)
    if (s.comment !== t.comment) f.ph[Ph.Late].push(commentSql(what(s), q(s.name), s.comment))
    return
  }
  // A plain view whose columns only grow at the end can be replaced in place,
  // which keeps the views built on it; anything else is dropped and created.
  const replace = s && t && !s.materialized && !t.materialized && t.columns.length <= s.columns.length && sameColumns(t.columns, s.columns.slice(0, t.columns.length))
  if (t && !replace) f.ph[Ph.DropView].push(`DROP ${what(t)} IF EXISTS ${q(t.name)}`)
  if (!s) return
  f.ph[Ph.View].push(replace ? viewSql(s, q(s.name)).replace(/^CREATE VIEW/, 'CREATE OR REPLACE VIEW') : viewSql(s, q(s.name)))
  if (!replace) for (const i of sorted(s.indexes)) f.ph[Ph.View].push(i.def)
  if (replace ? s.comment !== t?.comment : s.comment !== null) f.ph[Ph.Late].push(commentSql(what(s), q(s.name), s.comment))
}

function sequencePlan(f: Fragment, c: Ctx, s: SnapSequence | undefined, t: SnapSequence | undefined): void {
  const name = `${qi(c.schema)}.${qi((s ?? t)!.name)}`
  if (!s) {
    f.ph[Ph.DropSeq].push(`DROP SEQUENCE IF EXISTS ${name}`)
    return
  }
  if (!t) f.ph[Ph.Sequence].push(seqSql(s, name))
  else {
    const parts: string[] = []
    if (s.type !== t.type) parts.push(`AS ${s.type}`)
    if (s.increment !== t.increment) parts.push(`INCREMENT BY ${s.increment}`)
    if (s.min !== t.min) parts.push(`MINVALUE ${s.min}`)
    if (s.max !== t.max) parts.push(`MAXVALUE ${s.max}`)
    if (s.cache !== t.cache) parts.push(`CACHE ${s.cache}`)
    if (s.cycle !== t.cycle) parts.push(s.cycle ? 'CYCLE' : 'NO CYCLE')
    if (parts.length) f.ph[Ph.Sequence].push(`ALTER SEQUENCE ${name} ${parts.join(' ')}`)
  }
  if (s.ownedBy !== (t?.ownedBy ?? null)) f.ph[Ph.Late].push(`ALTER SEQUENCE ${name} OWNED BY ${s.ownedBy ?? 'NONE'}`)
}

function enumPlan(f: Fragment, c: Ctx, s: SnapEnum | undefined, t: SnapEnum | undefined): void {
  const name = `${qi(c.schema)}.${qi((s ?? t)!.name)}`
  if (!s) {
    f.ph[Ph.DropType].push(`DROP TYPE IF EXISTS ${name}`)
    return
  }
  if (!t) {
    f.ph[Ph.Type].push(enumSql(s, name))
    if (s.comment !== null) f.ph[Ph.Late].push(commentSql('TYPE', name, s.comment))
    return
  }
  // Values can be added anywhere, but not removed or reordered.
  const have = new Set(t.labels)
  const common = t.labels.filter((l) => s.labels.includes(l))
  if (common.length < t.labels.length || s.labels.filter((l) => have.has(l)).some((l, i) => l !== common[i]))
    f.warnings.push(`${s.name}: enum values can't be removed or reordered; recreate the type to change them`)
  s.labels.forEach((l, i) => {
    if (have.has(l)) return
    const prev = s.labels.slice(0, i).reverse().find((x) => have.has(x))
    const next = s.labels.slice(i + 1).find((x) => have.has(x))
    const where = prev !== undefined ? ` AFTER ${lit(prev)}` : next !== undefined ? ` BEFORE ${lit(next)}` : ''
    f.ph[Ph.Type].push(`ALTER TYPE ${name} ADD VALUE IF NOT EXISTS ${lit(l)}${where}`)
    have.add(l)
  })
  if (s.comment !== t.comment) f.ph[Ph.Late].push(commentSql('TYPE', name, s.comment))
}

function routinePlan(f: Fragment, c: Ctx, s: SnapRoutine | undefined, t: SnapRoutine | undefined): void {
  const sig = (r: SnapRoutine): string => `${qi(c.schema)}.${qi(r.name)}(${r.args})`
  if (!s) {
    if (t) f.ph[Ph.DropRoutine].push(`DROP ${routineWhat(t)} IF EXISTS ${sig(t)}`)
    return
  }
  if (t && t.def === s.def && t.comment === s.comment) return
  if (t && t.def !== s.def) {
    // OR REPLACE can't change the result type, the kind or the parameter names.
    if (t.result !== s.result || t.procedure !== s.procedure || t.argsFull !== s.argsFull) f.ph[Ph.Routine].push(`DROP ${routineWhat(t)} ${sig(t)}`)
  }
  if (!t || t.def !== s.def) f.ph[Ph.Routine].push(s.def.replace(/\s*;?\s*$/, ''))
  if (s.comment !== (t?.comment ?? null)) f.ph[Ph.Late].push(commentSql(routineWhat(s), sig(s), s.comment))
}

function plan(o: Obj, c: Ctx): Fragment {
  const f = fragment()
  switch (o.kind) {
    case 'table':
      tablePlan(f, c, o.src as SnapTable | undefined, o.tgt as SnapTable | undefined)
      break
    case 'view':
    case 'matview':
      viewPlan(f, c, o.src as SnapView | undefined, o.tgt as SnapView | undefined)
      break
    case 'sequence':
      sequencePlan(f, c, o.src as SnapSequence | undefined, o.tgt as SnapSequence | undefined)
      break
    case 'enum':
      enumPlan(f, c, o.src as SnapEnum | undefined, o.tgt as SnapEnum | undefined)
      break
    default:
      routinePlan(f, c, o.src as SnapRoutine | undefined, o.tgt as SnapRoutine | undefined)
  }
  return f
}

const KIND_ORDER: DiffKind[] = ['enum', 'sequence', 'table', 'view', 'matview', 'function', 'procedure']

function compared(src: SchemaSnapshot, tgt: SchemaSnapshot): Array<{ o: Obj; f: Fragment }> {
  const c: Ctx = { schema: tgt.schema, routines: [...new Set(src.routines.map((r) => r.name))] }
  return objects(src, tgt)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.order - b.order || a.name.localeCompare(b.name))
    .map((o) => ({ o, f: plan(o, c) }))
    .filter(({ f }) => f.warnings.length || f.ph.some((p) => p.length))
}

/** Objects that differ, in a stable order (types, sequences, tables, views, routines). */
export function diffSchemas(src: SchemaSnapshot, tgt: SchemaSnapshot): DiffItem[] {
  return compared(src, tgt).map(({ o, f }) => ({
    key: o.key,
    kind: o.kind,
    name: o.name,
    status: !o.tgt ? 'added' : !o.src ? 'removed' : 'changed',
    source: render(o, 'src'),
    target: render(o, 'tgt'),
    stmts: f.ph.reduce((n, p) => n + p.length, 0),
    destructive: f.destructive > 0,
    warnings: f.warnings
  }))
}

/** DDL that makes the target schema match the source for the picked objects. */
export function buildMigration(src: SchemaSnapshot, tgt: SchemaSnapshot, keys: Iterable<string>): Migration {
  const pick = new Set(keys)
  const parts = compared(src, tgt).filter(({ o }) => pick.has(o.key))
  const stmts: string[] = []
  for (let p = 0; p < Ph.Count; p++) {
    // Views are dropped newest first, so a view goes before the ones it reads.
    const list = p === Ph.DropView ? [...parts].reverse() : parts
    for (const { f } of list) stmts.push(...f.ph[p])
  }
  return {
    stmts,
    warnings: parts.flatMap(({ f }) => f.warnings),
    destructive: parts.reduce((n, { f }) => n + f.destructive, 0)
  }
}

/** The plan to run against the target: one transaction, target schema first on the search path. */
export const migrationPlan = (m: Migration, schema: string): DdlPlan => ({ stmts: m.stmts, atomic: true, searchPath: schema })

/** As a script to save or open in the console. */
export function migrationScript(m: Migration, schema: string): string {
  const head = [
    `-- Migration for schema ${schema}`,
    ...m.warnings.map((w) => `-- WARNING: ${w}`),
    'BEGIN;',
    `SET LOCAL search_path = ${qi(schema)};`,
    'SET LOCAL check_function_bodies = off;'
  ]
  return `${head.join('\n')}\n\n${m.stmts.map((s) => `${s};`).join('\n\n')}\n\nCOMMIT;\n`
}
