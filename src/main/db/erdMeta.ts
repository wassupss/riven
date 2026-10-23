import { pgRows } from './pg'
import type { ErdModel, ErdTable } from './erd'
import type { ConnectionConfig } from './types'

// Reads one schema's tables, columns and keys for the ER diagram. Tables of
// other schemas that foreign keys point at come along as external nodes.

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
// Name lists come back as JSON text (arrays arrive unparsed).
const list = (v: unknown): string[] => {
  try {
    const a: unknown = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}
const KINDS: Record<string, ErdTable['kind']> = { r: 'table', p: 'partitioned', f: 'foreign' }

export async function erdModel(cfg: ConnectionConfig, db: string | undefined, schema: string): Promise<ErdModel> {
  const rels = await pgRows(
    cfg,
    db,
    `select c.oid::int, c.relname::text, c.relkind::text, obj_description(c.oid, 'pg_class')
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p', 'f') and not c.relispartition
      order by c.relname`,
    [schema]
  )
  const cols = await pgRows(
    cfg,
    db,
    `select a.attrelid::int, a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p', 'f') and not c.relispartition
        and a.attnum > 0 and not a.attisdropped
      order by a.attrelid, a.attnum`,
    [schema]
  )
  const cons = await pgRows(
    cfg,
    db,
    `select k.conname::text, k.contype::text, k.conrelid::int,
            (select json_agg(a.attname::text order by u.ord)::text from unnest(k.conkey) with ordinality u(att, ord)
               join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.att),
            fn.nspname::text, fc.relname::text,
            (select json_agg(a.attname::text order by u.ord)::text from unnest(k.confkey) with ordinality u(att, ord)
               join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.att),
            fc.relkind::text
       from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
       left join pg_class fc on fc.oid = k.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace
      where n.nspname = $1 and k.contype in ('p', 'f') and not c.relispartition
      order by k.conname`,
    [schema]
  )

  const byOid = new Map<number, ErdTable>()
  const tables: ErdTable[] = []
  for (const [oid, name, kind, comment] of rels) {
    const t: ErdTable = { key: str(name), schema, name: str(name), kind: KINDS[str(kind)] ?? 'table', columns: [] }
    if (comment) t.comment = str(comment)
    byOid.set(Number(oid), t)
    tables.push(t)
  }
  for (const [rel, name, type, notNull] of cols)
    byOid.get(Number(rel))?.columns.push({ name: str(name), type: str(type), notNull: notNull === true, pk: false, fk: false })

  const external = new Map<string, ErdTable>()
  const model: ErdModel = { schema, tables, refs: [] }
  for (const [name, type, rel, keyCols, fSchema, fTable, fCols, fKind] of cons) {
    const t = byOid.get(Number(rel))
    if (!t) continue
    const own = list(keyCols)
    const mark = type === 'p' ? 'pk' : 'fk'
    for (const c of t.columns) if (own.includes(c.name)) c[mark] = true
    if (type !== 'f') continue
    const toCols = list(fCols)
    let to = str(fTable)
    if (str(fSchema) !== schema) {
      to = `${str(fSchema)}.${str(fTable)}`
      let x = external.get(to)
      if (!x) {
        x = { key: to, schema: str(fSchema), name: str(fTable), kind: KINDS[str(fKind)] ?? 'table', columns: [], external: true }
        external.set(to, x)
      }
      for (const c of toCols)
        if (!x.columns.some((y) => y.name === c)) x.columns.push({ name: c, type: '', notNull: true, pk: true, fk: false })
    }
    model.refs.push({ name: str(name), from: t.key, fromCols: own, to, toCols })
  }
  tables.push(...[...external.values()].sort((a, b) => a.key.localeCompare(b.key)))
  return model
}
