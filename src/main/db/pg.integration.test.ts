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

  it('keeps a manual-commit session open until commit or rollback', async () => {
    const cfg = store.getConnection(id)!
    const count = async (): Promise<number> =>
      Number((await pg.pgQuery(cfg, undefined, "select count(*)::int from riven_t.child where note = 'tx'", { limit: 1 })).rows[0][0])
    await pg.pgSessionQuery(cfg, undefined, 's1', "insert into riven_t.child values (900, null, 'tx')", { limit: 10 })
    expect(await pg.pgSessionStatus('s1')).toBe('active')
    expect(await count()).toBe(0)
    // A failing statement doesn't poison the transaction (statement savepoint).
    await expect(pg.pgSessionQuery(cfg, undefined, 's1', 'select 1/0', { limit: 10 })).rejects.toThrow(/division/)
    expect(await pg.pgSessionStatus('s1')).toBe('active')
    // Switching database mid-transaction is refused.
    await expect(pg.pgSessionQuery(cfg, 'template1', 's1', 'select 1', { limit: 1 })).rejects.toThrow(/Commit or roll back/)
    expect(await pg.pgSessionEnd('s1', 'rollback')).toBe('idle')
    expect(await count()).toBe(0)
    await pg.pgSessionQuery(cfg, undefined, 's1', "insert into riven_t.child values (900, null, 'tx')", { limit: 10 })
    expect(await pg.pgSessionEnd('s1', 'commit')).toBe('idle')
    expect(await count()).toBe(1)
    await pg.pgSessionClose('s1')
    expect(await pg.pgSessionStatus('s1')).toBe('none')
    await pg.pgExecute(cfg, undefined, ['delete from riven_t.child where id = 900'], 5000)
  })

  it('describes an edit target and applies row edits atomically', async () => {
    const cfg = store.getConnection(id)!
    const { editTarget } = await import('./meta')
    const { buildEdits } = await import('./edit')
    const res = await pg.pgQuery(cfg, undefined, 'select id, name, ok from riven_t.parent order by id', { limit: 3 })
    const target = (await editTarget(cfg, undefined, res.columns[0].table!))!
    expect(target).toMatchObject({ schema: 'riven_t', name: 'parent', editable: true })
    const view = await pg.pgQuery(cfg, undefined, 'select * from riven_t.v_parent', { limit: 1 })
    if (view.columns[0].table) expect((await editTarget(cfg, undefined, view.columns[0].table))?.editable).not.toBe(true)

    const plan = buildEdits(target, res.columns, res.rows, { updates: { 0: { 1: 'edited' } }, deletes: [], inserts: [{ 1: 'fresh' }] })
    const out = await pg.pgApply(cfg, undefined, undefined, plan.stmts)
    expect(out[0]).toEqual([res.rows[0][0], 'edited', res.rows[0][2]])
    expect(out[1]?.[1]).toBe('fresh')
    expect(typeof out[1]?.[0]).toBe('number')

    // A statement matching no row rolls back the whole batch.
    const bad = buildEdits(target, res.columns, [res.rows[1], [-1, 'x', true]], {
      updates: { 0: { 1: 'first' }, 1: { 1: 'nope' } },
      deletes: [],
      inserts: []
    })
    await expect(pg.pgApply(cfg, undefined, undefined, bad.stmts)).rejects.toThrow(/matched 0 rows/)
    const after = await pg.pgQuery(cfg, undefined, `select name from riven_t.parent where id = ${res.rows[1][0]}`, { limit: 1 })
    expect(after.rows[0][0]).toBe(res.rows[1][1])

    // Inside a session the edits wait for commit.
    const del = buildEdits(target, res.columns, res.rows, { updates: {}, deletes: [2], inserts: [] })
    await pg.pgApply(cfg, undefined, 's2', del.stmts)
    const gone = `select count(*)::int from riven_t.parent where id = ${res.rows[2][0]}`
    expect((await pg.pgQuery(cfg, undefined, gone, { limit: 1 })).rows[0][0]).toBe(1)
    await pg.pgSessionEnd('s2', 'rollback')
    expect((await pg.pgQuery(cfg, undefined, gone, { limit: 1 })).rows[0][0]).toBe(1)
    await pg.pgSessionClose('s2')
  })

  it('honours a read-only data source', async () => {
    store.saveConnection({ ...store.getConnection(id)!, id: 'ro', name: 'ro pg', readOnly: true }, password)
    const r = await runDbTool('riven_db_execute', { connection: 'ro pg', statements: ['delete from riven_t.child'] }, async () => '실행')
    expect(r).toMatch(/^refused: .*read-only/)
    // default_transaction_read_only=on at the session level too
    const cfg = store.getConnection('ro')!
    await expect(pg.pgExecute(cfg, undefined, ['delete from riven_t.child'], 5000)).rejects.toThrow(/read-only/)
  })

  it('applies designer and object DDL', async () => {
    const ddl = await import('./ddl')
    const meta = await import('./meta')
    const cfg = store.getConnection(id)!
    const run = (plan: { stmts: string[]; atomic: boolean }, db?: string): Promise<number> =>
      pg.pgDdl(cfg, db, plan.stmts, plan.atomic, 10_000)

    const d = ddl.newTable('riven_t')
    d.name = 'designed'
    d.columns.push({ ...ddl.emptyColumn(), name: 'pid', type: 'integer', nullable: false, comment: 'owner' })
    d.constraints.push({ ...ddl.emptyConstraint('foreign key'), columns: 'pid', refTable: 'parent', refColumns: 'id', onDelete: 'CASCADE' })
    d.indexes.push({ ...ddl.emptyIndex(), name: 'designed_pid_idx', columns: 'pid' })
    expect(ddl.draftProblems(d)).toEqual([])
    await run(ddl.createTableSql(d))
    let info = (await meta.tableInfo(cfg, undefined, 'riven_t', 'designed'))!
    expect(info.columns.map((c) => c.name)).toEqual(['id', 'pid'])
    expect(info.columns[1].comment).toBe('owner')
    expect(ddl.alterTableSql(info, ddl.draftFromTable(info)).stmts).toEqual([])

    const e = ddl.draftFromTable(info)
    e.name = 'designed2'
    e.columns[1].name = 'parent_id'
    e.columns.push({ ...ddl.emptyColumn(), name: 'note', type: 'varchar(20)', default: "'x'" })
    e.indexes[0].dropped = true
    await run(ddl.alterTableSql(info, e))
    info = (await meta.tableInfo(cfg, undefined, 'riven_t', 'designed2'))!
    expect(info.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'note'])
    expect(info.indexes.some((i) => i.name === 'designed_pid_idx')).toBe(false)
    expect(ddl.alterTableSql(info, ddl.draftFromTable(info)).stmts).toEqual([])

    // An atomic plan that fails part way leaves nothing behind.
    await expect(
      run({ stmts: ['ALTER TABLE riven_t.designed2 ADD COLUMN gone int', 'ALTER TABLE riven_t.nope ADD COLUMN x int'], atomic: true })
    ).rejects.toThrow()
    info = (await meta.tableInfo(cfg, undefined, 'riven_t', 'designed2'))!
    expect(info.columns.some((c) => c.name === 'gone')).toBe(false)

    await run(ddl.truncateSql('riven_t', 'designed2', { restartIdentity: true }))
    await run(ddl.renameSql('table', 'riven_t', 'designed2', 'designed3'))
    await run(ddl.dropSql('table', 'riven_t', 'designed3'))
    expect(await meta.tableInfo(cfg, undefined, 'riven_t', 'designed3')).toBeNull()
  })

  it('creates and drops a database it has a pool on', async () => {
    const ddl = await import('./ddl')
    const cfg = store.getConnection(id)!
    await pg.pgDdl(cfg, undefined, ['DROP DATABASE IF EXISTS riven_ddl_t WITH (FORCE)'], false, 10_000)
    const c = ddl.createDatabaseSql('riven_ddl_t', { encoding: 'UTF8' })
    await pg.pgDdl(cfg, undefined, c.stmts, c.atomic, 10_000)
    expect((await pg.pgQuery(cfg, 'riven_ddl_t', 'select 1', { limit: 1 })).rows[0][0]).toBe(1)
    const drop = ddl.dropSql('database', '', 'riven_ddl_t')
    expect(drop.release).toBe('riven_ddl_t')
    await pg.closeDatabase(id, drop.release!)
    await pg.pgDdl(cfg, undefined, drop.stmts, drop.atomic, 10_000)
    expect(await (await import('./meta')).listDatabases(cfg)).not.toContain('riven_ddl_t')
  })
  it('manages roles, grants, default privileges and row-level security', async () => {
    const pv = await import('./privs')
    const pm = await import('./privMeta')
    const cfg = store.getConnection(id)!
    const run = (plan: { stmts: string[]; atomic?: boolean }): Promise<number> => pg.pgDdl(cfg, undefined, plan.stmts, plan.atomic !== false, 10_000)
    // Leftovers of an aborted run (roles outlive the schema).
    for (const r of ['"Riven App"', 'riven_ro']) {
      await pg.pgExecute(cfg, undefined, [`drop owned by ${r}`], 10_000).catch(() => undefined)
      await pg.pgExecute(cfg, undefined, [`drop role if exists ${r}`], 10_000)
    }
    await run(pv.createRoleSql({ ...pv.newRole(), name: 'riven_ro', login: false }))
    await run(pv.createRoleSql({ ...pv.newRole(), name: 'Riven App', connLimit: '3', password: 'pw', comment: '앱', memberOf: [{ role: 'riven_ro', admin: true }] }))
    let roles = await pm.listRoles(cfg)
    const app = roles.find((r) => r.name === 'Riven App')!
    expect(app).toMatchObject({ login: true, connLimit: 3, comment: '앱', memberOf: [{ role: 'riven_ro', admin: true }], system: false })
    expect(roles.find((r) => r.name === 'pg_read_all_data')?.system).toBe(true)

    const orig = pv.roleDraft(app, roles)
    await run(pv.alterRoleSql(orig, { ...orig, createDb: true, connLimit: '', validUntil: '2099-01-01', memberOf: [{ role: 'riven_ro', admin: false }] }))
    roles = await pm.listRoles(cfg)
    expect(roles.find((r) => r.name === 'Riven App')).toMatchObject({ createDb: true, connLimit: -1, memberOf: [{ role: 'riven_ro', admin: false }] })
    expect(roles.find((r) => r.name === 'Riven App')!.validUntil).toMatch(/^2099-01-01/)

    const target = { kind: 'table' as const, schema: 'riven_t', name: 'parent' }
    const before = (await pm.objectPrivileges(cfg, undefined, target))!
    expect(before.owner).toBe(user)
    expect(before.available).toContain('SELECT')
    await run(pv.grantsSql(target, before.grants, [
      ...before.grants,
      { grantee: 'Riven App', privilege: 'SELECT', grantable: true },
      { grantee: 'riven_ro', privilege: 'SELECT', grantable: false }
    ]))
    const after = (await pm.objectPrivileges(cfg, undefined, target))!
    expect(after.grants).toContainEqual({ grantee: 'Riven App', privilege: 'SELECT', grantable: true })
    expect((await pm.roleGrants(cfg, undefined, 'riven_ro')).find((g) => g.name === 'parent')).toMatchObject({ kind: 'table', privileges: ['SELECT'] })
    await run(pv.grantsSql(target, after.grants, before.grants))
    expect((await pm.objectPrivileges(cfg, undefined, target))!.grants).toEqual(before.grants)
    const sch = (await pm.objectPrivileges(cfg, undefined, { kind: 'schema', schema: '', name: 'riven_t' }))!
    expect(sch.available).toEqual(['USAGE', 'CREATE'])
    const fn = await pm.objectPrivileges(cfg, undefined, { kind: 'function', schema: 'riven_t', name: 'add1', args: 'i integer' })
    expect(fn?.grants).toContainEqual({ grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false })

    const rule = { role: user, schema: 'riven_t', objType: 'tables' as const, grantee: 'riven_ro', privileges: ['SELECT'], grantable: [] }
    await run(pv.defaultRuleSql(null, rule))
    expect(pv.defaultRules(await pm.defaultAcls(cfg, undefined))).toContainEqual(rule)
    await run(pv.defaultRuleSql(rule, null))
    expect(pv.defaultRules(await pm.defaultAcls(cfg, undefined))).not.toContainEqual(rule)

    await pg.pgExecute(cfg, undefined, ['create table riven_t.secured (id int, owner text)'], 10_000)
    await run(pv.rlsSql('riven_t', 'secured', { enabled: false, forced: false }, { enabled: true, forced: true }))
    const pol = { ...pv.newPolicy(), name: 'mine', command: 'SELECT' as const, roles: 'riven_ro', using: 'owner = current_user' }
    await run(pv.policySql('riven_t', 'secured', pol))
    const rls = (await pm.rlsInfo(cfg, undefined, 'riven_t', 'secured'))!
    expect(rls).toMatchObject({ enabled: true, forced: true })
    expect(rls.policies).toEqual([{ name: 'mine', command: 'SELECT', permissive: true, roles: ['riven_ro'], using: '(owner = CURRENT_USER)', check: null }])
    await run(pv.policySql('riven_t', 'secured', { ...pv.policyDraft(rls.policies[0]), command: 'ALL', check: 'true' }, pv.policyDraft(rls.policies[0])))
    expect((await pm.rlsInfo(cfg, undefined, 'riven_t', 'secured'))!.policies[0]).toMatchObject({ command: 'ALL', check: 'true' })
    expect(await pm.rlsInfo(cfg, undefined, 'riven_t', 'nope')).toBeNull()

    await run(pv.dropRoleSql('Riven App', { reassignTo: user, dropOwned: true }))
    await run(pv.dropRoleSql('riven_ro', { dropOwned: true }))
    expect((await pm.listRoles(cfg)).map((r) => r.name)).not.toContain('riven_ro')
  })
})
