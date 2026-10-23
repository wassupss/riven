import { describe, expect, it } from 'vitest'
import { buildMigration, diffSchemas, migrationPlan, migrationScript, type SchemaSnapshot, type SnapColumn, type SnapRoutine, type SnapTable, type SnapView } from './schemaDiff'

const col = (name: string, type = 'integer', o: Partial<SnapColumn> = {}): SnapColumn => ({
  name,
  type,
  notNull: false,
  default: null,
  identity: '',
  generated: null,
  comment: null,
  ...o
})
const table = (name: string, o: Partial<SnapTable> = {}): SnapTable => ({
  name,
  partitioned: false,
  unlogged: false,
  partKey: null,
  columns: [col('id', 'integer', { notNull: true })],
  constraints: [{ name: `${name}_pkey`, type: 'p', def: 'PRIMARY KEY (id)' }],
  indexes: [],
  triggers: [],
  comment: null,
  ...o
})
const view = (name: string, def: string, cols: string[], o: Partial<SnapView> = {}): SnapView => ({
  name,
  materialized: false,
  def,
  columns: cols.map((c) => ({ name: c, type: 'integer' })),
  indexes: [],
  comment: null,
  order: 0,
  ...o
})
const fn = (name: string, body: string, o: Partial<SnapRoutine> = {}): SnapRoutine => ({
  name,
  procedure: false,
  args: 'i integer',
  argsFull: 'i integer',
  result: 'integer',
  def: `CREATE OR REPLACE FUNCTION ${name}(i integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$${body}$function$\n`,
  comment: null,
  ...o
})
const snap = (schema: string, o: Partial<SchemaSnapshot> = {}): SchemaSnapshot => ({ schema, tables: [], views: [], sequences: [], enums: [], routines: [], ...o })
const migrate = (s: SchemaSnapshot, t: SchemaSnapshot): string[] => buildMigration(s, t, diffSchemas(s, t).map((i) => i.key)).stmts

describe('diffSchemas', () => {
  it('finds nothing between equal schemas, whatever they are called', () => {
    const a = snap('a', { tables: [table('users')], routines: [fn('f', 'select 1')] })
    expect(diffSchemas(a, { ...a, schema: 'b' })).toEqual([])
  })
  it('classifies added, removed and changed objects', () => {
    const s = snap('s', { tables: [table('users', { comment: 'people' }), table('posts')] })
    const t = snap('t', { tables: [table('users'), table('old')] })
    const items = diffSchemas(s, t)
    expect(items.map((i) => [i.key, i.status, i.destructive])).toEqual([
      ['table:old', 'removed', true],
      ['table:posts', 'added', false],
      ['table:users', 'changed', false]
    ])
    expect(items[1].target).toBe('')
    expect(items[1].source).toContain('CREATE TABLE posts (')
    expect(items[2].source).toContain("COMMENT ON TABLE users IS 'people';")
  })
  it('keeps views, sequences and routines apart and in order', () => {
    const s = snap('s', {
      enums: [{ name: 'mood', labels: ['a'], comment: null }],
      views: [view('v2', 'SELECT 2', ['x'], { order: 2 }), view('v1', 'SELECT 1', ['x'], { order: 1 })],
      routines: [fn('f', 'select 1'), fn('f', 'select 2', { args: 'i bigint', argsFull: 'i bigint' })]
    })
    expect(diffSchemas(s, snap('t')).map((i) => i.key)).toEqual(['enum:mood', 'view:v1', 'view:v2', 'function:f(i bigint)', 'function:f(i integer)'])
  })
})

describe('buildMigration: tables', () => {
  it('creates new tables with their constraints added after every table exists', () => {
    const users = table('users')
    const posts = table('posts', {
      columns: [col('id', 'integer', { notNull: true }), col('user_id', 'integer', { notNull: true }), col('n', 'integer', { default: 'add1(1)' })],
      constraints: [
        { name: 'posts_pkey', type: 'p', def: 'PRIMARY KEY (id)' },
        { name: 'posts_user_fk', type: 'f', def: 'FOREIGN KEY (user_id) REFERENCES users(id)' }
      ],
      indexes: [{ name: 'posts_user', def: 'CREATE INDEX posts_user ON posts USING btree (user_id)' }]
    })
    const stmts = migrate(snap('s', { tables: [posts, users], routines: [fn('add1', 'select i + 1')] }), snap('t'))
    expect(stmts[0]).toBe('CREATE TABLE t.posts (\n    id integer NOT NULL,\n    user_id integer NOT NULL,\n    n integer\n)')
    expect(stmts[1]).toMatch(/^CREATE TABLE t.users/)
    const at = (s: string): number => stmts.findIndex((x) => x.startsWith(s))
    // The default calls a routine, so it waits until the routine exists.
    expect(at('CREATE OR REPLACE FUNCTION add1')).toBeLessThan(at('ALTER TABLE t.posts ALTER COLUMN n SET DEFAULT add1(1)'))
    expect(at('ALTER TABLE t.users ADD CONSTRAINT users_pkey')).toBeLessThan(at('ALTER TABLE t.posts ADD CONSTRAINT posts_user_fk'))
    expect(stmts).toContain('CREATE INDEX posts_user ON posts USING btree (user_id)')
  })
  it('alters columns in place: type, null, default, identity', () => {
    const s = table('users', {
      columns: [
        col('id', 'bigint', { notNull: true, identity: 'a' }),
        col('email', 'character varying(200)', { notNull: true }),
        col('n', 'integer', { default: '5' }),
        col('added', 'text')
      ]
    })
    const t = table('users', {
      columns: [col('id', 'integer', { notNull: true, default: "nextval('users_id_seq'::regclass)" }), col('email', 'text'), col('n', 'integer', { default: '1', notNull: true }), col('gone', 'text')]
    })
    const m = buildMigration(snap('s', { tables: [s] }), snap('t', { tables: [t] }), ['table:users'])
    const a = (x: string): string => `ALTER TABLE t.users ${x}`
    expect(m.stmts).toEqual([
      a('DROP COLUMN gone'),
      a('ALTER COLUMN id DROP DEFAULT'),
      a('ALTER COLUMN id TYPE bigint USING id::bigint'),
      a('ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY'),
      a('ALTER COLUMN email TYPE character varying(200) USING email::character varying(200)'),
      a('ALTER COLUMN email SET NOT NULL'),
      a('ALTER COLUMN n DROP DEFAULT'),
      a('ALTER COLUMN n DROP NOT NULL'),
      a('ADD COLUMN added text'),
      a('ALTER COLUMN n SET DEFAULT 5')
    ])
    expect(m.destructive).toBe(3)
  })
  it('re-adds a changed constraint and recreates a changed generated column', () => {
    const s = table('t1', {
      columns: [col('id', 'integer', { notNull: true }), col('g', 'integer', { generated: '(id * 2)' })],
      constraints: [{ name: 'c', type: 'c', def: 'CHECK (id > 1)' }]
    })
    const t = table('t1', {
      columns: [col('id', 'integer', { notNull: true }), col('g', 'integer', { generated: 'id' })],
      constraints: [{ name: 'c', type: 'c', def: 'CHECK (id > 0)' }]
    })
    expect(migrate(snap('s', { tables: [s] }), snap('t', { tables: [t] }))).toEqual([
      'ALTER TABLE t.t1 DROP CONSTRAINT c',
      'ALTER TABLE t.t1 DROP COLUMN g',
      'ALTER TABLE t.t1 ADD COLUMN g integer GENERATED ALWAYS AS ((id * 2)) STORED',
      'ALTER TABLE t.t1 ADD CONSTRAINT c CHECK (id > 1)'
    ])
  })
  it('drops removed tables after their foreign keys and warns on partitioning', () => {
    const t = table('old', { constraints: [{ name: 'old_fk', type: 'f', def: 'FOREIGN KEY (id) REFERENCES x(id)' }], triggers: [{ name: 'tg', def: 'CREATE TRIGGER tg ...' }] })
    expect(migrate(snap('s'), snap('t', { tables: [t] }))).toEqual([
      'DROP TRIGGER IF EXISTS tg ON t.old',
      'ALTER TABLE t.old DROP CONSTRAINT IF EXISTS old_fk',
      'DROP TABLE IF EXISTS t.old'
    ])
    const m = buildMigration(snap('s', { tables: [table('p', { partitioned: true, partKey: 'RANGE (id)' })] }), snap('t', { tables: [table('p')] }), ['table:p'])
    expect(m.warnings).toEqual(['p: partitioning differs; recreate the table to change it'])
  })
  it('only includes picked objects', () => {
    const s = snap('s', { tables: [table('a'), table('b')] })
    expect(buildMigration(s, snap('t'), ['table:b']).stmts.map((x) => x.split('\n')[0])).toEqual(['CREATE TABLE t.b (', 'ALTER TABLE t.b ADD CONSTRAINT b_pkey PRIMARY KEY (id)'])
  })
})

describe('buildMigration: other objects', () => {
  it('replaces a view whose columns only grow, and recreates otherwise', () => {
    const t = snap('t', { views: [view('v', 'SELECT id', ['id'])] })
    expect(migrate(snap('s', { views: [view('v', 'SELECT id, name', ['id', 'name'])] }), t)).toEqual(['CREATE OR REPLACE VIEW t.v AS\nSELECT id, name'])
    expect(migrate(snap('s', { views: [view('v', 'SELECT name', ['name'])] }), t)).toEqual(['DROP VIEW IF EXISTS t.v', 'CREATE VIEW t.v AS\nSELECT name'])
  })
  it('drops dependent views first and creates them last', () => {
    const t = snap('t', { views: [view('a', 'SELECT 1', ['x'], { order: 1 }), view('b', 'SELECT x FROM a', ['x'], { order: 2 })] })
    const s = snap('s', { views: [view('a', 'SELECT 1, 2', ['y'], { order: 1 }), view('b', 'SELECT y FROM a', ['y'], { order: 2 })] })
    expect(migrate(s, t)).toEqual(['DROP VIEW IF EXISTS t.b', 'DROP VIEW IF EXISTS t.a', 'CREATE VIEW t.a AS\nSELECT 1, 2', 'CREATE VIEW t.b AS\nSELECT y FROM a'])
  })
  it('adds matview indexes after the view', () => {
    const mv = view('mv', 'SELECT 1 AS x', ['x'], { materialized: true, indexes: [{ name: 'mv_x', def: 'CREATE INDEX mv_x ON mv USING btree (x)' }] })
    expect(migrate(snap('s', { views: [mv] }), snap('t'))).toEqual(['CREATE MATERIALIZED VIEW t.mv AS\nSELECT 1 AS x', 'CREATE INDEX mv_x ON mv USING btree (x)'])
  })
  it('adds enum values in place and warns about removals', () => {
    const e = (labels: string[]): SchemaSnapshot['enums'] => [{ name: 'mood', labels, comment: null }]
    expect(migrate(snap('s', { enums: e(['new', 'sad', 'meh', 'ok', 'happy']) }), snap('t', { enums: e(['sad', 'ok']) }))).toEqual([
      `ALTER TYPE t.mood ADD VALUE IF NOT EXISTS 'new' BEFORE 'sad'`,
      `ALTER TYPE t.mood ADD VALUE IF NOT EXISTS 'meh' AFTER 'sad'`,
      `ALTER TYPE t.mood ADD VALUE IF NOT EXISTS 'happy' AFTER 'ok'`
    ])
    const warn = buildMigration(snap('s', { enums: e(['ok', 'sad']) }), snap('t', { enums: e(['sad', 'ok']) }), ['enum:mood']).warnings
    expect(warn).toHaveLength(1)
    expect(buildMigration(snap('s', { enums: e(['sad']) }), snap('t', { enums: e(['sad', 'ok']) }), ['enum:mood']).warnings).toHaveLength(1)
  })
  it('alters sequences and sets ownership late', () => {
    const q = { name: 'q', type: 'bigint', start: '1', increment: '1', min: '1', max: '9223372036854775807', cache: '1', cycle: false, ownedBy: null }
    expect(migrate(snap('s', { sequences: [{ ...q, increment: '5', cycle: true, ownedBy: 'users.id' }] }), snap('t', { sequences: [q] }))).toEqual([
      'ALTER SEQUENCE t.q INCREMENT BY 5 CYCLE',
      'ALTER SEQUENCE t.q OWNED BY users.id'
    ])
  })
  it('replaces routine bodies and drops first when the signature changes', () => {
    const t = snap('t', { routines: [fn('f', 'select 1')] })
    expect(migrate(snap('s', { routines: [fn('f', 'select 2')] }), t)).toEqual([fn('f', 'select 2').def.trimEnd()])
    const changed = fn('f', 'select 2', { result: 'bigint' })
    expect(migrate(snap('s', { routines: [changed] }), t)).toEqual(['DROP FUNCTION t.f(i integer)', changed.def.trimEnd()])
    expect(migrate(snap('s'), t)).toEqual(['DROP FUNCTION IF EXISTS t.f(i integer)'])
  })
})

describe('migration output', () => {
  const m = { stmts: ['CREATE TABLE "My".a (id int)', 'DROP TABLE "My".b'], warnings: ['careful'], destructive: 1 }
  it('runs in one transaction on the target schema', () => {
    expect(migrationPlan(m, 'My')).toEqual({ stmts: m.stmts, atomic: true, searchPath: 'My' })
  })
  it('writes a script with the same settings', () => {
    expect(migrationScript(m, 'My')).toBe(
      '-- Migration for schema My\n-- WARNING: careful\nBEGIN;\nSET LOCAL search_path = "My";\nSET LOCAL check_function_bodies = off;\n\nCREATE TABLE "My".a (id int);\n\nDROP TABLE "My".b;\n\nCOMMIT;\n'
    )
  })
})
