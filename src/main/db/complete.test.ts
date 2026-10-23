import { describe, expect, it } from 'vitest'
import { ident, statementAround, suggest, tableRefs, type CompletionMeta } from './complete'

const meta: CompletionMeta = {
  schemas: ['public', 'sales'],
  searchPath: ['public'],
  tables: [
    { schema: 'public', name: 'users', kind: 'r', columns: [{ name: 'id', type: 'integer' }, { name: 'email', type: 'text' }] },
    { schema: 'public', name: 'orders', kind: 'r', columns: [{ name: 'id', type: 'integer' }, { name: 'user_id', type: 'integer' }, { name: 'Total', type: 'numeric' }] },
    { schema: 'sales', name: 'invoices', kind: 'r', columns: [{ name: 'no', type: 'text' }] },
    { schema: 'public', name: 'v_active', kind: 'v', columns: [{ name: 'id', type: 'integer' }] }
  ],
  functions: ['public.my_fn', 'sales.tax'],
  truncated: false
}

const at = (sql: string): ReturnType<typeof suggest> => {
  const i = sql.indexOf('|')
  return suggest(meta, sql.replace('|', ''), i)
}
const labels = (sql: string): string[] => at(sql).map((s) => s.label)

describe('tableRefs', () => {
  it('reads tables, schemas and aliases', () => {
    expect(tableRefs('select * from public.users u join orders as o on o.user_id = u.id')).toEqual([
      { schema: 'public', name: 'users', alias: 'u' },
      { schema: undefined, name: 'orders', alias: 'o' }
    ])
    expect(tableRefs('select * from users u, sales.invoices')).toEqual([
      { schema: undefined, name: 'users', alias: 'u' },
      { schema: 'sales', name: 'invoices', alias: undefined }
    ])
  })
  it('skips keywords and functions', () => {
    expect(tableRefs('select * from users where id in (select 1) order by 1')).toEqual([{ schema: undefined, name: 'users', alias: undefined }])
    expect(tableRefs('select * from generate_series(1, 3) g')).toEqual([])
  })
  it('keeps quoted names verbatim', () => {
    expect(tableRefs('update "My Table" t set x = 1')).toEqual([{ schema: undefined, name: 'My Table', alias: 't' }])
  })
})

describe('suggest', () => {
  it('alias. gives that table\'s columns', () => {
    expect(labels('select o.| from orders o')).toEqual(['id', 'user_id', 'Total'])
    expect(at('select o.| from orders o')[2].insert).toBe('"Total"')
  })
  it('table. and schema.table. give columns', () => {
    expect(labels('select users.| from users')).toEqual(['id', 'email'])
    expect(labels('select sales.invoices.| from sales.invoices')).toEqual(['no'])
  })
  it('schema. gives its tables and functions', () => {
    expect(labels('select * from sales.|')).toEqual(['invoices', 'tax'])
  })
  it('after FROM / JOIN gives tables, qualified outside the search path', () => {
    const l = labels('select * from |')
    expect(l).toContain('users')
    expect(l).toContain('sales.invoices')
    expect(l).toContain('sales')
    expect(labels('select * from users u join o|')).toContain('orders')
    expect(labels('select * from users, |')).toContain('orders')
  })
  it('elsewhere puts the statement\'s columns first', () => {
    const s = at('select | from users')
    expect(s[0]).toMatchObject({ label: 'id', kind: 'column' })
    expect(s.map((x) => x.label)).toContain('email')
    expect(s.map((x) => x.label)).toContain('SELECT')
    expect(s.map((x) => x.label)).toContain('count')
    expect(s.map((x) => x.label)).toContain('my_fn')
  })
})

describe('helpers', () => {
  it('quotes identifiers that need it', () => {
    expect(ident('users')).toBe('users')
    expect(ident('Users')).toBe('"Users"')
    expect(ident('order')).toBe('"order"')
    expect(ident('a"b')).toBe('"a""b"')
  })
  it('finds the statement around the cursor', () => {
    const text = 'select 1;\nselect * from users;\n'
    expect(statementAround(text, 15, 'postgres')).toEqual({ stmt: '\nselect * from users', at: 6 })
    expect(statementAround(text, text.length, 'postgres').stmt).toBe('\n')
  })
})
