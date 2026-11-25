import { describe, expect, it } from 'vitest'
import { searchCondition, searchSql } from './dataSearchSql'

const base = { term: 'ab', mode: 'contains' as const, caseSensitive: false }

describe('searchCondition', () => {
  it('ilike contains, one clause per column', () => {
    expect(searchCondition(['name', 'Email'], base)).toBe(`name::text ilike '%ab%'\n   or "Email"::text ilike '%ab%'`)
  })
  it('escapes like wildcards and quotes', () => {
    expect(searchCondition(['c'], { ...base, term: `50%_o'k\\` })).toBe(`c::text ilike '%50\\%\\_o''k\\\\%'`)
  })
  it('case-sensitive contains uses like', () => {
    expect(searchCondition(['c'], { ...base, caseSensitive: true })).toBe(`c::text like '%ab%'`)
  })
  it('exact match', () => {
    expect(searchCondition(['c'], { ...base, mode: 'exact' })).toBe(`lower(c::text) = lower('ab')`)
    expect(searchCondition(['c'], { ...base, mode: 'exact', caseSensitive: true })).toBe(`c::text = 'ab'`)
  })
  it('regex keeps the pattern as is', () => {
    expect(searchCondition(['c'], { ...base, mode: 'regex', term: '^a.%' })).toBe(`c::text ~* '^a.%'`)
    expect(searchCondition(['c'], { ...base, mode: 'regex', caseSensitive: true, term: 'x' })).toBe(`c::text ~ 'x'`)
  })
})

describe('searchSql', () => {
  it('quotes the table', () => {
    expect(searchSql({ schema: 'Sales', table: 'order', kind: 'table', columns: ['a'] }, base)).toBe(
      `select *\n  from "Sales"."order"\n where a::text ilike '%ab%'`
    )
  })
})
