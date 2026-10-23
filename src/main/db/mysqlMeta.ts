import { myRows } from './mysql'
import { quoteIdent } from './sqlText'
import { columnId, columnName, tableOf } from './tableIds'
import type { EditTarget } from './edit'
import type { CompletionMeta } from './complete'
import type { ColumnDetail, ColumnInfo, ConnectionConfig, DbObject, ObjectKind, SchemaInfo, TableInfo } from './types'

// MySQL / MariaDB catalog (information_schema). A database is its own and
// only schema: the explorer's schema level is the database name.

const SYSTEM_DBS = ['information_schema', 'mysql', 'performance_schema', 'sys']
const TABLE_TYPE: Record<string, ObjectKind> = { 'BASE TABLE': 'table', VIEW: 'view', 'SYSTEM VIEW': 'view', SEQUENCE: 'sequence' }

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const qi = (s: string): string => quoteIdent('mysql', s)
// MariaDB reports a missing default as the text NULL and quotes string defaults.
const defaultOf = (v: unknown): string | null => (v === null || v === undefined || v === 'NULL' ? null : String(v))
const commentOf = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v))

export async function listDatabases(cfg: ConnectionConfig): Promise<string[]> {
  const rows = await myRows(cfg, undefined, 'show databases')
  const names = rows.map((r) => str(r[0]))
  return [...names.filter((n) => !SYSTEM_DBS.includes(n.toLowerCase())), ...names.filter((n) => SYSTEM_DBS.includes(n.toLowerCase()))]
}

export async function listSchemas(cfg: ConnectionConfig, db?: string): Promise<SchemaInfo[]> {
  const name = db || cfg.database
  return name ? [{ name, isSystem: SYSTEM_DBS.includes(name.toLowerCase()) }] : []
}

export async function listObjects(cfg: ConnectionConfig, db: string | undefined, schema: string): Promise<DbObject[]> {
  const [rels, procs] = await Promise.all([
    myRows(
      cfg,
      db,
      `select table_name, table_type, table_comment, table_rows from information_schema.tables
        where table_schema = ? order by table_name`,
      [schema]
    ),
    myRows(
      cfg,
      db,
      `select r.routine_name, r.routine_type, r.dtd_identifier,
              (select group_concat(concat_ws(' ', if(r.routine_type = 'PROCEDURE', p.parameter_mode, null), p.parameter_name, p.dtd_identifier)
                        order by p.ordinal_position separator ', ')
                 from information_schema.parameters p
                where p.specific_schema = r.routine_schema and p.specific_name = r.specific_name and p.ordinal_position > 0)
         from information_schema.routines r where r.routine_schema = ? order by r.routine_name`,
      [schema]
    )
  ])
  return [
    ...rels.map((r) => {
      const kind = TABLE_TYPE[str(r[1])] ?? 'table'
      const est = r[3] === null ? null : Number(r[3])
      return {
        name: str(r[0]),
        kind,
        // Views report the text VIEW as their comment.
        comment: kind === 'view' ? null : commentOf(r[2]),
        rows: kind === 'table' && est !== null && Number.isFinite(est) ? est : null
      }
    }),
    ...procs.map((r) => ({
      name: str(r[0]),
      kind: (str(r[1]) === 'PROCEDURE' ? 'procedure' : 'function') as ObjectKind,
      args: str(r[3]),
      result: str(r[2])
    }))
  ]
}

async function tableType(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<ObjectKind | null> {
  const r = await myRows(cfg, db, 'select table_type from information_schema.tables where table_schema = ? and table_name = ?', [schema, name])
  return r.length ? (TABLE_TYPE[str(r[0][0])] ?? 'table') : null
}

/** Database holding `name`: the current one first. */
export async function findSchema(cfg: ConnectionConfig, db: string | undefined, name: string): Promise<string | null> {
  const cur = db || cfg.database || ''
  const r = await myRows(
    cfg,
    db,
    `select s from (
       select table_schema s from information_schema.tables where table_name = ?
       union all select routine_schema from information_schema.routines where routine_name = ?) x
     order by s = ? desc, s limit 1`,
    [name, name, cur]
  )
  return r.length ? str(r[0][0]) : null
}

interface IndexRow {
  name: string
  unique: boolean
  cols: string[]
}

async function indexesOf(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<IndexRow[]> {
  const rows = await myRows(
    cfg,
    db,
    `select index_name, non_unique, column_name, sub_part from information_schema.statistics
      where table_schema = ? and table_name = ? order by index_name = 'PRIMARY' desc, index_name, seq_in_index`,
    [schema, name]
  )
  const out = new Map<string, IndexRow>()
  for (const r of rows) {
    const n = str(r[0])
    let i = out.get(n)
    if (!i) out.set(n, (i = { name: n, unique: Number(r[1]) === 0, cols: [] }))
    // A functional index part has no column name.
    i.cols.push(r[2] === null ? '(expression)' : qi(str(r[2])) + (r[3] !== null ? `(${str(r[3])})` : ''))
  }
  return [...out.values()]
}

interface ConstraintRow {
  name: string
  type: 'p' | 'f' | 'u' | 'c'
  cols: string[]
  def: string
}

const CONTYPE: Record<string, ConstraintRow['type']> = { 'PRIMARY KEY': 'p', 'FOREIGN KEY': 'f', UNIQUE: 'u', CHECK: 'c' }
const CONTYPE_NAME: Record<ConstraintRow['type'], string> = { p: 'primary key', f: 'foreign key', u: 'unique', c: 'check' }

async function constraintsOf(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<ConstraintRow[]> {
  const args = [schema, name]
  const [cons, keys, checks] = await Promise.all([
    myRows(
      cfg,
      db,
      `select tc.constraint_name, tc.constraint_type, rc.update_rule, rc.delete_rule
         from information_schema.table_constraints tc
         left join information_schema.referential_constraints rc
           on rc.constraint_schema = tc.constraint_schema and rc.constraint_name = tc.constraint_name and rc.table_name = tc.table_name
        where tc.table_schema = ? and tc.table_name = ? order by tc.constraint_type, tc.constraint_name`,
      args
    ),
    myRows(
      cfg,
      db,
      `select constraint_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name
         from information_schema.key_column_usage where table_schema = ? and table_name = ? order by constraint_name, ordinal_position`,
      args
    ),
    // check_constraints exists from MySQL 8.0.16 / MariaDB 10.2.
    myRows(
      cfg,
      db,
      `select cc.constraint_name, cc.check_clause from information_schema.check_constraints cc
         join information_schema.table_constraints tc
           on tc.constraint_schema = cc.constraint_schema and tc.constraint_name = cc.constraint_name and tc.constraint_type = 'CHECK'
        where tc.table_schema = ? and tc.table_name = ?`,
      args
    ).catch(() => [] as unknown[][])
  ])
  const check = new Map(checks.map((r) => [str(r[0]), str(r[1])]))
  return cons.flatMap((r): ConstraintRow[] => {
    const cname = str(r[0])
    const type = CONTYPE[str(r[1])]
    if (!type) return []
    const ks = keys.filter((k) => str(k[0]) === cname)
    const cols = ks.map((k) => str(k[1]))
    const list = cols.map(qi).join(', ')
    let def: string
    if (type === 'c') def = `CHECK (${check.get(cname) ?? ''})`
    else if (type === 'p') def = `PRIMARY KEY (${list})`
    else if (type === 'u') def = `UNIQUE (${list})`
    else {
      const ref = ks[0]
      const target = ref && str(ref[2]) !== schema ? `${qi(str(ref[2]))}.${qi(str(ref[3]))}` : qi(str(ref?.[3]))
      def = `FOREIGN KEY (${list}) REFERENCES ${target} (${ks.map((k) => qi(str(k[4]))).join(', ')})`
      if (r[2] && r[2] !== 'RESTRICT' && r[2] !== 'NO ACTION') def += ` ON UPDATE ${str(r[2])}`
      if (r[3] && r[3] !== 'RESTRICT' && r[3] !== 'NO ACTION') def += ` ON DELETE ${str(r[3])}`
    }
    return [{ name: cname, type, cols, def }]
  })
}

export async function tableInfo(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<TableInfo | null> {
  const kind = await tableType(cfg, db, schema, name)
  if (!kind) return null
  const [cols, idx, cons, cmt] = await Promise.all([
    myRows(
      cfg,
      db,
      `select column_name, column_type, is_nullable, column_default, column_comment, column_key
         from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
      [schema, name]
    ),
    indexesOf(cfg, db, schema, name),
    constraintsOf(cfg, db, schema, name),
    myRows(cfg, db, 'select table_comment from information_schema.tables where table_schema = ? and table_name = ?', [schema, name])
  ])
  const columns: ColumnInfo[] = cols.map((r) => ({
    name: str(r[0]),
    type: str(r[1]),
    nullable: r[2] === 'YES',
    default: defaultOf(r[3]),
    comment: commentOf(r[4]),
    primaryKey: r[5] === 'PRI'
  }))
  const t = qi(name)
  return {
    schema,
    name,
    kind,
    comment: kind === 'view' ? null : commentOf(cmt[0]?.[0]),
    columns,
    indexes: idx.map((i) => ({
      name: i.name,
      def: i.name === 'PRIMARY' ? `PRIMARY KEY (${i.cols.join(', ')})` : `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${qi(i.name)} ON ${t} (${i.cols.join(', ')})`,
      unique: i.unique,
      primary: i.name === 'PRIMARY'
    })),
    constraints: cons.map((c) => ({ name: c.name, type: CONTYPE_NAME[c.type], def: c.def }))
  }
}

/** A result column traced back to its table (ids from tableIds). */
export async function columnDetail(cfg: ConnectionConfig, db: string | undefined, table: number, attnum: number): Promise<ColumnDetail | null> {
  const t = tableOf(cfg.id, table)
  const col = columnName(table, attnum)
  if (!t || !col) return null
  const [cols, cons, idx] = await Promise.all([
    myRows(
      cfg,
      db,
      `select column_type, is_nullable, column_default, column_comment, extra
         from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?`,
      [t.schema, t.name, col]
    ),
    constraintsOf(cfg, db, t.schema, t.name),
    indexesOf(cfg, db, t.schema, t.name)
  ])
  const r = cols[0]
  if (!r) return null
  const extra = str(r[4]).toLowerCase()
  const q = qi(col)
  return {
    table: `${t.schema}.${t.name}`,
    column: col,
    type: str(r[0]),
    nullable: r[1] === 'YES',
    default: defaultOf(r[2]),
    comment: commentOf(r[3]),
    identity: extra.includes('auto_increment') ? 'auto_increment' : null,
    constraints: cons.filter((c) => c.cols.includes(col) || (c.type === 'c' && c.def.includes(col))).map((c) => ({ type: c.type, name: c.name, def: c.def })),
    indexes: idx.filter((i) => i.name !== 'PRIMARY' && i.cols.some((c) => c === q || c.startsWith(q + '('))).map((i) => i.name)
  }
}

/** CREATE statement as the server prints it. */
export async function objectDdl(cfg: ConnectionConfig, db: string | undefined, schema: string, name: string): Promise<string> {
  const full = `${qi(schema)}.${qi(name)}`
  const kind = await tableType(cfg, db, schema, name)
  const show = async (what: string, col: number): Promise<string> => {
    const r = await myRows(cfg, db, `show create ${what} ${full}`)
    return `${str(r[0]?.[col]).trimEnd()};\n`
  }
  if (kind === 'view') return show('view', 1)
  if (kind === 'sequence') return show('sequence', 1)
  if (kind) return show('table', 1)
  const routines = await myRows(cfg, db, 'select routine_type from information_schema.routines where routine_schema = ? and routine_name = ?', [schema, name])
  if (!routines.length) throw new Error(`No table, view or routine ${schema}.${name}`)
  const out: string[] = []
  for (const r of routines) {
    const type = str(r[0]).toLowerCase()
    // Without the privilege to see the body the server returns NULL.
    const body = (await myRows(cfg, db, `show create ${type} ${full}`))[0]?.[2]
    out.push(body === null || body === undefined ? `-- The body of ${type} ${full} is not visible to this user\n` : `DELIMITER $$\n${str(body).trimEnd()}$$\nDELIMITER ;\n`)
  }
  return out.join('\n')
}

/** The table behind a result, for editing its rows in the grid. */
export async function editTarget(cfg: ConnectionConfig, db: string | undefined, table: number): Promise<EditTarget | null> {
  const t = tableOf(cfg.id, table)
  if (!t) return null
  const [type, cols, pk] = await Promise.all([
    tableType(cfg, db, t.schema, t.name),
    myRows(
      cfg,
      db,
      `select column_name, column_type, extra from information_schema.columns
        where table_schema = ? and table_name = ? order by ordinal_position`,
      [t.schema, t.name]
    ),
    myRows(
      cfg,
      db,
      `select column_name from information_schema.statistics
        where table_schema = ? and table_name = ? and index_name = 'PRIMARY' order by seq_in_index`,
      [t.schema, t.name]
    )
  ])
  if (!type) return null
  const keys = pk.map((r) => columnId(table, str(r[0])))
  const okKind = type === 'table'
  return {
    table,
    schema: t.schema,
    name: t.name,
    editable: okKind && keys.length > 0,
    reason: !okKind ? 'kind' : keys.length ? undefined : 'nopk',
    pk: keys,
    columns: cols.map((r) => ({
      attnum: columnId(table, str(r[0])),
      name: str(r[0]),
      type: str(r[1]),
      // Generated columns can't be written (VIRTUAL / STORED / PERSISTENT GENERATED).
      readOnly: /generated|persistent/i.test(str(r[2]))
    }))
  }
}

const COMPLETION_TABLES = 3000
const COMPLETION_COLUMNS = 60_000

/** Names the console autocompletes: every user database's tables and routines. */
export async function completionMeta(cfg: ConnectionConfig, db: string | undefined): Promise<CompletionMeta> {
  const hidden = `not in (${SYSTEM_DBS.map((s) => `'${s}'`).join(', ')})`
  const [schemas, tables, cols, fns] = await Promise.all([
    myRows(cfg, db, `select schema_name from information_schema.schemata where schema_name ${hidden} order by 1`),
    myRows(
      cfg,
      db,
      `select table_schema, table_name, table_type from information_schema.tables
        where table_schema ${hidden} order by table_schema, table_name limit ${COMPLETION_TABLES + 1}`
    ),
    myRows(
      cfg,
      db,
      `select table_schema, table_name, column_name, column_type from information_schema.columns
        where table_schema ${hidden} order by table_schema, table_name, ordinal_position limit ${COMPLETION_COLUMNS}`
    ),
    myRows(
      cfg,
      db,
      `select concat(routine_schema, '.', routine_name) from information_schema.routines where routine_schema ${hidden} order by 1 limit 2000`
    )
  ])
  const byTable = new Map<string, Array<{ name: string; type: string }>>()
  for (const r of cols) {
    const k = `${str(r[0])}\u0000${str(r[1])}`
    let l = byTable.get(k)
    if (!l) byTable.set(k, (l = []))
    l.push({ name: str(r[2]), type: str(r[3]) })
  }
  const cur = db || cfg.database || ''
  return {
    schemas: schemas.map((r) => str(r[0])),
    searchPath: cur ? [cur] : [],
    tables: tables.slice(0, COMPLETION_TABLES).map((r) => ({
      schema: str(r[0]),
      name: str(r[1]),
      kind: str(r[2]) === 'BASE TABLE' ? 'r' : 'v',
      columns: byTable.get(`${str(r[0])}\u0000${str(r[1])}`) ?? []
    })),
    functions: fns.map((r) => str(r[0])),
    truncated: tables.length > COMPLETION_TABLES
  }
}
