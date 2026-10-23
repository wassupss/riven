// Numeric ids for the tables and columns behind a result, for engines without
// oids (MySQL, SQLite). The grid keys editing and the column menu on
// QueryColumn.table/attnum; these stand in for pg's table oid and attnum. Ids
// live for the process and are only ever compared, never stored.

interface TableRef {
  conn: string
  schema: string
  name: string
  columns: Map<string, number>
}

const byKey = new Map<string, number>()
const byId = new Map<number, TableRef>()

export function tableId(conn: string, schema: string, name: string): number {
  const key = `${conn}\u0000${schema}\u0000${name}`
  let id = byKey.get(key)
  if (id === undefined) {
    id = byKey.size + 1
    byKey.set(key, id)
    byId.set(id, { conn, schema, name, columns: new Map() })
  }
  return id
}

/** The column's number in its table (by name; stable for the process). */
export function columnId(table: number, column: string): number {
  const t = byId.get(table)
  if (!t) return 0
  let n = t.columns.get(column)
  if (n === undefined) {
    n = t.columns.size + 1
    t.columns.set(column, n)
  }
  return n
}

/** The table an id stands for, if it was made for this connection. */
export function tableOf(conn: string, table: number): { schema: string; name: string } | null {
  const t = byId.get(table)
  return t && t.conn === conn ? { schema: t.schema, name: t.name } : null
}

/** Column name for a number, if known. */
export function columnName(table: number, attnum: number): string | null {
  const t = byId.get(table)
  if (!t) return null
  for (const [name, n] of t.columns) if (n === attnum) return name
  return null
}
