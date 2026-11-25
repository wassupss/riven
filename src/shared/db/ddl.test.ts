import { describe, expect, it } from 'vitest'
import {
  alterTableSql,
  canRename,
  createDatabaseSql,
  createSchemaSql,
  createTableSql,
  createViewSql,
  draftFromTable,
  draftProblems,
  dropKindOf,
  isDdl,
  dropSql,
  emptyColumn,
  emptyConstraint,
  emptyIndex,
  newTable,
  normType,
  planText,
  refreshMatviewSql,
  renameSql,
  truncateSql
} from './ddl'
import type { TableInfo } from './types'

const users: TableInfo = {
  schema: 'public',
  name: 'users',
  kind: 'table',
  comment: null,
  columns: [
    { name: 'id', type: 'integer', nullable: false, default: null, comment: null, primaryKey: true },
    { name: 'email', type: 'text', nullable: false, default: null, comment: 'login', primaryKey: false },
    { name: 'age', type: 'integer', nullable: true, default: '0', comment: null, primaryKey: false }
  ],
  indexes: [
    { name: 'users_pkey', def: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)', unique: true, primary: true },
    { name: 'users_email_key', def: '...', unique: true, primary: false },
    { name: 'users_age_idx', def: 'CREATE INDEX users_age_idx ON public.users USING btree (age)', unique: false, primary: false }
  ],
  constraints: [
    { name: 'users_pkey', type: 'primary key', def: 'PRIMARY KEY (id)' },
    { name: 'users_email_key', type: 'unique', def: 'UNIQUE (email)' },
    { name: 'age_ok', type: 'check', def: 'CHECK ((age >= 0))' }
  ]
}

describe('createTableSql', () => {
  it('builds the table, its keys, indexes and comments', () => {
    const d = newTable('app')
    d.name = 'Orders'
    d.comment = "it's"
    d.columns.push({ ...emptyColumn(), name: 'user_id', type: 'integer', nullable: false, comment: 'owner' })
    d.constraints.push({ ...emptyConstraint('foreign key'), name: 'fk_user', columns: 'user_id', refTable: 'public.users', refColumns: 'id', onDelete: 'CASCADE' })
    d.constraints.push({ ...emptyConstraint('check'), expr: 'user_id > 0' })
    d.indexes.push({ ...emptyIndex(), columns: 'user_id, lower(x)', where: 'user_id > 10' })
    expect(createTableSql(d).stmts).toEqual([
      'CREATE TABLE app."Orders" (\n' +
        '    id bigint generated always as identity NOT NULL,\n' +
        '    user_id integer NOT NULL,\n' +
        '    PRIMARY KEY (id),\n' +
        '    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE,\n' +
        '    CHECK (user_id > 0)\n' +
        ')',
      'CREATE INDEX ON app."Orders" (user_id, lower(x)) WHERE user_id > 10',
      `COMMENT ON TABLE app."Orders" IS 'it''s'`,
      `COMMENT ON COLUMN app."Orders".user_id IS 'owner'`
    ])
  })
  it('puts a foreign key without a schema in the table schema', () => {
    const d = newTable('app')
    d.name = 't'
    d.constraints.push({ ...emptyConstraint('foreign key'), columns: 'id', refTable: 'other' })
    expect(createTableSql(d).stmts[0]).toContain('FOREIGN KEY (id) REFERENCES app.other\n')
  })
})

describe('alterTableSql', () => {
  it('is empty for an unchanged draft', () => {
    expect(alterTableSql(users, draftFromTable(users)).stmts).toEqual([])
  })
  it('leaves constraint-backed indexes to the constraint', () => {
    expect(draftFromTable(users).indexes.map((i) => i.name)).toEqual(['users_age_idx'])
    expect(draftFromTable(users).constraints.map((c) => c.name)).toEqual(['users_email_key', 'age_ok'])
  })
  it('orders drops, renames, adds and changes, then renames the table', () => {
    const d = draftFromTable(users)
    d.name = 'people'
    d.comment = 'humans'
    d.columns[1].name = 'mail'
    d.columns[1].comment = ''
    d.columns[2].dropped = true
    d.columns.push({ ...emptyColumn(), name: 'nick', type: 'varchar(20)', default: "'x'" })
    d.constraints[1].dropped = true
    d.indexes[0].dropped = true
    d.indexes.push({ ...emptyIndex(), name: 'by_mail', columns: 'mail', unique: true })
    expect(alterTableSql(users, d).stmts).toEqual([
      'ALTER TABLE public.users DROP CONSTRAINT age_ok',
      'DROP INDEX public.users_age_idx',
      'ALTER TABLE public.users DROP COLUMN age',
      'ALTER TABLE public.users RENAME COLUMN email TO mail',
      "ALTER TABLE public.users ADD COLUMN nick varchar(20) DEFAULT 'x'",
      "COMMENT ON TABLE public.users IS 'humans'",
      'COMMENT ON COLUMN public.users.mail IS NULL',
      'CREATE UNIQUE INDEX by_mail ON public.users (mail)',
      'ALTER TABLE public.users RENAME TO people'
    ])
  })
  it('changes type, default and nullability', () => {
    const d = draftFromTable(users)
    d.columns[2].type = 'bigint'
    d.columns[2].default = ''
    d.columns[2].nullable = false
    d.columns[1].type = 'TEXT'
    expect(alterTableSql(users, d).stmts).toEqual([
      'ALTER TABLE public.users ALTER COLUMN age TYPE bigint USING age::bigint',
      'ALTER TABLE public.users ALTER COLUMN age DROP DEFAULT',
      'ALTER TABLE public.users ALTER COLUMN age SET NOT NULL'
    ])
  })
  it('recreates the primary key when its columns change', () => {
    const d = draftFromTable(users)
    d.columns[1].pk = true
    expect(alterTableSql(users, d).stmts).toEqual([
      'ALTER TABLE public.users DROP CONSTRAINT users_pkey',
      'ALTER TABLE public.users ADD PRIMARY KEY (id, email)'
    ])
    const none = draftFromTable(users)
    none.columns[0].pk = false
    expect(alterTableSql(users, none).stmts).toEqual(['ALTER TABLE public.users DROP CONSTRAINT users_pkey'])
  })
  it('keeps the primary key through a column rename', () => {
    const d = draftFromTable(users)
    d.columns[0].name = 'user_id'
    expect(alterTableSql(users, d).stmts).toEqual(['ALTER TABLE public.users RENAME COLUMN id TO user_id'])
  })
})

describe('normType', () => {
  it('folds aliases, case and spacing', () => {
    expect(normType('INT')).toBe('integer')
    expect(normType('varchar( 20 )')).toBe('character varying(20)')
    expect(normType('numeric(10, 2)')).toBe('numeric(10,2)')
    expect(normType('timestamptz')).toBe('timestamp with time zone')
    expect(normType('timestamp(3)')).toBe('timestamp(3) without time zone')
    expect(normType('int[]')).toBe('integer[]')
  })
})

describe('draftProblems', () => {
  it('reports missing names, duplicates and empty constraints', () => {
    const d = newTable('public')
    d.columns.push({ ...emptyColumn(), name: 'id' }, { ...emptyColumn(), name: '' })
    d.constraints.push(emptyConstraint('unique'))
    d.indexes.push(emptyIndex())
    expect(draftProblems(d).map((p) => p.key)).toEqual([
      'db.d.err.tableName',
      'db.d.err.duplicate',
      'db.d.err.columnName',
      'db.d.err.constraint',
      'db.d.err.index'
    ])
  })
  it('is clean for a valid draft', () => {
    const d = newTable('public')
    d.name = 't'
    expect(draftProblems(d)).toEqual([])
  })
})

describe('object actions', () => {
  it('drops with the right keyword and target', () => {
    expect(dropSql('matview', 'public', 'mv', { cascade: true }).stmts).toEqual(['DROP MATERIALIZED VIEW public.mv CASCADE'])
    expect(dropSql('function', 's', 'f', { args: 'integer, text' }).stmts).toEqual(['DROP FUNCTION s.f(integer, text)'])
    expect(dropSql('schema', '', 'App').stmts).toEqual(['DROP SCHEMA "App"'])
    expect(dropSql('database', '', 'x', { force: true })).toEqual({ stmts: ['DROP DATABASE x WITH (FORCE)'], atomic: false, release: 'x' })
    expect(dropKindOf('partitioned')).toBe('table')
    expect(dropKindOf('type')).toBeNull()
  })
  it('renames, truncates and creates', () => {
    expect(renameSql('view', 'public', 'v', 'w').stmts).toEqual(['ALTER VIEW public.v RENAME TO w'])
    expect(renameSql('schema', '', 'a', 'B').stmts).toEqual(['ALTER SCHEMA a RENAME TO "B"'])
    expect(renameSql('database', '', 'a', 'b').atomic).toBe(false)
    expect(truncateSql('public', 'users', { restartIdentity: true, cascade: true }).stmts).toEqual([
      'TRUNCATE TABLE public.users RESTART IDENTITY CASCADE'
    ])
    expect(createSchemaSql('app', 'bob').stmts).toEqual(['CREATE SCHEMA app AUTHORIZATION bob'])
    expect(createDatabaseSql('shop', { owner: 'bob', encoding: 'UTF8' })).toEqual({
      stmts: ["CREATE DATABASE shop OWNER bob ENCODING 'UTF8'"],
      atomic: false
    })
    expect(createViewSql('public', 'v', 'select 1;\n', false).stmts).toEqual(['CREATE OR REPLACE VIEW public.v AS\nselect 1'])
    expect(refreshMatviewSql('public', 'mv', true)).toEqual({
      stmts: ['REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv'],
      atomic: false
    })
  })
  it('speaks MySQL and SQLite', () => {
    expect(dropSql('table', 'shop', 'order', { cascade: true, engine: 'mysql' }).stmts).toEqual(['DROP TABLE shop.`order`'])
    expect(dropSql('procedure', 'shop', 'p', { args: 'int', engine: 'mysql' }).stmts).toEqual(['DROP PROCEDURE shop.p'])
    expect(dropSql('database', '', 'x', { force: true, engine: 'mysql' })).toEqual({ stmts: ['DROP DATABASE x'], atomic: false, release: 'x' })
    expect(dropSql('view', 'main', 'v', { cascade: true, engine: 'sqlite' }).stmts).toEqual(['DROP VIEW main.v'])
    expect(renameSql('table', 'shop', 'a', 'B', undefined, 'mysql').stmts).toEqual(['RENAME TABLE shop.a TO shop.B'])
    expect(renameSql('table', 'main', 'a', 'b c', undefined, 'sqlite').stmts).toEqual(['ALTER TABLE main.a RENAME TO "b c"'])
    expect([canRename('view', 'mysql'), canRename('view', 'sqlite'), canRename('database', 'mysql')]).toEqual([true, false, false])
    expect(truncateSql('shop', 't', { restartIdentity: true, cascade: true, engine: 'mysql' }).stmts).toEqual(['TRUNCATE TABLE shop.t'])
    expect(truncateSql('main', 't', { engine: 'sqlite' }).stmts).toEqual(['DELETE FROM main.t'])
    expect(createDatabaseSql('shop', { owner: 'bob', encoding: 'utf8mb4', engine: 'mysql' }).stmts).toEqual(['CREATE DATABASE shop CHARACTER SET utf8mb4'])
  })
  it('accepts only DDL, per engine', () => {
    expect(isDdl('drop table t')).toBe(true)
    expect(isDdl('rename table a to b')).toBe(false)
    expect(isDdl('rename table a to b', 'mysql')).toBe(true)
    expect(isDdl('DELETE FROM main."t x"', 'sqlite')).toBe(true)
    expect(isDdl('delete from t where 1', 'sqlite')).toBe(false)
    expect(isDdl('delete from t; select 1', 'sqlite')).toBe(false)
    expect(isDdl('delete from t', 'postgres')).toBe(false)
  })
  it('previews statements with semicolons', () => {
    expect(planText({ stmts: ['A', 'B'], atomic: true })).toBe('A;\n\nB;')
  })
})
