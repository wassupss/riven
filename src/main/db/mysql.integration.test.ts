import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Runs against real servers only when RIVEN_MY_TEST is set (root user,
// password in RIVEN_MY_PW), e.g.
//   docker run -d --rm -e MYSQL_ROOT_PASSWORD=test -p 53306:3306 mysql:8.4
//   docker run -d --rm -e MARIADB_ROOT_PASSWORD=test -p 53307:3306 mariadb:11
//   RIVEN_MY_TEST=localhost:53306,localhost:53307 RIVEN_MY_PW=test npx vitest run src/main/db/mysql
const targets = (process.env.RIVEN_MY_TEST ?? '').split(',').filter(Boolean)

const userData = mkdtempSync(join(tmpdir(), 'riven-my-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

describe.skipIf(!targets.length).each(targets.length ? targets : ['none'])('mysql driver (live) %s', async (target) => {
  const [host, port] = target.split(':')
  const store = await import('./store')
  const my = await import('./mysql')
  const meta = await import('./mysqlMeta')
  const { buildEdits } = await import('./edit')
  const DB = 'riven_t'
  let cfg: import('./types').ConnectionConfig

  beforeAll(async () => {
    const id = store.saveConnection(
      { name: `my ${port}`, kind: 'mysql', host, port: Number(port), user: 'root', database: '', readOnly: false },
      process.env.RIVEN_MY_PW
    ).id
    cfg = store.getConnection(id)!
    await my.myDdl(cfg, undefined, [`drop database if exists ${DB}`, `create database ${DB}`], false, 10_000)
    await my.myDdl(
      cfg,
      DB,
      [
        "create table parent (id int auto_increment primary key, name varchar(40) not null default 'x' comment 'display name', big bigint unsigned, at datetime(3), j json, ok tinyint(1), b varbinary(4), d decimal(20,6)) comment '부모'",
        'create table child (id int primary key, parent_id int, note text, constraint child_parent_fk foreign key (parent_id) references parent(id) on delete cascade, index child_note_idx (note(10)))',
        'create table nopk (a int)',
        'create view v_parent as select id, name from parent',
        'create function add1(i int) returns int deterministic return i + 1'
      ],
      false,
      10_000
    )
    const rows = Array.from({ length: 250 }, (_, i) => `('n${i + 1}', 18446744073709551615, '2026-01-02 03:04:05.678', '{"a":1}', ${i % 2}, 0x0102, 12345678901234.123456)`)
    await my.myExecute(cfg, DB, [`insert into parent (name, big, at, j, ok, b, d) values ${rows.join(', ')}`, 'insert into child values (1, 1, null)'], 10_000)
  })

  afterAll(async () => {
    await my.myDdl(cfg, undefined, [`drop database if exists ${DB}`], false, 10_000).catch(() => {})
    await my.myCloseAll()
  })

  it('reports the server', async () => {
    expect(await my.myTest(cfg)).toMatch(/^(MySQL|MariaDB) \d+/)
  })

  it('reads with a limit, losslessly, and traces columns to their table', async () => {
    const r = await my.myQuery(cfg, DB, 'select id, name, big, at, j, ok, b, d from parent order by id', { limit: 100 })
    expect(r.rows).toHaveLength(100)
    expect(r.truncated).toBe(true)
    expect(r.command).toBe('SELECT')
    const [id, name, big, at, j, , b, d] = r.rows[0]
    expect(id).toBe(1)
    expect(name).toBe('n1')
    expect(big).toBe('18446744073709551615')
    expect(at).toBe('2026-01-02 03:04:05.678')
    expect(JSON.parse(String(j))).toEqual({ a: 1 })
    expect(b).toBe('0x0102')
    expect(d).toBe('12345678901234.123456')
    // MariaDB's json is an alias of longtext.
    const json = (await my.myTest(cfg)).startsWith('MariaDB') ? 'text' : 'json'
    expect(r.columns.map((c) => c.type)).toEqual(['int', 'varchar', 'bigint unsigned', 'datetime', json, 'tinyint', 'varbinary', 'decimal'])
    expect(r.columns[0].table).toBeGreaterThan(0)
    expect(r.columns[0].attnum).toBeGreaterThan(0)
    // The pool connection that was cut off is gone; the next read works.
    const again = await my.myQuery(cfg, DB, 'select count(*) from parent', { limit: 10 })
    expect(again.rows[0][0]).toBe('250')
  })

  it('skips rows and reports writes', async () => {
    const r = await my.myQuery(cfg, DB, 'select id from parent order by id', { limit: 2, skip: 10 })
    expect(r.rows).toEqual([[11], [12]])
    const w = await my.myQuery(cfg, DB, "update parent set name = name where id <= 3", { limit: 10 })
    expect(w.columns).toEqual([])
    expect(w.rowCount).toBe(3)
    expect(w.command).toBe('UPDATE')
  })

  it('read-only queries cannot write', async () => {
    await expect(my.myQuery(cfg, DB, "update parent set name = 'z' where id = 1", { limit: 10, readOnly: true })).rejects.toThrow()
    const r = await my.myQuery(cfg, DB, 'select name from parent where id = 1', { limit: 1 })
    expect(r.rows[0][0]).toBe('n1')
  })

  it('times out and cancels', async () => {
    // An interrupted sleep() returns 1 on MySQL; MariaDB fails the statement.
    let t0 = Date.now()
    await my.myQuery(cfg, DB, 'select sleep(5) from parent limit 1', { limit: 1, timeoutMs: 300 }).catch(() => null)
    expect(Date.now() - t0).toBeLessThan(3000)
    t0 = Date.now()
    await my.myQuery(cfg, DB, 'select 1', { limit: 1 })
    expect(Date.now() - t0).toBeLessThan(1000)
    const p = my.myQuery(cfg, DB, 'select sleep(5)', { limit: 1, queryId: 'q1' })
    await new Promise((r) => setTimeout(r, 300))
    expect(await my.myCancel(cfg, 'q1')).toBe(true)
    const started = Date.now()
    await p.catch(() => {})
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('streams in batches up to max', async () => {
    const got: number[] = []
    const n = await my.myStream(cfg, DB, 'select id from parent order by id', { max: 230, batch: 100 }, (rows) => {
      got.push(rows.length)
    })
    expect(n).toBe(230)
    expect(got).toEqual([100, 100, 30])
  })

  it('execute is all or nothing', async () => {
    await expect(my.myExecute(cfg, DB, ["update parent set name = 'gone' where id = 2", 'insert into child values (1, 1, null)'], 5000)).rejects.toThrow()
    const r = await my.myQuery(cfg, DB, 'select name from parent where id = 2', { limit: 1 })
    expect(r.rows[0][0]).toBe('n2')
  })

  it('sessions keep a transaction across runs and undo a failed statement alone', async () => {
    const sid = `s-${port}`
    await my.mySessionQuery(cfg, DB, sid, "update parent set name = 'tx' where id = 5", { limit: 10 })
    expect(await my.mySessionStatus(sid)).toBe('active')
    await expect(my.mySessionQuery(cfg, DB, sid, 'insert into child values (1, 1, null)', { limit: 10 })).rejects.toThrow()
    expect(await my.mySessionStatus(sid)).toBe('active')
    const inside = await my.mySessionQuery(cfg, DB, sid, 'select name from parent where id = 5', { limit: 10 })
    expect(inside.rows[0][0]).toBe('tx')
    const outside = await my.myQuery(cfg, DB, 'select name from parent where id = 5', { limit: 1 })
    expect(outside.rows[0][0]).toBe('n5')
    expect(await my.mySessionEnd(sid, 'rollback')).toBe('idle')
    const after = await my.myQuery(cfg, DB, 'select name from parent where id = 5', { limit: 1 })
    expect(after.rows[0][0]).toBe('n5')
    await expect(my.mySessionQuery(cfg, 'mysql', sid, 'select 1', { limit: 1 })).resolves.toBeTruthy()
    await my.mySessionClose(sid)
    expect(my.myHasSession(sid)).toBe(false)
  })

  it('lists and describes the catalog', async () => {
    const dbs = await meta.listDatabases(cfg)
    expect(dbs).toContain(DB)
    expect(dbs.indexOf(DB)).toBeLessThan(dbs.indexOf('mysql'))
    expect(await meta.listSchemas(cfg, DB)).toEqual([{ name: DB, isSystem: false }])
    const objs = await meta.listObjects(cfg, DB, DB)
    expect(objs.map((o) => `${o.kind}:${o.name}`).sort()).toEqual(['function:add1', 'table:child', 'table:nopk', 'table:parent', 'view:v_parent'])
    expect(objs.find((o) => o.name === 'parent')?.comment).toBe('부모')
    expect(objs.find((o) => o.name === 'add1')?.args).toMatch(/^i int/)
    expect(await meta.findSchema(cfg, DB, 'parent')).toBe(DB)
    const t = (await meta.tableInfo(cfg, DB, DB, 'child'))!
    expect(t.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'note'])
    expect(t.columns[0].primaryKey).toBe(true)
    expect(t.constraints.find((c) => c.type === 'foreign key')?.def).toBe('FOREIGN KEY (parent_id) REFERENCES parent (id) ON DELETE CASCADE')
    expect(t.indexes.find((i) => i.name === 'child_note_idx')?.def).toBe('CREATE INDEX child_note_idx ON child (note(10))')
    const p = (await meta.tableInfo(cfg, DB, DB, 'parent'))!
    expect(p.comment).toBe('부모')
    expect(p.columns[1]).toMatchObject({ name: 'name', nullable: false, comment: 'display name' })
    expect(p.columns[1].default).toMatch(/^'?x'?$/)
    expect(await meta.objectDdl(cfg, DB, DB, 'parent')).toMatch(/^CREATE TABLE `parent`/)
    expect(await meta.objectDdl(cfg, DB, DB, 'v_parent')).toMatch(/VIEW `v_parent`/)
    expect(await meta.objectDdl(cfg, DB, DB, 'add1')).toMatch(/FUNCTION `add1`/)
    const c = await meta.completionMeta(cfg, DB)
    expect(c.searchPath).toEqual([DB])
    expect(c.tables.find((x) => x.name === 'parent')?.columns[0]).toMatchObject({ name: 'id', type: expect.stringMatching(/^int/) })
    expect(c.functions).toContain(`${DB}.add1`)
  })

  it('edits grid rows by key, reading each back', async () => {
    const r = await my.myQuery(cfg, DB, 'select id, name, big from parent where id in (7, 8) order by id', { limit: 10 })
    const table = r.columns[0].table!
    const target = (await meta.editTarget(cfg, DB, table))!
    expect(target).toMatchObject({ schema: DB, name: 'parent', editable: true })
    const nameDetail = await meta.columnDetail(cfg, DB, table, r.columns[1].attnum!)
    expect(nameDetail).toMatchObject({ table: `${DB}.parent`, column: 'name', comment: 'display name' })
    const plan = buildEdits(target, r.columns, r.rows, { updates: { 0: { 1: 'edited' } }, deletes: [1], inserts: [{ 1: 'new' }] }, 'mysql')
    const back = await my.myApply(cfg, DB, undefined, plan.stmts)
    const ins = back[plan.kinds.findIndex((k) => k.op === 'insert')]!
    expect(ins[1]).toBe('new')
    expect(Number(ins[0])).toBeGreaterThan(250)
    expect(back[plan.kinds.findIndex((k) => k.op === 'update')]).toEqual([7, 'edited', '18446744073709551615'])
    const left = await my.myQuery(cfg, DB, 'select id from parent where id in (7, 8)', { limit: 10 })
    expect(left.rows).toEqual([[7]])
    // A row that no longer matches rejects the whole set.
    const stale = buildEdits(target, r.columns, r.rows, { updates: {}, deletes: [1], inserts: [] }, 'mysql')
    await expect(my.myApply(cfg, DB, undefined, stale.stmts)).rejects.toThrow(/matched 0 rows/)
    const nopk = await my.myQuery(cfg, DB, 'select a from nopk', { limit: 1 })
    expect((await meta.editTarget(cfg, DB, nopk.columns[0].table!))?.reason).toBe('nopk')
  })
})
