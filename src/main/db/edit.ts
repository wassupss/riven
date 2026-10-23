import { literal, quoteIdent } from './sqlText'
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

export function buildEdits(target: EditTarget, columns: QueryColumn[], rows: Cell[][], p: PendingEdits): EditPlan {
  const map = editMapping(target, columns)
  if (!map) throw new Error('This result is not editable')
  const q = (s: string): string => quoteIdent('postgres', s)
  const table = `${q(target.schema)}.${q(target.name)}`
  const returning = [...map.keys()]
  const ret = ` RETURNING ${returning.map((i) => q(map.get(i)!.name)).join(', ')}`
  const pkCols = target.pk.map((a) => [...map.entries()].find(([, c]) => c.attnum === a)!)

  const stmts: EditStatement[] = []
  const kinds: EditPlan['kinds'] = []
  const where = (row: Cell[], values: Array<string | null>): string =>
    pkCols
      .map(([i, c]) => {
        if (row[i] === null) return `${q(c.name)} IS NULL`
        values.push(param(row[i]))
        return `${q(c.name)} = $${values.length}`
      })
      .join(' AND ')

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
        return `${q(map.get(ci)!.name)} = $${values.length}`
      })
      .join(', ')
    stmts.push({ text: `UPDATE ${table} SET ${set} WHERE ${where(rows[key], values)}${ret}`, values })
    kinds.push({ op: 'update', index: key })
  }
  p.inserts.forEach((ins, n) => {
    const cols = Object.entries(ins)
      .map(([ci, v]) => [Number(ci), v] as const)
      .filter(([ci]) => map.has(ci) && !map.get(ci)!.readOnly)
    const values = cols.map(([, v]) => param(v))
    const text = cols.length
      ? `INSERT INTO ${table} (${cols.map(([ci]) => q(map.get(ci)!.name)).join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})${ret}`
      : `INSERT INTO ${table} DEFAULT VALUES${ret}`
    stmts.push({ text, values })
    kinds.push({ op: 'insert', index: n })
  })
  return { stmts, kinds, returning }
}

/** The statements with their parameters inlined, for showing before applying. */
export function previewSql(stmts: EditStatement[]): string {
  return stmts
    .map((s) => s.text.replace(/\$(\d+)/g, (_, n: string) => literal('postgres', s.values[Number(n) - 1] ?? null)) + ';')
    .join('\n')
}
