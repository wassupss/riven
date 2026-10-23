import { literal, quoteIdent } from './sqlText'
import type { QueryResult } from './types'

// The pure half of full data search (types and the per-table query), shared
// with the renderer; the scanning itself lives in dataSearch.ts.

export type SearchMode = 'contains' | 'exact' | 'regex'

export interface SearchOptions {
  /** Empty: every non-system schema. */
  schemas: string[]
  term: string
  mode: SearchMode
  caseSensitive: boolean
  /** Cast every column to text, not just the text-like ones (slower). */
  allTypes: boolean
  includeViews: boolean
  /** Rows kept per table. */
  perTable: number
  /** Per-table statement timeout. */
  timeoutMs: number
}

export interface SearchTable {
  schema: string
  table: string
  kind: 'table' | 'view' | 'matview'
  columns: string[]
}

export interface SearchHit {
  schema: string
  table: string
  kind: SearchTable['kind']
  sql: string
  result?: QueryResult
  error?: string
}

export interface SearchProgress {
  done: number
  total: number
  /** The table just finished, when it matched or failed. */
  hit?: SearchHit
}

export interface SearchSummary {
  total: number
  done: number
  cancelled: boolean
}

export const SEARCH_MAX_PER_TABLE = 1000

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c)

/** The WHERE condition matching `term` in any of `columns`. */
export function searchCondition(columns: string[], o: Pick<SearchOptions, 'term' | 'mode' | 'caseSensitive'>): string {
  const lit = (s: string): string => literal('postgres', s)
  const one = (c: string): string => {
    const col = `${quoteIdent('postgres', c)}::text`
    if (o.mode === 'regex') return `${col} ${o.caseSensitive ? '~' : '~*'} ${lit(o.term)}`
    if (o.mode === 'exact') return o.caseSensitive ? `${col} = ${lit(o.term)}` : `lower(${col}) = lower(${lit(o.term)})`
    return `${col} ${o.caseSensitive ? 'like' : 'ilike'} ${lit(`%${likeEscape(o.term)}%`)}`
  }
  return columns.map(one).join('\n   or ')
}

export function searchSql(t: SearchTable, o: Pick<SearchOptions, 'term' | 'mode' | 'caseSensitive'>): string {
  const q = (s: string): string => quoteIdent('postgres', s)
  return `select *\n  from ${q(t.schema)}.${q(t.table)}\n where ${searchCondition(t.columns, o)}`
}
