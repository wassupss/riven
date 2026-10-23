import { splitStatements, type DbKind } from './sqlText'

// SQL autocomplete without a parser: a light tokenizer finds what the cursor is
// after (`alias.`, `FROM `, anything else) and which tables the statement names,
// and the catalog snapshot (CompletionMeta) supplies the candidates. Pure, so
// both the renderer's Monaco provider and the tests use it.

export interface CompletionColumn {
  name: string
  type: string
}

export interface CompletionTable {
  schema: string
  name: string
  /** pg relkind: r table, p partitioned, v view, m matview, f foreign. */
  kind: string
  columns: CompletionColumn[]
}

export interface CompletionMeta {
  schemas: string[]
  /** Schemas searched for unqualified names (current_schemas(false)). */
  searchPath: string[]
  tables: CompletionTable[]
  /** User-defined function names (outside the system schemas). */
  functions: string[]
  /** The table list was capped. */
  truncated: boolean
}

export type SuggestionKind = 'keyword' | 'schema' | 'table' | 'view' | 'column' | 'function'

export interface Suggestion {
  label: string
  kind: SuggestionKind
  /** Text inserted (label when absent). */
  insert?: string
  detail?: string
  /** Lower sorts first. */
  rank: number
}

export interface TableRef {
  schema?: string
  name: string
  alias?: string
}

export const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS',
  'AS', 'DISTINCT', 'ON', 'USING', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
  'LATERAL', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
  'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'WITH', 'RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'INSERT INTO', 'VALUES', 'DEFAULT', 'RETURNING', 'UPDATE', 'SET', 'DELETE FROM', 'ON CONFLICT', 'DO NOTHING',
  'DO UPDATE SET', 'CREATE TABLE', 'CREATE INDEX', 'CREATE VIEW', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE',
  'ADD COLUMN', 'DROP COLUMN', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'CHECK', 'CONSTRAINT',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'ANALYZE', 'TRUE', 'FALSE', 'CAST', 'FILTER', 'OVER',
  'PARTITION BY', 'WINDOW', 'FETCH FIRST', 'ROWS ONLY', 'FOR UPDATE', 'SKIP LOCKED', 'TABLE'
]

export const BUILTIN_FUNCTIONS = [
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least', 'now', 'current_date',
  'current_timestamp', 'date_trunc', 'date_part', 'extract', 'age', 'to_char', 'to_date', 'to_timestamp',
  'lower', 'upper', 'length', 'substring', 'trim', 'replace', 'concat', 'concat_ws', 'split_part', 'left',
  'right', 'position', 'regexp_replace', 'regexp_matches', 'string_agg', 'array_agg', 'json_agg', 'jsonb_agg',
  'json_build_object', 'jsonb_build_object', 'jsonb_set', 'to_jsonb', 'row_number', 'rank', 'dense_rank',
  'lag', 'lead', 'first_value', 'last_value', 'round', 'ceil', 'floor', 'abs', 'random', 'gen_random_uuid',
  'generate_series', 'unnest', 'array_length', 'bool_and', 'bool_or', 'pg_size_pretty', 'pg_total_relation_size'
]

/** Words that end a table reference, so they are never read as aliases. */
const STOP = new Set(
  (
    'where on using join inner left right full outer cross natural lateral group order having limit offset ' +
    'union intersect except window set values returning select from as with for fetch into default do ' +
    'conflict and or not'
  ).split(' ')
)
const TABLE_AFTER = new Set(['from', 'join', 'update', 'into', 'table'])
const CLAUSE = new Set(['select', 'from', 'join', 'where', 'on', 'set', 'into', 'update', 'by', 'having', 'values', 'returning', 'table', 'using'])

interface Tok {
  /** Identifier (unquoted lowercased, quoted verbatim), keyword or punctuation. */
  v: string
  /** Original text. */
  raw: string
  /** A double-quoted identifier. */
  quoted: boolean
  word: boolean
  start: number
  end: number
}

/** Tokens of a statement; strings and comments are dropped. */
function tokenize(s: string): Tok[] {
  const out: Tok[] = []
  const n = s.length
  let i = 0
  while (i < n) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && s[i + 1] === '-') {
      const j = s.indexOf('\n', i)
      i = j < 0 ? n : j + 1
    } else if (c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
    } else if (c === "'") {
      let j = i + 1
      while (j < n && !(s[j] === "'" && s[j + 1] !== "'")) j += s[j] === "'" ? 2 : 1
      i = j + 1
    } else if (c === '"' || c === '`') {
      let j = i + 1
      let v = ''
      while (j < n) {
        if (s[j] === c) {
          if (s[j + 1] === c) {
            v += c
            j += 2
            continue
          }
          break
        }
        v += s[j++]
      }
      out.push({ v, raw: s.slice(i, j + 1), quoted: true, word: true, start: i, end: Math.min(j + 1, n) })
      i = j + 1
    } else if (/[\p{L}_]/u.test(c)) {
      let j = i + 1
      while (j < n && /[\p{L}\p{N}_$]/u.test(s[j])) j++
      const raw = s.slice(i, j)
      out.push({ v: raw.toLowerCase(), raw, quoted: false, word: true, start: i, end: j })
      i = j
    } else {
      out.push({ v: c, raw: c, quoted: false, word: false, start: i, end: i + 1 })
      i++
    }
  }
  return out
}

/** Tables named in FROM / JOIN / UPDATE / INTO, with their aliases. */
export function tableRefs(stmt: string): TableRef[] {
  const t = tokenize(stmt)
  const out: TableRef[] = []
  let i = 0
  // Reads `[schema.]name [[AS] alias]` at i; returns the index after it.
  const readRef = (k: number): number => {
    if (!t[k]?.word || (!t[k].quoted && STOP.has(t[k].v))) return k
    let schema: string | undefined
    let name = t[k].v
    k++
    if (t[k]?.v === '.' && t[k + 1]?.word) {
      schema = name
      name = t[k + 1].v
      k += 2
    }
    // A function in FROM (generate_series(...)) is no table.
    if (t[k]?.v === '(') return k
    let alias: string | undefined
    if (t[k]?.v === 'as' && !t[k].quoted) k++
    if (t[k]?.word && (t[k].quoted || !STOP.has(t[k].v))) {
      alias = t[k].v
      k++
    }
    out.push({ schema, name, alias })
    return k
  }
  while (i < t.length) {
    const tk = t[i]
    if (tk.word && !tk.quoted && TABLE_AFTER.has(tk.v)) {
      let k = i + 1
      if (tk.v === 'from' || tk.v === 'update' || tk.v === 'table') if (t[k]?.v === 'only') k++
      k = readRef(k)
      // FROM a, b, c
      while (tk.v === 'from' && t[k]?.v === ',') k = readRef(k + 1)
      i = Math.max(k, i + 1)
    } else i++
  }
  return out
}

/** The statement around offset, and the offset within it. */
export function statementAround(text: string, offset: number, kind: DbKind): { stmt: string; at: number } {
  let start = 0
  let end = text.length
  for (const [s, e] of splitStatements(text, kind)) {
    if (e < offset) start = e + 1
    else {
      if (s <= offset) start = s
      end = e
      break
    }
  }
  if (start > offset) start = offset
  return { stmt: text.slice(start, end), at: offset - start }
}

const SIMPLE = /^[a-z_][a-z0-9_$]*$/
const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create ' +
    'current_date current_role current_time current_timestamp current_user default deferrable desc distinct do ' +
    'else end except false fetch for foreign from grant group having in initially intersect into lateral leading ' +
    'limit localtime localtimestamp not null offset on only or order placing primary references returning select ' +
    'session_user some symmetric table then to trailing true union unique user using variadic when where window with'
  ).split(' ')
)

/** An identifier as written in SQL: bare when it can be, else double-quoted. */
export function ident(name: string): string {
  return SIMPLE.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`
}

/** Case-folded lookup: exact first, then case-insensitive. */
function pick<T>(list: T[], key: (x: T) => string, want: string): T[] {
  const exact = list.filter((x) => key(x) === want)
  if (exact.length) return exact
  const lw = want.toLowerCase()
  return list.filter((x) => key(x).toLowerCase() === lw)
}

function findTables(meta: CompletionMeta, ref: { schema?: string; name: string }): CompletionTable[] {
  let list = pick(meta.tables, (x) => x.name, ref.name)
  if (ref.schema) return pick(list, (x) => x.schema, ref.schema)
  // Unqualified: the first search-path schema that has it.
  for (const s of meta.searchPath) {
    const hit = list.filter((x) => x.schema === s)
    if (hit.length) return hit
  }
  list = list.slice(0, 1)
  return list
}

const tableKind = (k: string): SuggestionKind => (k === 'v' || k === 'm' ? 'view' : 'table')
const KIND_NAME: Record<string, string> = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' }

function tableSuggestions(meta: CompletionMeta, schema?: string): Suggestion[] {
  const out: Suggestion[] = []
  const inPath = new Set(meta.searchPath)
  for (const x of meta.tables) {
    if (schema !== undefined && x.schema !== schema) continue
    const bare = schema !== undefined || inPath.has(x.schema)
    out.push({
      label: bare ? x.name : `${x.schema}.${x.name}`,
      insert: bare ? ident(x.name) : `${ident(x.schema)}.${ident(x.name)}`,
      kind: tableKind(x.kind),
      detail: `${x.schema} · ${KIND_NAME[x.kind] ?? 'table'}`,
      rank: bare ? 1 : 3
    })
  }
  return out
}

function columnSuggestions(tables: CompletionTable[], rank: number, owner?: (t: CompletionTable) => string): Suggestion[] {
  const out: Suggestion[] = []
  const seen = new Set<string>()
  for (const tb of tables)
    for (const c of tb.columns) {
      const key = `${owner?.(tb) ?? ''}\0${c.name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ label: c.name, insert: ident(c.name), kind: 'column', detail: `${owner?.(tb) ?? tb.name} · ${c.type}`, rank })
    }
  return out
}

const schemaSuggestions = (meta: CompletionMeta, rank: number): Suggestion[] =>
  meta.schemas.map((s) => ({ label: s, insert: ident(s), kind: 'schema' as const, detail: 'schema', rank }))

/** Candidates for the cursor at `at` within `stmt`. The editor filters them by the typed prefix. */
export function suggest(meta: CompletionMeta, stmt: string, at: number): Suggestion[] {
  const before = stmt.slice(0, at)
  // Drop the word being typed (bare or an unclosed quoted one).
  const word = /(?:"[^"]*|[\p{L}\p{N}_$]*)$/u.exec(before)?.[0] ?? ''
  const head = before.slice(0, before.length - word.length)
  const toks = tokenize(head)
  const last = toks[toks.length - 1]

  // `qualifier.` -> columns of that alias/table, or objects of that schema.
  if (last?.v === '.' && toks[toks.length - 2]?.word) {
    const q = toks[toks.length - 2]
    const q0 = toks[toks.length - 3]?.v === '.' && toks[toks.length - 4]?.word ? toks[toks.length - 4] : undefined
    if (q0) return columnSuggestions(findTables(meta, { schema: q0.v, name: q.v }), 0)
    const refs = tableRefs(stmt)
    const byAlias = refs.find((r) => r.alias !== undefined && (r.alias === q.v || r.alias.toLowerCase() === q.v.toLowerCase()))
    if (byAlias) return columnSuggestions(findTables(meta, byAlias), 0)
    const byName = refs.find((r) => r.name === q.v && !r.alias)
    const tables = findTables(meta, byName ?? { name: q.v })
    const out = tables.length && (byName || !pick(meta.schemas, (s) => s, q.v).length) ? columnSuggestions(tables, 0) : []
    const schema = pick(meta.schemas, (s) => s, q.v)[0]
    if (schema !== undefined) {
      out.push(...tableSuggestions(meta, schema))
      for (const f of meta.functions)
        if (f.startsWith(`${schema}.`)) out.push({ label: f.slice(schema.length + 1), kind: 'function', detail: schema, rank: 4 })
    }
    return out
  }

  // Right after FROM / JOIN / UPDATE / INTO (or a comma in a FROM list): tables.
  let clause = ''
  for (let i = toks.length - 1; i >= 0; i--) {
    const tk = toks[i]
    if (tk.word && !tk.quoted && CLAUSE.has(tk.v)) {
      clause = tk.v
      break
    }
    if (tk.v === '(' || tk.v === ')') break
  }
  const lastWord = last?.word && !last.quoted ? last.v : ''
  if (TABLE_AFTER.has(lastWord) || lastWord === 'only' || (last?.v === ',' && clause === 'from')) {
    return [...tableSuggestions(meta), ...schemaSuggestions(meta, 5)]
  }

  // Anything else: the statement's columns first, then functions, tables, keywords.
  const refs = tableRefs(stmt)
  const multi = refs.length > 1
  const out: Suggestion[] = []
  for (const r of refs) {
    const tables = findTables(meta, r)
    out.push(...columnSuggestions(tables, 0, multi ? () => r.alias ?? r.name : undefined))
  }
  // Same column in several tables: one entry is enough for the list.
  const seen = new Set<string>()
  const cols = out.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)))
  const fns = new Set([...meta.functions.map((f) => f.slice(f.indexOf('.') + 1)), ...BUILTIN_FUNCTIONS])
  return [
    ...cols,
    ...KEYWORDS.map((k) => ({ label: k, kind: 'keyword' as const, rank: 2 })),
    ...[...fns].map((f) => ({ label: f, kind: 'function' as const, rank: 3 })),
    ...tableSuggestions(meta).map((s) => ({ ...s, rank: s.rank + 3 })),
    ...schemaSuggestions(meta, 7)
  ]
}
