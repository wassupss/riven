import { pgCancel, pgQuery, pgRows } from './pg'
import { SEARCH_MAX_PER_TABLE, searchSql, type SearchHit, type SearchOptions, type SearchProgress, type SearchSummary, type SearchTable } from './dataSearchSql'
import type { ConnectionConfig } from './types'

export * from './dataSearchSql'

// Full data search: every table of the chosen schemas is scanned for a value,
// a few tables at a time, each scan read-only with its own timeout and row cap.
// Hits stream back table by table; cancel stops the queue and the running scans.

const CONCURRENCY = 3

// Text-like columns (domains resolve to their base type): strings, json, xml, uuid.
const TEXT_LIKE = `(bt.typcategory = 'S' or bt.typname in ('json', 'jsonb', 'xml', 'uuid'))`

/** The tables (and their searchable columns) a search would scan. */
export async function searchTables(cfg: ConnectionConfig, db: string | undefined, o: Pick<SearchOptions, 'schemas' | 'allTypes' | 'includeViews'>): Promise<SearchTable[]> {
  // Views and foreign tables can hide arbitrarily slow work, so they're opt-in.
  const kinds = o.includeViews ? `('r', 'p', 'm', 'v', 'f')` : `('r', 'p', 'm')`
  const rows = await pgRows(
    cfg,
    db,
    `select n.nspname::text, c.relname::text, c.relkind::text, json_agg(a.attname::text order by a.attnum)::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       join pg_type ty on ty.oid = a.atttypid
       join pg_type bt on bt.oid = case when ty.typtype = 'd' then ty.typbasetype else ty.oid end
      where c.relkind in ${kinds} and not c.relispartition
        and (cardinality($1::text[]) > 0 and n.nspname = any($1)
             or cardinality($1::text[]) = 0 and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname not like 'pg_temp_%' and n.nspname not like 'pg_toast_temp_%')
        and has_table_privilege(c.oid, 'select')
        ${o.allTypes ? '' : `and ${TEXT_LIKE}`}
      group by n.nspname, c.relname, c.relkind
      order by n.nspname, c.relname`,
    [o.schemas]
  )
  return rows.map(([schema, table, kind, cols]) => ({
    schema: String(schema),
    table: String(table),
    kind: kind === 'v' || kind === 'f' ? 'view' : kind === 'm' ? 'matview' : 'table',
    columns: JSON.parse(String(cols)) as string[]
  }))
}

// searchId -> the queryIds of its running scans; absent once cancelled or finished.
const active = new Map<string, { cfg: ConnectionConfig; running: Set<string> }>()

export async function runSearch(
  cfg: ConnectionConfig,
  db: string | undefined,
  o: SearchOptions,
  searchId: string,
  onProgress: (p: SearchProgress) => void
): Promise<SearchSummary> {
  if (!o.term) throw new Error('Nothing to search for')
  // Registered first so a cancel while the table list loads still counts.
  const job = { cfg, running: new Set<string>() }
  active.set(searchId, job)
  let tables: SearchTable[]
  try {
    // A bad pattern would fail every table; check it once up front.
    if (o.mode === 'regex') await pgRows(cfg, db, `select '' ~ $1`, [o.term])
    tables = await searchTables(cfg, db, o)
  } catch (e) {
    if (active.get(searchId) === job) active.delete(searchId)
    throw e
  }
  const perTable = Math.max(1, Math.min(SEARCH_MAX_PER_TABLE, Math.floor(o.perTable) || 100))
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (active.get(searchId) === job && next < tables.length) {
      const i = next++
      const t = tables[i]
      const sql = searchSql(t, o)
      const queryId = `${searchId}:${i}`
      job.running.add(queryId)
      let hit: SearchHit | undefined
      try {
        const result = await pgQuery(cfg, db, sql, { limit: perTable, readOnly: true, timeoutMs: o.timeoutMs, queryId })
        if (result.rows.length) hit = { schema: t.schema, table: t.table, kind: t.kind, sql, result }
      } catch (e) {
        hit = { schema: t.schema, table: t.table, kind: t.kind, sql, error: e instanceof Error ? e.message : String(e) }
      } finally {
        job.running.delete(queryId)
      }
      if (active.get(searchId) !== job) return
      done++
      onProgress({ done, total: tables.length, hit })
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tables.length) }, worker))
    return { total: tables.length, done, cancelled: active.get(searchId) !== job }
  } finally {
    if (active.get(searchId) === job) active.delete(searchId)
  }
}

export async function cancelSearch(searchId: string): Promise<void> {
  const job = active.get(searchId)
  if (!job) return
  active.delete(searchId)
  await Promise.all([...job.running].map((q) => pgCancel(job.cfg, q).catch(() => false)))
}
