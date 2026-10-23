import { slRows } from './sqlite'
import { quoteIdent } from './sqlText'
import { columnId, columnName, tableOf } from './tableIds'
import type { Cell } from './driver'
import type { EditTarget } from './edit'
import type { CompletionMeta } from './complete'
import type { ColumnDetail, ColumnInfo, ConnectionConfig, DbObject, ObjectKind, SchemaInfo, TableInfo } from './types'

// SQLite catalog (sqlite_master and the table-valued pragmas). The file is
// one database; its schemas are `main` plus whatever is attached.

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const qi = (s: string): string => quoteIdent('sqlite', s)
const master = (schema: string): string => `${qi(schema || 'main')}.sqlite_master`
// sqlite_sequence, sqlite_stat1 and autoindexes are SQLite's own.
const USER = `name not like 'sqlite\\_%' escape '\\'`

export async function listDatabases(): Promise<string[]> {
  return ['main']
}

export async function listSchemas(cfg: ConnectionConfig): Promise<SchemaInfo[]> {
  const rows = await slRows(cfg, 'select name from pragma_database_list order by seq')
  return rows.map((r) => str(r[0])).filter((n) => n !== 'temp').map((name) => ({ name, isSystem: false }))
}

export async function listObjects(cfg: ConnectionConfig, _db: string | undefined, schema: string): Promise<DbObject[]> {
  const rows = await slRows(cfg, `select name, type from ${master(schema)} where type in ('table', 'view') and ${USER} order by name`)
  return rows.map((r) => ({ name: str(r[0]), kind: (str(r[1]) === 'view' ? 'view' : 'table') as ObjectKind, rows: null }))
}

async function objectType(cfg: ConnectionConfig, schema: string, name: string): Promise<ObjectKind | null> {
  const r = await slRows(cfg, `select type from ${master(schema)} where name = ? and type in ('table', 'view')`, [name])
  return r.length ? (str(r[0][0]) === 'view' ? 'view' : 'table') : null
}

export async function findSchema(cfg: ConnectionConfig, _db: string | undefined, name: string): Promise<string | null> {
  for (const s of await listSchemas(cfg)) if (await objectType(cfg, s.name, name)) return s.name
  return null
}

interface XColumn {
  name: string
  type: string
  notnull: boolean
  default: string | null
  pk: number
  /** 2: generated virtual, 3: generated stored. */
  hidden: number
}

async function columnsOf(cfg: ConnectionConfig, schema: string, name: string): Promise<XColumn[]> {
  const rows = await slRows(cfg, 'select name, type, "notnull", dflt_value, pk, hidden from pragma_table_xinfo(?, ?) order by cid', [name, schema || 'main'])
  return rows.map((r) => ({
    name: str(r[0]),
    type: str(r[1]).toLowerCase(),
    notnull: Number(r[2]) === 1,
    default: r[3] === null ? null : str(r[3]),
    pk: Number(r[4]),
    hidden: Number(r[5])
  }))
}

const pkCols = (cols: XColumn[]): string[] =>
  cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)

interface IndexRow {
  name: string
  unique: boolean
  origin: string
  cols: string[]
  sql: string | null
}

async function indexesOf(cfg: ConnectionConfig, schema: string, name: string): Promise<IndexRow[]> {
  const s = schema || 'main'
  const [list, cols, sqls] = await Promise.all([
    slRows(cfg, 'select name, "unique", origin from pragma_index_list(?, ?) order by seq', [name, s]),
    slRows(
      cfg,
      `select il.name, ii.name from pragma_index_list(?, ?) il join pragma_index_info(il.name, ?) ii order by il.seq, ii.seqno`,
      [name, s, s]
    ),
    slRows(cfg, `select name, sql from ${master(s)} where type = 'index' and tbl_name = ?`, [name])
  ])
  const sql = new Map(sqls.map((r) => [str(r[0]), r[1] === null ? null : str(r[1])]))
  return list.map((r) => {
    const n = str(r[0])
    return {
      name: n,
      unique: Number(r[1]) === 1,
      origin: str(r[2]),
      // An expression index part has no column name.
      cols: cols.filter((c) => str(c[0]) === n).map((c) => (c[1] === null ? '(expression)' : qi(str(c[1])))),
      sql: sql.get(n) ?? null
    }
  })
}

interface ForeignKey {
  name: string
  cols: string[]
  def: string
}

const FK_ACTION_DEFAULT = ['NO ACTION', 'RESTRICT', '']

async function foreignKeysOf(cfg: ConnectionConfig, schema: string, name: string): Promise<ForeignKey[]> {
  const rows = await slRows(cfg, 'select id, "table", "from", "to", on_update, on_delete from pragma_foreign_key_list(?, ?) order by id, seq', [
    name,
    schema || 'main'
  ])
  const byId = new Map<string, Cell[][]>()
  for (const r of rows) {
    const k = str(r[0])
    byId.set(k, [...(byId.get(k) ?? []), r])
  }
  return [...byId].map(([id, rs]) => {
    const cols = rs.map((r) => str(r[2]))
    // A reference to the parent's primary key leaves `to` empty.
    const to = rs.every((r) => r[3] !== null) ? ` (${rs.map((r) => qi(str(r[3]))).join(', ')})` : ''
    let def = `FOREIGN KEY (${cols.map(qi).join(', ')}) REFERENCES ${qi(str(rs[0][1]))}${to}`
    if (!FK_ACTION_DEFAULT.includes(str(rs[0][4]))) def += ` ON UPDATE ${str(rs[0][4])}`
    if (!FK_ACTION_DEFAULT.includes(str(rs[0][5]))) def += ` ON DELETE ${str(rs[0][5])}`
    return { name: `fk_${id}`, cols, def }
  })
}

export async function tableInfo(cfg: ConnectionConfig, _db: string | undefined, schema: string, name: string): Promise<TableInfo | null> {
  const kind = await objectType(cfg, schema, name)
  if (!kind) return null
  const [cols, idx, fks] = await Promise.all([
    columnsOf(cfg, schema, name),
    kind === 'table' ? indexesOf(cfg, schema, name) : Promise.resolve([]),
    kind === 'table' ? foreignKeysOf(cfg, schema, name) : Promise.resolve([])
  ])
  const pk = pkCols(cols)
  const columns: ColumnInfo[] = cols
    .filter((c) => c.hidden !== 1)
    .map((c) => ({ name: c.name, type: c.type, nullable: !c.notnull && c.pk === 0, default: c.default, comment: null, primaryKey: c.pk > 0 }))
  const t = qi(name)
  const constraints: TableInfo['constraints'] = []
  if (pk.length) constraints.push({ name: 'pk', type: 'primary key', def: `PRIMARY KEY (${pk.map(qi).join(', ')})` })
  for (const i of idx) if (i.origin === 'u') constraints.push({ name: i.name, type: 'unique', def: `UNIQUE (${i.cols.join(', ')})` })
  for (const f of fks) constraints.push({ name: f.name, type: 'foreign key', def: f.def })
  return {
    schema,
    name,
    kind,
    comment: null,
    columns,
    indexes: idx.map((i) => ({
      name: i.name,
      def:
        i.origin === 'pk'
          ? `PRIMARY KEY (${i.cols.join(', ')})`
          : (i.sql ?? `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${qi(i.name)} ON ${t} (${i.cols.join(', ')})`),
      unique: i.unique,
      primary: i.origin === 'pk'
    })),
    constraints
  }
}

/** A result column traced back to its table (ids from tableIds). */
export async function columnDetail(cfg: ConnectionConfig, _db: string | undefined, table: number, attnum: number): Promise<ColumnDetail | null> {
  const t = tableOf(cfg.id, table)
  const col = columnName(table, attnum)
  if (!t || !col) return null
  const [cols, idx, fks] = await Promise.all([columnsOf(cfg, t.schema, t.name), indexesOf(cfg, t.schema, t.name), foreignKeysOf(cfg, t.schema, t.name)])
  const c = cols.find((x) => x.name === col)
  if (!c) return null
  const q = qi(col)
  const pk = pkCols(cols)
  const constraints: ColumnDetail['constraints'] = []
  if (pk.includes(col)) constraints.push({ type: 'p', name: 'pk', def: `PRIMARY KEY (${pk.map(qi).join(', ')})` })
  for (const i of idx) if (i.origin === 'u' && i.cols.includes(q)) constraints.push({ type: 'u', name: i.name, def: `UNIQUE (${i.cols.join(', ')})` })
  for (const f of fks) if (f.cols.includes(col)) constraints.push({ type: 'f', name: f.name, def: f.def })
  // A lone INTEGER PRIMARY KEY is the rowid: it numbers itself.
  const rowid = pk.length === 1 && pk[0] === col && c.type === 'integer'
  return {
    table: `${t.schema}.${t.name}`,
    column: col,
    type: c.type,
    nullable: !c.notnull && c.pk === 0,
    default: c.default,
    comment: null,
    identity: rowid ? 'rowid' : null,
    constraints,
    indexes: idx.filter((i) => i.origin === 'c' && i.cols.includes(q)).map((i) => i.name)
  }
}

/** CREATE statements as stored, with the table's indexes and triggers. */
export async function objectDdl(cfg: ConnectionConfig, _db: string | undefined, schema: string, name: string): Promise<string> {
  const rows = await slRows(
    cfg,
    `select sql from ${master(schema)} where sql is not null and (name = ? or (tbl_name = ? and type in ('index', 'trigger')))
      order by case type when 'table' then 0 when 'view' then 0 when 'index' then 1 else 2 end, name`,
    [name, name]
  )
  if (!rows.length) throw new Error(`No table or view ${schema}.${name}`)
  return rows.map((r) => `${str(r[0]).trimEnd()};\n`).join('\n')
}

/** The table behind a result, for editing its rows in the grid. */
export async function editTarget(cfg: ConnectionConfig, _db: string | undefined, table: number): Promise<EditTarget | null> {
  const t = tableOf(cfg.id, table)
  if (!t) return null
  const kind = await objectType(cfg, t.schema, t.name)
  if (!kind) return null
  const cols = await columnsOf(cfg, t.schema, t.name)
  const keys = pkCols(cols).map((c) => columnId(table, c))
  const okKind = kind === 'table'
  return {
    table,
    schema: t.schema,
    name: t.name,
    editable: okKind && keys.length > 0,
    reason: !okKind ? 'kind' : keys.length ? undefined : 'nopk',
    pk: keys,
    columns: cols
      .filter((c) => c.hidden !== 1)
      .map((c) => ({ attnum: columnId(table, c.name), name: c.name, type: c.type, readOnly: c.hidden === 2 || c.hidden === 3 }))
  }
}

const COMPLETION_TABLES = 3000

/** Names the console autocompletes: every table and view with its columns. */
export async function completionMeta(cfg: ConnectionConfig): Promise<CompletionMeta> {
  const schemas = (await listSchemas(cfg)).map((s) => s.name)
  const tables: CompletionMeta['tables'] = []
  let truncated = false
  for (const s of schemas) {
    const rows = await slRows(
      cfg,
      `select m.name, m.type, p.name, p.type from ${master(s)} m join pragma_table_info(m.name, ?) p
        where m.type in ('table', 'view') and m.${USER} order by m.name, p.cid`,
      [s]
    )
    for (const r of rows) {
      const name = str(r[0])
      let t = tables[tables.length - 1]
      if (!t || t.name !== name || t.schema !== s) {
        if (tables.length >= COMPLETION_TABLES) {
          truncated = true
          break
        }
        tables.push((t = { schema: s, name, kind: str(r[1]) === 'view' ? 'v' : 'r', columns: [] }))
      }
      t.columns.push({ name: str(r[2]), type: str(r[3]).toLowerCase() })
    }
  }
  return { schemas, searchPath: ['main'], tables, functions: [], truncated }
}
