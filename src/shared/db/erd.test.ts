import { describe, expect, it } from 'vitest'
import { bounds, edgePath, erdMermaid, layoutErd, nodeHeight, shownColumns, type ErdModel, type ErdTable } from './erd'

const col = (name: string, o: Partial<{ type: string; notNull: boolean; pk: boolean; fk: boolean }> = {}) => ({
  name,
  type: o.type ?? 'integer',
  notNull: o.notNull ?? false,
  pk: o.pk ?? false,
  fk: o.fk ?? false
})
const table = (key: string, columns = [col('id', { pk: true, notNull: true })]): ErdTable => ({ key, schema: 'public', name: key, kind: 'table', columns })
const size = (t: ErdTable) => ({ w: 120, h: nodeHeight(t.columns.length) })
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('layoutErd', () => {
  it('puts a referenced table left of the tables pointing at it', () => {
    const model: ErdModel = {
      schema: 'public',
      tables: [table('orders'), table('users'), table('items')],
      refs: [
        { name: 'o_u', from: 'orders', fromCols: ['user_id'], to: 'users', toCols: ['id'] },
        { name: 'i_o', from: 'items', fromCols: ['order_id'], to: 'orders', toCols: ['id'] }
      ]
    }
    const b = layoutErd(model, size)
    expect(b.users.x).toBeLessThan(b.orders.x)
    expect(b.orders.x).toBeLessThan(b.items.x)
  })

  it('survives cycles and self references without overlapping boxes', () => {
    const model: ErdModel = {
      schema: 'public',
      tables: [table('a'), table('b'), table('c'), table('lonely'), table('alone')],
      refs: [
        { name: '1', from: 'a', fromCols: ['b'], to: 'b', toCols: ['id'] },
        { name: '2', from: 'b', fromCols: ['c'], to: 'c', toCols: ['id'] },
        { name: '3', from: 'c', fromCols: ['a'], to: 'a', toCols: ['id'] },
        { name: '4', from: 'a', fromCols: ['parent'], to: 'a', toCols: ['id'] }
      ]
    }
    const b = layoutErd(model, size)
    const all = Object.values(b)
    expect(all).toHaveLength(5)
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false)
  })

  it('handles an empty schema', () => {
    expect(layoutErd({ schema: 'x', tables: [], refs: [] }, size)).toEqual({})
    expect(bounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('edgePath', () => {
  it('leaves each box on its facing side', () => {
    const left = { x: 0, y: 0, w: 100, h: 80 }
    const right = { x: 200, y: 0, w: 100, h: 80 }
    const e = edgePath(right, 1, left, 0)
    expect(e.x1).toBe(200)
    expect(e.x2).toBe(100)
    expect(e.d.startsWith('M200,')).toBe(true)
  })
})

describe('shownColumns', () => {
  it('keeps only key columns when asked', () => {
    const t = table('t', [col('id', { pk: true }), col('name'), col('u', { fk: true })])
    expect(shownColumns(t, true).map((c) => c.name)).toEqual(['id', 'u'])
    expect(shownColumns(t, false)).toHaveLength(3)
  })
})

describe('erdMermaid', () => {
  it('writes entities and relationships', () => {
    const model: ErdModel = {
      schema: 'public',
      tables: [
        table('users', [col('id', { pk: true, notNull: true }), col('tags', { type: 'text[]' })]),
        table('orders', [col('id', { pk: true }), col('user_id', { fk: true, notNull: true }), col('note', { type: 'character varying(20)' })]),
        { ...table('other.x y'), external: true }
      ],
      refs: [
        { name: 'orders_user_fk', from: 'orders', fromCols: ['user_id'], to: 'users', toCols: ['id'] },
        { name: 'o_x', from: 'orders', fromCols: ['note'], to: 'other.x y', toCols: ['id'] }
      ]
    }
    const m = erdMermaid(model)
    expect(m).toContain('erDiagram')
    expect(m).toContain('text_array tags')
    expect(m).toContain('character_varying_20 note')
    expect(m).toContain('integer user_id FK')
    expect(m).toContain('users ||--o{ orders : "orders_user_fk"')
    expect(m).toContain('"other.x y" |o--o{ orders : "o_x"')
  })
})
