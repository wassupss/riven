import { describe, expect, it } from 'vitest'
import { literal, pagedQuery, quoteIdent, readOnlyViolation, splitStatements, statements, unsafeStatement } from './sqlText'

describe('splitStatements', () => {
  it('splits and quotes', () => {
    const t = "select ';' as a; -- x;\nselect $$a;b$$; select \"x;y\""
    expect(statements(t, 'postgres')).toEqual(["select ';' as a", '-- x;\nselect $$a;b$$', 'select "x;y"'])
    expect(splitStatements("select 'a\\';b'; select 2", 'mysql')).toHaveLength(2)
    expect(splitStatements('GET a\n# c\n\nSET b 1', 'redis')).toHaveLength(2)
  })

  it('follows server comment rules', () => {
    const n = (t: string, k: 'postgres' | 'mysql'): number => splitStatements(t, k).length
    expect(n('select 1 --1; COMMIT; DELETE FROM t', 'mysql')).toBe(3)
    expect(n('select 1 -- x; delete', 'mysql')).toBe(1)
    expect(n('/*! COMMIT; DELETE FROM t; */ select 1', 'mysql')).toBe(3)
    expect(n('/* c; */ select 1', 'mysql')).toBe(1)
    expect(n('/* a /* b */ ; */ select 1', 'postgres')).toBe(1)
    expect(n("select E'\\'; x'; select 2", 'postgres')).toBe(2)
    expect(n("select '\\'; select 2", 'postgres')).toBe(2)
  })
})

describe('identifiers', () => {
  it('quotes when needed', () => {
    expect(quoteIdent('postgres', 'User')).toBe('"User"')
    expect(quoteIdent('mysql', 'my col')).toBe('`my col`')
    expect(quoteIdent('postgres', 'user')).toBe('"user"')
    expect(quoteIdent('mysql', 'order')).toBe('`order`')
    expect(quoteIdent('postgres', 'users')).toBe('users')
    expect(literal('mysql', "a\\'b")).toBe("'a\\\\''b'")
    expect(literal('postgres', null)).toBe('NULL')
  })
})

describe('readOnlyViolation', () => {
  it('blocks known bypasses', () => {
    const bad = (s: string, k: 'postgres' | 'mysql'): boolean => readOnlyViolation(s, k, true) !== null
    expect(bad('select 1 --1; COMMIT; DELETE FROM t WHERE id=1', 'mysql')).toBe(true)
    expect(bad('/*! COMMIT; DELETE FROM t; */ select 1', 'mysql')).toBe(true)
    expect(bad('select /*!50000 1 */', 'mysql')).toBe(true)
    expect(bad("select * from t into outfile '/tmp/x'", 'mysql')).toBe(true)
    expect(bad("select load_file('/etc/passwd')", 'mysql')).toBe(true)
    expect(bad('select 1; delete from t', 'postgres')).toBe(true)
    expect(bad('delete from t', 'postgres')).toBe(true)
    expect(bad('/* /* */ select */ delete from t', 'postgres')).toBe(true)
    expect(bad('select pg_terminate_backend(123)', 'postgres')).toBe(true)
    expect(bad("select pg_catalog.pg_read_file('/etc/passwd')", 'postgres')).toBe(true)
    expect(bad("select set_config('transaction_read_only','off',true)", 'postgres')).toBe(true)
    expect(bad('set default_transaction_read_only = off', 'postgres')).toBe(true)
    expect(bad("select 'pg_terminate_backend(1); delete'", 'postgres')).toBe(false)
    expect(bad('select $$; delete from t; $$', 'postgres')).toBe(false)
    expect(bad('select 1 -- x; delete', 'mysql')).toBe(false)
    expect(bad('with a as (select 1) select * from a', 'postgres')).toBe(false)
    expect(bad('explain select 1', 'postgres')).toBe(false)
    expect(bad('show tables', 'mysql')).toBe(false)
  })

  it('lets a read-only data source control its session', () => {
    const ok = (s: string): boolean => readOnlyViolation(s, 'postgres', false) === null
    expect(ok('begin') && ok('rollback') && ok('set search_path = app')).toBe(true)
    expect(ok('set default_transaction_read_only = off')).toBe(false)
    expect(ok('start transaction read write')).toBe(false)
    expect(ok('update t set a = 1')).toBe(false)
    expect(ok('select pg_sleep(0)')).toBe(true)
  })
})

describe('unsafeStatement', () => {
  it('flags destructive statements', () => {
    const u = (s: string): string | null => unsafeStatement(s, 'postgres')
    expect(u('delete from t')).not.toBeNull()
    expect(u('update t set a = 1')).not.toBeNull()
    expect(u('update t set a = (select max(x) from y where y.k = 1)')).not.toBeNull()
    expect(u("delete from t where 'where' = 'x'")).toBeNull()
    expect(u('delete from t -- where id = 1')).not.toBeNull()
    expect(u('with d as (select 1) delete from t')).not.toBeNull()
    expect(u('drop table t')).not.toBeNull()
    expect(u('truncate t')).not.toBeNull()
    expect(u('delete from t where id = 1')).toBeNull()
    expect(u('select * from t')).toBeNull()
    expect(unsafeStatement('FLUSHALL', 'redis')).not.toBeNull()
    expect(unsafeStatement('GET a', 'redis')).toBeNull()
  })
})

describe('pagedQuery', () => {
  it('wraps plain reads', () => {
    expect(pagedQuery('select * from t;', 'postgres', 100)).toBe('select * from (\nselect * from t\n) as riven_page offset 100')
    expect(pagedQuery('with a as (select 1) select * from a -- note', 'postgres', 5)).toMatch(/-- note\n\) as riven_page offset 5$/)
    expect(pagedQuery('values (1)', 'postgres', 1)).not.toBeNull()
  })

  it('refuses anything a re-run would change', () => {
    for (const q of [
      'insert into t values (1)',
      'with d as (delete from t returning *) select * from d',
      'select * into t2 from t',
      'select * from t for update',
      "select nextval('s')",
      'select pg_sleep(1)',
      'select 1; select 2',
      'show all'
    ])
      expect(pagedQuery(q, 'postgres', 10)).toBeNull()
    expect(pagedQuery('select 1', 'mysql', 10)).toBeNull()
  })
})
