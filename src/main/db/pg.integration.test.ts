import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Runs against a real server only when RIVEN_PG_TEST is set, e.g.
//   docker run -d --rm -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
//   RIVEN_PG_TEST=localhost:55432:postgres:test npx vitest run src/main/db
const target = process.env.RIVEN_PG_TEST

const userData = mkdtempSync(join(tmpdir(), 'riven-db-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

describe.skipIf(!target)('postgres engine (live)', async () => {
  const [host, port, user, password] = (target ?? '').split(':')
  const store = await import('./store')
  const pg = await import('./pg')
  const { runDbTool } = await import('./engine')
  let id = ''
  const tool = (name: string, args: Record<string, unknown> = {}, answer = '실행'): Promise<string> =>
    runDbTool(name, { connection: 'test pg', ...args }, async () => answer)

  beforeAll(async () => {
    id = store.saveConnection(
      { name: 'test pg', kind: 'postgres', host, port: Number(port), user, database: 'postgres', readOnly: false },
      password
    ).id
    const cfg = store.getConnection(id)!
    await pg.pgExecute(cfg, undefined, [
      'drop schema if exists riven_t cascade',
      'create schema riven_t',
      "create table riven_t.parent (id serial primary key, name text not null default 'x', big bigint, at timestamptz, j jsonb, ok boolean)",
      "comment on table riven_t.parent is '부모'",
      "comment on column riven_t.parent.name is 'display name'",
      'create table riven_t.child (id int primary key, parent_id int references riven_t.parent(id), note text)',
      'create index child_note_idx on riven_t.child (note)',
      'create view riven_t.v_parent as select id, name from riven_t.parent',
      'create function riven_t.add1(i int) returns int language sql as $$ select i + 1 $$',
      "insert into riven_t.parent (name, big, at, j, ok) select 'n' || g, 9007199254740993, '2026-01-02T03:04:05Z', '{\"a\":1}', g % 2 = 0 from generate_series(1, 250) g"
    ], 10_000)
  })
  afterAll(async () => {
    const cfg = store.getConnection(id)
    if (cfg) await pg.pgExecute(cfg, undefined, ['drop schema if exists riven_t cascade'], 10_000).catch(() => {})
    await pg.closeAll()
  })

  it('lists connections and browses', async () => {
    expect(await tool('riven_db_connections')).toContain('test pg')
    const top = await tool('riven_db_browse')
    expect(top).toContain('riven_t')
    expect(top).toContain('Databases on this server: postgres')
    const objs = await tool('riven_db_browse', { schema: 'riven_t' })
    expect(objs).toMatch(/parent\s+\| table/)
    expect(objs).toContain('v_parent')
    expect(objs).toContain('(i integer) -> integer')
  })

  it('describes and builds DDL', async () => {
    const d = await tool('riven_db_describe', { table: 'parent' })
    expect(d).toContain('table riven_t.parent -- 부모')
    expect(d).toMatch(/id\s+\| integer\s+\| no\s+\| nextval/)
    expect(d).toContain('display name')
    const ddl = await tool('riven_db_describe', { table: 'riven_t.child', ddl: true })
    expect(ddl).toContain('CREATE TABLE riven_t.child')
    expect(ddl).toContain('FOREIGN KEY (parent_id) REFERENCES riven_t.parent(id)')
    expect(ddl).toContain('CREATE INDEX child_note_idx')
    expect(await tool('riven_db_describe', { table: 'v_parent', ddl: true })).toMatch(/^CREATE OR REPLACE VIEW riven_t\.v_parent AS/)
    expect(await tool('riven_db_describe', { table: 'parent_id_seq', ddl: true })).toContain('CREATE SEQUENCE riven_t.parent_id_seq')
    expect(await tool('riven_db_describe', { table: 'add1' })).toContain('CREATE OR REPLACE FUNCTION riven_t.add1')
  })

  it('reads with a row cap and keeps lossy types as text', async () => {
    const r = await tool('riven_db_query', { sql: 'select * from riven_t.parent order by id', limit: 5 })
    expect(r).toMatch(/^5 row\(s\) \(truncated/)
    expect(r).toContain('9007199254740993')
    expect(r).toContain('{"a": 1}')
    const cfg = store.getConnection(id)!
    const q = await pg.pgQuery(cfg, undefined, 'select id, big, ok, at from riven_t.parent where id = 2', { limit: 10 })
    expect(q.rows[0]).toEqual([2, '9007199254740993', true, expect.stringMatching(/^2026-01-02/)])
    expect(q.columns.map((c) => c.type)).toEqual(['integer', 'bigint', 'boolean', 'timestamptz'])
    const empty = await pg.pgQuery(cfg, undefined, 'select id, name from riven_t.parent where false', { limit: 10 })
    expect(empty.columns.map((c) => c.name)).toEqual(['id', 'name'])
  })

  it('refuses writes through query, even disguised', async () => {
    expect(await tool('riven_db_query', { sql: 'delete from riven_t.parent' })).toMatch(/^refused/)
    expect(await tool('riven_db_query', { sql: 'select 1; delete from riven_t.parent' })).toMatch(/^refused/)
    // A writable CTE passes the word guard but the read-only transaction stops it.
    expect(await tool('riven_db_query', { sql: 'with d as (delete from riven_t.parent returning 1) select count(*) from d' })).toMatch(
      /read-only transaction/
    )
    expect(await tool('riven_db_query', { sql: 'select count(*) from riven_t.parent' })).toContain('250')
  })

  it('executes only after approval, atomically', async () => {
    const declined = await tool('riven_db_execute', { statements: ['delete from riven_t.child'] }, '취소')
    expect(declined).toMatch(/^not executed/)
    const ok = await tool('riven_db_execute', {
      statements: ['insert into riven_t.child values (1, 1, $$a$$)', 'update riven_t.child set note = $$b$$ where id = 1']
    })
    expect(ok).toContain('committed')
    expect(ok).toContain('INSERT 1')
    const failed = await tool('riven_db_execute', {
      statements: ['insert into riven_t.child values (2, 1, $$c$$)', 'insert into riven_t.child values (2, 1, $$dup$$)']
    })
    expect(failed).toMatch(/^error: .*duplicate key/)
    expect(await tool('riven_db_query', { sql: 'select count(*) from riven_t.child' })).toMatch(/\n1\s*$/)
  })

  it('cancels a running query', async () => {
    const cfg = store.getConnection(id)!
    const p = expect(pg.pgQuery(cfg, undefined, 'select pg_sleep(10)', { limit: 1, queryId: 'q1' })).rejects.toThrow(/cancel/)
    await new Promise((r) => setTimeout(r, 300))
    expect(await pg.pgCancel(cfg, 'q1')).toBe(true)
    await p
    // The pool still works after a cancelled query.
    expect((await pg.pgQuery(cfg, undefined, 'select 1', { limit: 1 })).rows).toEqual([[1]])
  })

  it('honours a read-only data source', async () => {
    store.saveConnection({ ...store.getConnection(id)!, id: 'ro', name: 'ro pg', readOnly: true }, password)
    const r = await runDbTool('riven_db_execute', { connection: 'ro pg', statements: ['delete from riven_t.child'] }, async () => '실행')
    expect(r).toMatch(/^refused: .*read-only/)
    // default_transaction_read_only=on at the session level too
    const cfg = store.getConnection('ro')!
    await expect(pg.pgExecute(cfg, undefined, ['delete from riven_t.child'], 5000)).rejects.toThrow(/read-only/)
  })
})
