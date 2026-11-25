import { describe, expect, it } from 'vitest'
import { buildEdits, editCount, editMapping, previewSql, type EditTarget, type PendingEdits } from './edit'
import type { QueryColumn } from './types'

const target: EditTarget = {
  table: 100,
  schema: 'public',
  name: 'users',
  editable: true,
  pk: [1],
  columns: [
    { attnum: 1, name: 'id', type: 'integer', readOnly: false },
    { attnum: 2, name: 'name', type: 'text', readOnly: false },
    { attnum: 3, name: 'full', type: 'text', readOnly: true }
  ]
}
const columns: QueryColumn[] = [
  { name: 'id', type: 'integer', table: 100, attnum: 1 },
  { name: 'name', type: 'text', table: 100, attnum: 2 },
  { name: 'full', type: 'text', table: 100, attnum: 3 },
  { name: 'n', type: 'integer' }
]
const rows = [
  [1, 'a', 'A', 5],
  [2, "o'k", 'O', 6]
]
const edits = (p: Partial<PendingEdits>): PendingEdits => ({ updates: {}, deletes: [], inserts: [], ...p })

describe('editMapping', () => {
  it('maps the table columns and skips the rest', () => {
    expect([...editMapping(target, columns)!.keys()]).toEqual([0, 1, 2])
  })
  it('needs every primary key column', () => {
    expect(editMapping(target, columns.slice(1))).toBeNull()
  })
  it('is null for a non-editable target', () => {
    expect(editMapping({ ...target, editable: false, reason: 'nopk' }, columns)).toBeNull()
  })
  it('maps a repeated column once', () => {
    expect([...editMapping(target, [...columns, columns[1]])!.keys()]).toEqual([0, 1, 2])
  })
})

describe('buildEdits', () => {
  it('orders deletes, updates, inserts and keys rows by their original pk', () => {
    const plan = buildEdits(
      target,
      columns,
      rows,
      edits({ updates: { 1: { 1: 'b', 0: 9 } }, deletes: [0], inserts: [{ 1: 'new' }] })
    )
    expect(plan.stmts.map((s) => s.text)).toEqual([
      'DELETE FROM public.users WHERE id = $1',
      'UPDATE public.users SET id = $1, name = $2 WHERE id = $3 RETURNING id, name, "full"',
      'INSERT INTO public.users (name) VALUES ($1) RETURNING id, name, "full"'
    ])
    expect(plan.stmts.map((s) => s.values)).toEqual([['1'], ['9', 'b', '2'], ['new']])
    expect(plan.kinds).toEqual([
      { op: 'delete', index: 0 },
      { op: 'update', index: 1 },
      { op: 'insert', index: 0 }
    ])
    expect(plan.returning).toEqual([0, 1, 2])
  })
  it('skips updates to deleted rows and read-only columns', () => {
    const plan = buildEdits(target, columns, rows, edits({ updates: { 0: { 1: 'x' }, 1: { 2: 'y', 3: 7 } }, deletes: [0] }))
    expect(plan.stmts.map((s) => s.text)).toEqual(['DELETE FROM public.users WHERE id = $1'])
  })
  it('inserts default values when nothing was set, and nulls as null', () => {
    const plan = buildEdits(target, columns, rows, edits({ inserts: [{}, { 1: null }] }))
    expect(plan.stmts[0].text).toBe('INSERT INTO public.users DEFAULT VALUES RETURNING id, name, "full"')
    expect(plan.stmts[1].values).toEqual([null])
  })
  it('matches a null key with IS NULL', () => {
    const plan = buildEdits(target, columns, [[null, 'a', 'A', 1]], edits({ deletes: [0] }))
    expect(plan.stmts[0]).toEqual({ text: 'DELETE FROM public.users WHERE id IS NULL', values: [] })
  })
  it('refuses a result it cannot edit', () => {
    expect(() => buildEdits(target, columns.slice(1), rows, edits({ deletes: [0] }))).toThrow()
  })
})

describe('editCount and previewSql', () => {
  it('counts a deleted row once', () => {
    expect(editCount(edits({ updates: { 0: { 1: 'x' }, 1: { 1: 'y' } }, deletes: [0], inserts: [{}] }))).toBe(3)
  })
  it('inlines quoted literals', () => {
    const plan = buildEdits(target, columns, rows, edits({ updates: { 1: { 1: null } }, deletes: [1] }))
    expect(previewSql(plan.stmts)).toBe('DELETE FROM public.users WHERE id = \'2\';')
    const up = buildEdits(target, columns, rows, edits({ updates: { 0: { 1: "it's", 0: null } } }))
    expect(previewSql(up.stmts)).toBe(
      'UPDATE public.users SET id = NULL, name = \'it\'\'s\' WHERE id = \'1\' RETURNING id, name, "full";'
    )
  })
})

describe('buildEdits for MySQL and SQLite', () => {
  const p = edits({ updates: { 1: { 1: 'b', 0: 9 } }, deletes: [0], inserts: [{ 1: 'new' }, {}] })
  it('MySQL uses ? and reads rows back by the new key', () => {
    const plan = buildEdits({ ...target, schema: 'shop' }, columns, rows, p, 'mysql')
    expect(plan.stmts.map((s) => s.text)).toEqual([
      'DELETE FROM shop.users WHERE id = ?',
      'UPDATE shop.users SET id = ?, name = ? WHERE id = ?',
      'INSERT INTO shop.users (name) VALUES (?)',
      'INSERT INTO shop.users () VALUES ()'
    ])
    expect(plan.stmts[0].fetch).toBeUndefined()
    expect(plan.stmts[1].fetch).toEqual({ text: 'SELECT id, name, `full` FROM shop.users WHERE id = ?', values: ['9'] })
    expect(plan.stmts[2].fetch).toEqual({ text: 'SELECT id, name, `full` FROM shop.users WHERE id = ?', values: [], insertId: true })
  })
  it('MySQL inserts with the key given read back by it', () => {
    const plan = buildEdits(target, columns, rows, edits({ inserts: [{ 0: 7, 1: 'x' }] }), 'mysql')
    expect(plan.stmts[0].fetch?.values).toEqual(['7'])
  })
  it('SQLite keeps RETURNING with ? placeholders', () => {
    const plan = buildEdits({ ...target, schema: 'main' }, columns, rows, p, 'sqlite')
    expect(plan.stmts.map((s) => s.text)).toEqual([
      'DELETE FROM main.users WHERE id = ?',
      'UPDATE main.users SET id = ?, name = ? WHERE id = ? RETURNING id, name, "full"',
      'INSERT INTO main.users (name) VALUES (?) RETURNING id, name, "full"',
      'INSERT INTO main.users DEFAULT VALUES RETURNING id, name, "full"'
    ])
  })
  it('previews ? placeholders, skipping quoted text', () => {
    expect(previewSql([{ text: "UPDATE `a?` SET b = ?, c = '?' WHERE d = ?", values: ["o'k", null] }], 'mysql')).toBe(
      "UPDATE `a?` SET b = 'o''k', c = '?' WHERE d = NULL;"
    )
  })
})
