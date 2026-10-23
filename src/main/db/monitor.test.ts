import { describe, expect, it } from 'vitest'
import {
  blocking,
  databaseSettable,
  deadPct,
  fmtAge,
  fmtBytes,
  hitRatio,
  maintenanceSql,
  reindexIndexSql,
  settingSql,
  unusedIndex,
  type IndexStat
} from './monitor'

const T = [{ schema: 'public', name: 'users' }, { schema: 'Sales', name: 'order items' }]

describe('maintenanceSql', () => {
  it('emits one non-atomic statement per table', () => {
    const p = maintenanceSql('vacuum', T)
    expect(p.atomic).toBe(false)
    expect(p.stmts).toEqual(['VACUUM public.users', 'VACUUM "Sales"."order items"'])
  })
  it('builds each kind with options', () => {
    const one = T.slice(0, 1)
    expect(maintenanceSql('vacuum', one, { verbose: true }).stmts[0]).toBe('VACUUM (VERBOSE) public.users')
    expect(maintenanceSql('vacuumAnalyze', one, { verbose: true }).stmts[0]).toBe('VACUUM (VERBOSE, ANALYZE) public.users')
    expect(maintenanceSql('vacuumFull', one).stmts[0]).toBe('VACUUM (FULL) public.users')
    expect(maintenanceSql('analyze', one, { verbose: true }).stmts[0]).toBe('ANALYZE VERBOSE public.users')
    expect(maintenanceSql('reindex', one, { concurrently: true }).stmts[0]).toBe('REINDEX TABLE CONCURRENTLY public.users')
    expect(reindexIndexSql('public', 'users_email_idx', false).stmts).toEqual(['REINDEX INDEX public.users_email_idx'])
  })
  it('flags the ones that take an exclusive lock', () => {
    expect(blocking('vacuumFull', false)).toBe(true)
    expect(blocking('reindex', false)).toBe(true)
    expect(blocking('reindex', true)).toBe(false)
    expect(blocking('vacuum', false)).toBe(false)
  })
})

describe('settingSql', () => {
  it('sets and resets system-wide', () => {
    expect(settingSql('system', 'work_mem', '64MB').stmts).toEqual(["ALTER SYSTEM SET work_mem = '64MB'"])
    expect(settingSql('system', 'work_mem', null).stmts).toEqual(['ALTER SYSTEM RESET work_mem'])
    expect(settingSql('system', 'work_mem', null).atomic).toBe(false)
  })
  it('quotes dotted names part by part and escapes values', () => {
    expect(settingSql('system', 'pg_stat_statements.max', "1'0").stmts[0]).toBe(
      "ALTER SYSTEM SET pg_stat_statements.max = '1''0'"
    )
  })
  it('targets a database', () => {
    expect(settingSql('database', 'search_path', 'app, public', 'My DB').stmts[0]).toBe(
      `ALTER DATABASE "My DB" SET search_path = 'app, public'`
    )
    expect(databaseSettable({ context: 'user' })).toBe(true)
    expect(databaseSettable({ context: 'sighup' })).toBe(false)
  })
})

describe('formatting and health', () => {
  it('formats bytes', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(1023)).toBe('1023 B')
    expect(fmtBytes(1536)).toBe('1.5 kB')
    expect(fmtBytes(200 * 1024 * 1024)).toBe('200 MB')
  })
  it('formats ages', () => {
    expect(fmtAge(null)).toBe('')
    expect(fmtAge(45.7)).toBe('45s')
    expect(fmtAge(723)).toBe('12m 3s')
    expect(fmtAge(5 * 3600 + 120)).toBe('5h 2m')
    expect(fmtAge(3 * 86400 + 4 * 3600)).toBe('3d 4h')
  })
  it('computes ratios', () => {
    expect(deadPct({ live: 0, dead: 0 })).toBe(0)
    expect(deadPct({ live: 75, dead: 25 })).toBe(25)
    expect(hitRatio({ blksHit: 0, blksRead: 0 })).toBeNull()
    expect(hitRatio({ blksHit: 99, blksRead: 1 })).toBe(99)
  })
  it('only calls plain never-scanned indexes unused', () => {
    const i: IndexStat = { schema: 'p', table: 't', name: 'i', size: 1, scans: 0, tupRead: 0, tupFetch: 0, unique: false, primary: false, valid: true, def: '' }
    expect(unusedIndex(i)).toBe(true)
    expect(unusedIndex({ ...i, unique: true })).toBe(false)
    expect(unusedIndex({ ...i, scans: 3 })).toBe(false)
  })
})
