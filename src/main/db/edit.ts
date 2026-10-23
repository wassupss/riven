import { literal, quoteIdent, type DbKind } from './sqlText'
import type { QueryColumn } from './types'

// Turning grid edits into statements. Shared by main (types) and the renderer
// (building and previewing); the statements run through db:apply.

export type Cell = string | number | boolean | null

/** The table a result's columns come from, as far as editing needs it. */
export interface EditTarget {
  table: number
  schema: string
  name: string
  /** Table kind is plain or partitioned and it has a primary key. */
  editable: boolean
  /** Why not, when not editable. */
  reason?: 'kind' | 'nopk'
  pk: number[]
  columns: Array<{ attnum: number; name: string; type: string; readOnly: boolean }>
}

/** Pending grid changes, by index into the result's rows and columns. */
export interface PendingEdits {
  updates: Record<number, Record<number, Cell>>
  deletes: number[]
  inserts: Array<Record<number, Cell>>
}

export const NO_EDITS: PendingEdits = { updates: {}, deletes: [], inserts: [] }

export const editCount = (p: PendingEdits): number =>
  Object.keys(p.updates).filter((r) => !p.deletes.includes(Number(r))).length + p.deletes.length + p.inserts.length

export interface EditStatement {
  text: string
  values: Array<string | null>
  /**
   * MySQL has no RETURNING: the row is read back with this after the write.
   * `insertId` appends the statement's auto-increment id to the values.
   */
  fetch?: { text: string; values: Array<string | null>; insertId?: boolean }
}

export interface EditPlan {
  /** In order: deletes, updates, inserts. */
  stmts: EditStatement[]
  /** What each statement is, to map RETURNING rows back. */
  kinds: Array<{ op: 'delete' | 'update' | 'insert'; index: number }>
  /** Result column indexes the RETURNING list fills, in order. */
  returning: number[]
}

/**
 * Which result columns map to which table columns. Null when the result can't
 * be edited: columns from another table, or a primary key column missing.
 */
export function editMapping(target: EditTarget, columns: QueryColumn[]): Map<number, EditTarget['columns'][number]> | null {
  if (!target.editable) return null
  const byAttnum = new Map(target.columns.map((c) => [c.attnum, c]))
  const map = new Map<number, EditTarget['columns'][number]>()
  const seen = new Set<number>()
  columns.forEach((c, i) => {
    if (c.table !== target.table || c.attnum === undefined) return
    const tc = byAttnum.get(c.attnum)
    // The same column twice (select a, a) is shown but only edited once.
    if (!tc || seen.has(c.attnum)) return
    seen.add(c.attnum)
    map.set(i, tc)
  })
  if (!target.pk.every((a) => seen.has(a))) return null
  return map
}

const param = (v: Cell): string | null => (v === null ? null : String(v))

// Placeholders: pg numbers them, MySQL and SQLite take them in order.
const placeholder = (kind: DbKind, n: number): string => (kind === 'postgres' ? `$${n}` : '?')

export function buildEdits(target: EditTarget, columns: QueryColumn[], rows: Cell[][], p: PendingEdits, kind: DbKind = 'postgres'): EditPlan {
  const map = editMapping(target, columns)
  if (!map) throw new Error('This result is not editable')
  const q = (s: string): string => quoteIdent(kind, s)
  const table = `${q(target.schema)}.${q(target.name)}`
  const returning = [...map.keys()]
  const retCols = returning.map((i) => q(map.get(i)!.name)).join(', ')
  const fetchBack = kind === 'mysql'
  const ret = fetchBack ? '' : ` RETURNING ${retCols}`
  const pkCols = target.pk.map((a) => [...map.entries()].find(([, c]) => c.attnum === a)!)
  const ph = (values: unknown[]): string => placeholder(kind, values.length)

  const stmts: EditStatement[] = []
  const kinds: EditPlan['kinds'] = []
  const where = (row: Cell[], values: Array<string | null>): string =>
    pkCols
      .map(([i, c]) => {
        if (row[i] === null) return `${q(c.name)} IS NULL`
        values.push(param(row[i]))
        return `${q(c.name)} = ${ph(values)}`
      })
      .join(' AND ')
  const select = (row: Cell[]): NonNullable<EditStatement['fetch']> => {
    const values: Array<string | null> = []
    return { text: `SELECT ${retCols} FROM ${table} WHERE ${where(row, values)}`, values }
  }

  for (const r of [...p.deletes].sort((a, b) => a - b)) {
    const values: Array<string | null> = []
    stmts.push({ text: `DELETE FROM ${table} WHERE ${where(rows[r], values)}`, values })
    kinds.push({ op: 'delete', index: r })
  }
  for (const key of Object.keys(p.updates)
    .map(Number)
    .sort((a, b) => a - b)) {
    if (p.deletes.includes(key)) continue
    const sets = Object.entries(p.updates[key])
      .map(([ci, v]) => [Number(ci), v] as const)
      .filter(([ci]) => map.has(ci) && !map.get(ci)!.readOnly)
    if (!sets.length) continue
    const values: Array<string | null> = []
    const set = sets
      .map(([ci, v]) => {
        values.push(param(v))
        return `${q(map.get(ci)!.name)} = ${ph(values)}`
      })
      .join(', ')
    const st: EditStatement = { text: `UPDATE ${table} SET ${set} WHERE ${where(rows[key], values)}${ret}`, values }
    // Read back by the key as it is after the update.
    if (fetchBack) st.fetch = select(rows[key].map((v, ci) => (sets.some(([c]) => c === ci) ? p.updates[key][ci] : v)))
    stmts.push(st)
    kinds.push({ op: 'update', index: key })
  }
  p.inserts.forEach((ins, n) => {
    const cols = Object.entries(ins)
      .map(([ci, v]) => [Number(ci), v] as const)
      .filter(([ci]) => map.has(ci) && !map.get(ci)!.readOnly)
    const values = cols.map(([, v]) => param(v))
    const empty = kind === 'mysql' ? ' () VALUES ()' : ' DEFAULT VALUES'
    const text = cols.length
      ? `INSERT INTO ${table} (${cols.map(([ci]) => q(map.get(ci)!.name)).join(', ')}) VALUES (${values.map((_, i) => placeholder(kind, i + 1)).join(', ')})${ret}`
      : `INSERT INTO ${table}${empty}${ret}`
    const st: EditStatement = { text, values }
    if (fetchBack) {
      const given = pkCols.every(([i]) => cols.some(([c]) => c === i))
      if (given) st.fetch = select(columns.map((_, i) => (i in ins ? ins[i] : null)))
      else if (pkCols.length === 1)
        st.fetch = { text: `SELECT ${retCols} FROM ${table} WHERE ${q(pkCols[0][1].name)} = ?`, values: [], insertId: true }
    }
    stmts.push(st)
    kinds.push({ op: 'insert', index: n })
  })
  return { stmts, kinds, returning }
}

/** Placeholders of a statement in order, skipping quoted text ($n for pg, ? otherwise). */
function inline(text: string, values: Array<string | null>, kind: DbKind): string {
  if (kind === 'postgres') return text.replace(/\$(\d+)/g, (_, n: string) => literal(kind, values[Number(n) - 1] ?? null))
  let out = ''
  let n = 0
  let quote: string | null = null
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      out += ch
    } else if (ch === '"' || ch === '`' || ch === "'") {
      quote = ch
      out += ch
    } else if (ch === '?') out += literal(kind, values[n++] ?? null)
    else out += ch
  }
  return out
}

/** The statements with their parameters inlined, for showing before applying. */
export function previewSql(stmts: EditStatement[], kind: DbKind = 'postgres'): string {
  return stmts.map((s) => inline(s.text, s.values, kind) + ';').join('\n')
}
