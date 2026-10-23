import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SqliteCore, cell } from './sqliteCore'
import { buildEdits } from './edit'
import type { EditTarget } from './edit'

let dir: string
let file: string
let c: SqliteCore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riven-sqlite-'))
  file = path.join(dir, 't.db')
  c = new SqliteCore({ file, readOnly: false })
  c.ddl(
    [
      'create table t (id integer primary key, name text not null, n int, b blob, g int generated always as (n * 2) virtual)',
      "insert into t (name, n, b) values ('a', 1, x'00ff'), ('b', 9007199254740993, null), ('c', 3, null)"
    ],
    true
  )
})

afterEach(() => {
  c.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('cell', () => {
  it('keeps 64-bit integers exact and blobs as hex', () => {
    expect(cell(5n)).toBe(5)
    expect(cell(9007199254740993n)).toBe('9007199254740993')
    expect(cell(new Uint8Array([0, 255]))).toBe('0x00ff')
    expect(cell(1.5)).toBe(1.5)
    expect(cell(null)).toBe(null)
  })
})

describe('SqliteCore', () => {
  it('reads with limit, skip and source columns', () => {
    const r = c.query('select id, name, n + 0 as e, b from t order by id', { limit: 2 })
    expect(r.rows).toEqual([
      [1, 'a', 1, '0x00ff'],
      [2, 'b', '9007199254740993', null]
    ])
    expect(r.truncated).toBe(true)
    expect(r.columns[0]).toEqual({ name: 'id', type: 'integer', database: 'main', table: 't', column: 'id' })
    expect(r.columns[2]).toEqual({ name: 'e', type: 'integer' })
    expect(c.query('select id from t order by id', { limit: 5, skip: 2 }).rows).toEqual([[3]])
  })

  it('reports affected rows for writes', () => {
    const r = c.query("update t set name = 'x' where id < 3", { limit: 10 })
    expect(r).toMatchObject({ columns: [], rowCount: 2, command: 'UPDATE' })
  })

  it('refuses writes in read-only mode and recovers after', () => {
    expect(() => c.query("delete from t", { limit: 1, readOnly: true })).toThrow(/readonly/)
    expect(c.query('delete from t where id = 3', { limit: 1 }).rowCount).toBe(1)
  })

  it('opens a file read-only', () => {
    const ro = new SqliteCore({ file, readOnly: true })
    try {
      expect(() => ro.query('delete from t', { limit: 1 })).toThrow(/readonly/)
    } finally {
      ro.close()
    }
  })

  it('executes all or nothing', () => {
    expect(() => c.execute(["insert into t (name) values ('d')", 'insert into nope values (1)'])).toThrow()
    expect(c.rows('select count(*) from t')).toEqual([[3]])
    expect(c.execute(["insert into t (name) values ('d')", 'select * from t'])).toEqual([
      { command: 'INSERT', rowCount: 1 },
      { command: 'SELECT', rowCount: 4 }
    ])
  })

  it('runs atomic DDL in one transaction', () => {
    expect(() => c.ddl(['create table u (x int)', 'create table t (y int)'], true)).toThrow()
    expect(c.rows("select count(*) from sqlite_master where name = 'u'")).toEqual([[0]])
  })

  it('keeps a session transaction across statements and undoes a failed one alone', () => {
    c.sessionQuery("insert into t (name) values ('s1')", { limit: 10 })
    expect(c.inTx).toBe(true)
    expect(() => c.sessionQuery('insert into t (name) values (null)', { limit: 10 })).toThrow()
    expect(c.inTx).toBe(true)
    c.sessionQuery("insert into t (name) values ('s2')", { limit: 10 })
    expect(c.sessionEnd('rollback')).toBe(false)
    expect(c.rows('select count(*) from t')).toEqual([[3]])
    c.sessionQuery("insert into t (name) values ('s3')", { limit: 10 })
    c.sessionEnd('commit')
    expect(c.rows('select count(*) from t')).toEqual([[4]])
  })

  it('does not open a transaction for aux reads or control statements', () => {
    c.sessionQuery('select 1', { limit: 1, aux: true })
    expect(c.inTx).toBe(false)
    c.sessionQuery('begin', { limit: 1 })
    expect(c.inTx).toBe(true)
    c.sessionQuery('rollback', { limit: 1 })
    expect(c.inTx).toBe(false)
  })

  it('applies grid edits with RETURNING, one row each', () => {
    const target: EditTarget = {
      table: 1,
      schema: 'main',
      name: 't',
      editable: true,
      pk: [1],
      columns: [
        { attnum: 1, name: 'id', type: 'integer', readOnly: false },
        { attnum: 2, name: 'name', type: 'text', readOnly: false },
        { attnum: 3, name: 'n', type: 'int', readOnly: false },
        { attnum: 4, name: 'g', type: 'int', readOnly: true }
      ]
    }
    const cols = [
      { name: 'id', type: 'integer', table: 1, attnum: 1 },
      { name: 'name', type: 'text', table: 1, attnum: 2 },
      { name: 'n', type: 'int', table: 1, attnum: 3 },
      { name: 'g', type: 'int', table: 1, attnum: 4 }
    ]
    const rows = [
      [1, 'a', 1, 2],
      [3, 'c', 3, 6]
    ]
    const plan = buildEdits(target, cols, rows, { updates: { 0: { 1: 'A', 2: '5' } }, deletes: [1], inserts: [{ 1: 'new' }] }, 'sqlite')
    const out = c.apply(plan.stmts)
    expect(out).toEqual([null, [1, 'A', 5, 10], [3, 'new', null, null]])
    expect(c.rows('select id from t order by id')).toEqual([[1], [2], [3]])
    // A statement missing its row undoes the whole batch.
    const bad = buildEdits(target, cols, [[99, 'z', 0, 0], ...rows], { updates: { 1: { 1: 'B' } }, deletes: [0], inserts: [] }, 'sqlite')
    expect(() => c.apply(bad.stmts)).toThrow(/matched 0 rows/)
    expect(c.rows('select name from t where id = 1')).toEqual([['A']])
  })

  it('streams in pulled batches', () => {
    c.streamOpen('select id from t order by id')
    expect(c.streamNext(2)).toEqual([[1], [2]])
    expect(c.streamNext(2)).toEqual([[3]])
    expect(c.streamNext(2)).toEqual([])
  })
})
