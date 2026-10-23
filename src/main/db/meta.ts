import { pgRows } from './pg'
import { literal, quoteIdent } from './sqlText'
import type { ColumnDetail, ColumnInfo, ConnectionConfig, DbObject, ObjectKind, SchemaInfo, TableInfo } from './types'

// PostgreSQL catalog queries.

const REL_OID =
  '(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2)'

const RELKIND: Record<string, ObjectKind> = {
  r: 'table',
  p: 'partitioned',
  v: 'view',
  m: 'matview',
  f: 'foreign',
  S: 'sequence'
}
const PROKIND: Record<string, ObjectKind> = { p: 'procedure', a: 'aggregate', w: 'window' }
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema']

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const qi = (s: string): string => quoteIdent('postgres', s)

export async function listDatabases(cfg: ConnectionConfig): Promise<string[]> {
  const rows = await pgRows(cfg, undefined, 'select datname::text from pg_database where datallowconn and not datistemplate order by datname')
  return rows.map((r) => str(r[0]))
}

export async function listSchemas(cfg: ConnectionConfig, db?: string): Promise<SchemaInfo[]> {
  const rows = await pgRows(
    cfg,
    db,
    `select nspname::text from pg_namespace
     where nspname not like 'pg_toast%' and nspname not like 'pg_temp_%'
     order by (nspname in ('pg_catalog','information_schema')), nspname`
  )
  return rows.map((r) => ({ name: str(r[0]), isSystem: SYSTEM_SCHEMAS.includes(str(r[0])) }))
}

export async function listObjects(cfg: ConnectionConfig, db: string | undefined, schema: string): Promise<DbObject[]> {
  const rels = await pgRows(
    cfg,
    db,
    `select c.relname::text, c.relkind::text, obj_description(c.oid, 'pg_class'), c.reltuples::float8
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r','p','v','m','f','S') and not c.relispartition
     order by c.relname`,
    [schema]
  )
  const procs = await pgRows(
    cfg,
    db,
    `select p.proname::text, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prokind::text
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = $1 order by p.proname`,
    [schema]
  )
  return [
    ...rels.map((r) => {
      const est = typeof r[3] === 'number' ? r[3] : null
      return {
        name: str(r[0]),
        kind: RELKIND[str(r[1])] ?? 'table',
        comment: strOrNull(r[2]),
        rows: est !== null && est >= 0 ? Math.round(est) : null
      }
    }),
    ...procs.map((r) => ({
      name: str(r[0]),
      kind: PROKIND[str(r[3])] ?? ('function' as ObjectKind),
      args: str(r[1]),
      result: strOrNull(r[2]) ?? ''
    }))
  ]
}

/** Relation kind of schema.name, or null when it isn't a relation. */
async function relKind(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<ObjectKind | null> {
  const r = await pgRows(cfg, db, `select relkind::text from pg_class where oid = ${REL_OID}`, [schema, name])
  return r.length ? (RELKIND[str(r[0][0])] ?? 'table') : null
}

/** Schema holding `name`, preferring the first match on the search path. */
export async function findSchema(cfg: ConnectionConfig, db: string | undefined, name: string): Promise<string | null> {
  const r = await pgRows(
    cfg,
    db,
    `select n.nspname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relname = $1 and c.relkind in ('r','p','v','m','f','S')
     order by array_position(current_schemas(false), n.nspname::name) nulls last, n.nspname limit 1`,
    [name]
  )
  if (r.length) return str(r[0][0])
  const p = await pgRows(
    cfg,
    db,
    `select n.nspname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.proname = $1 order by array_position(current_schemas(false), n.nspname::name) nulls last limit 1`,
    [name]
  )
  return p.length ? str(p[0][0]) : null
}

export async function tableInfo(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<TableInfo | null> {
  const kind = await relKind(cfg, db, schema, name)
  if (!kind) return null
  const args = [schema, name]
  const [cols, idx, cons, cmt] = await Promise.all([
    pgRows(
      cfg,
      db,
      `select a.attname::text, format_type(a.atttypid, a.atttypmod), not a.attnotnull,
              pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum),
              coalesce(a.attnum = any(pk.conkey), false)
       from pg_attribute a
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       left join pg_constraint pk on pk.conrelid = a.attrelid and pk.contype = 'p'
       where a.attrelid = ${REL_OID} and a.attnum > 0 and not a.attisdropped
       order by a.attnum`,
      args
    ),
    pgRows(
      cfg,
      db,
      `select i.relname::text, pg_get_indexdef(ix.indexrelid), ix.indisunique, ix.indisprimary
       from pg_index ix join pg_class i on i.oid = ix.indexrelid
       where ix.indrelid = ${REL_OID} order by ix.indisprimary desc, i.relname`,
      args
    ),
    pgRows(
      cfg,
      db,
      `select conname::text, contype::text, pg_get_constraintdef(oid) from pg_constraint
       where conrelid = ${REL_OID} and contype in ('p','f','u','c') order by contype, conname`,
      args
    ),
    pgRows(cfg, db, `select obj_description(${REL_OID}, 'pg_class')`, args)
  ])
  const columns: ColumnInfo[] = cols.map((r) => ({
    name: str(r[0]),
    type: str(r[1]),
    nullable: r[2] === true,
    default: strOrNull(r[3]),
    comment: strOrNull(r[4]),
    primaryKey: r[5] === true
  }))
  const CONTYPE: Record<string, string> = { p: 'primary key', f: 'foreign key', u: 'unique', c: 'check' }
  return {
    schema,
    name,
    kind,
    comment: strOrNull(cmt[0]?.[0]),
    columns,
    indexes: idx.map((r) => ({ name: str(r[0]), def: str(r[1]), unique: r[2] === true, primary: r[3] === true })),
    constraints: cons.map((r) => ({ name: str(r[0]), type: CONTYPE[str(r[1])] ?? str(r[1]), def: str(r[2]) }))
  }
}

/** CREATE statement for a relation or routine. */
/** A result column traced back to its table (pg field tableID / columnID). */
export async function columnDetail(cfg: ConnectionConfig, db: string | undefined, table: number, attnum: number): Promise<ColumnDetail | null> {
  const [cols, cons, idx] = await Promise.all([
    pgRows(
      cfg,
      db,
      `select n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), not a.attnotnull,
              pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), a.attidentity::text
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = $1 and a.attnum = $2 and not a.attisdropped`,
      [table, attnum]
    ),
    pgRows(
      cfg,
      db,
      `select contype::text, conname::text, pg_get_constraintdef(oid) from pg_constraint
       where conrelid = $1 and $2::int2 = any(conkey) order by contype, conname`,
      [table, attnum]
    ),
    pgRows(
      cfg,
      db,
      `select i.relname::text from pg_index ix join pg_class i on i.oid = ix.indexrelid
       where ix.indrelid = $1 and $2::int2 = any(ix.indkey::int2[]) and not ix.indisprimary order by i.relname`,
      [table, attnum]
    )
  ])
  const r = cols[0]
  if (!r) return null
  const ident = str(r[7])
  return {
    table: `${str(r[0])}.${str(r[1])}`,
    column: str(r[2]),
    type: str(r[3]),
    nullable: r[4] === true,
    default: strOrNull(r[5]),
    comment: strOrNull(r[6]),
    identity: ident === 'a' ? 'always' : ident === 'd' ? 'by default' : null,
    constraints: cons.map((c) => ({ type: str(c[0]) as ColumnDetail['constraints'][number]['type'], name: str(c[1]), def: str(c[2]) })),
    indexes: idx.map((i) => str(i[0]))
  }
}

export async function objectDdl(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<string> {
  const full = `${qi(schema)}.${qi(name)}`
  const kind = await relKind(cfg, db, schema, name)
  if (kind === 'view' || kind === 'matview') {
    const r = await pgRows(cfg, db, `select pg_get_viewdef(${REL_OID}, true)`, [schema, name])
    const head = kind === 'view' ? 'CREATE OR REPLACE VIEW' : 'CREATE MATERIALIZED VIEW'
    return `${head} ${full} AS\n${str(r[0]?.[0]).trimEnd().replace(/;+$/, '')};\n`
  }
  if (kind === 'sequence') {
    const r = await pgRows(
      cfg,
      db,
      `select start_value::text, increment_by::text, min_value::text, max_value::text, cycle, cache_size::text
       from pg_sequences where schemaname = $1 and sequencename = $2`,
      [schema, name]
    )
    const s = r[0] ?? []
    return (
      `CREATE SEQUENCE ${full}\n    START WITH ${str(s[0])}\n    INCREMENT BY ${str(s[1])}\n` +
      `    MINVALUE ${str(s[2])}\n    MAXVALUE ${str(s[3])}\n    CACHE ${str(s[5])}${s[4] === true ? '\n    CYCLE' : ''};\n`
    )
  }
  if (!kind) {
    const defs = await pgRows(
      cfg,
      db,
      `select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = $1 and p.proname = $2 and p.prokind in ('f','p') order by p.oid`,
      [schema, name]
    )
    if (!defs.length) throw new Error(`No table, view, sequence or function ${schema}.${name}`)
    return defs.map((r) => `${str(r[0]).trimEnd()};\n`).join('\n')
  }
  const d = (await tableInfo(cfg, db, schema, name))!
  const lines = d.columns.map((c) => {
    let l = `    ${qi(c.name)} ${c.type}`
    if (c.default !== null) l += ` DEFAULT ${c.default}`
    if (!c.nullable) l += ' NOT NULL'
    return l
  })
  for (const c of d.constraints) lines.push(`    CONSTRAINT ${qi(c.name)} ${c.def}`)
  let out = `CREATE TABLE ${full}\n(\n${lines.join(',\n')}\n);\n`
  // Indexes a constraint created are already covered by the CONSTRAINT lines.
  const conNames = new Set(d.constraints.map((c) => c.name))
  for (const i of d.indexes.filter((i) => !conNames.has(i.name))) out += `\n${i.def};\n`
  if (d.comment !== null) out += `\nCOMMENT ON TABLE ${full} IS ${literal('postgres', d.comment)};\n`
  for (const c of d.columns.filter((c) => c.comment !== null))
    out += `COMMENT ON COLUMN ${full}.${qi(c.name)} IS ${literal('postgres', c.comment)};\n`
  return out
}
