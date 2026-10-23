// EXPLAIN (FORMAT JSON) -> a tree the console draws: per node the estimate,
// the actuals when ANALYZE ran, its own (exclusive) time and the warnings worth
// a look (misestimates, disk sorts, rows thrown away by filters). Pure.

export interface PlanNode {
  id: number
  /** "Seq Scan", "Hash Join", ... */
  type: string
  /** Type plus its target: "Seq Scan on users u", "Hash Left Join". */
  label: string
  /** Conditions, keys and other properties worth showing, as "Name: value". */
  detail: string[]
  startupCost: number
  totalCost: number
  planRows: number
  width: number
  /** ANALYZE only: rows over all loops. */
  actualRows?: number
  loops?: number
  /** ANALYZE only: inclusive time over all loops, ms. */
  totalMs?: number
  /** ANALYZE only: time spent in this node alone, ms. */
  selfMs?: number
  /** Cost of this node alone (for EXPLAIN without ANALYZE). */
  selfCost: number
  sharedHit?: number
  sharedRead?: number
  warnings: string[]
  children: PlanNode[]
}

export interface Plan {
  root: PlanNode
  analyze: boolean
  planningMs?: number
  executionMs?: number
  /** Largest selfMs (analyze) or selfCost, for scaling bars. */
  maxSelf: number
  nodes: number
}

export interface ExplainOptions {
  analyze: boolean
  buffers?: boolean
}

export function explainSql(sql: string, o: ExplainOptions): string {
  const opts = ['FORMAT JSON', ...(o.analyze ? ['ANALYZE'] : []), ...(o.analyze && o.buffers !== false ? ['BUFFERS'] : [])]
  return `EXPLAIN (${opts.join(', ')}) ${sql.trim().replace(/;\s*$/, '')}`
}

/** Statements EXPLAIN ANALYZE can run without changing anything. */
export function readOnlyStatement(sql: string): boolean {
  const s = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '')
  const first = /^[A-Za-z]+/.exec(s)?.[0]?.toLowerCase()
  if (first === 'select' || first === 'values' || first === 'table') return !/\b(into|for\s+(update|share|no\s+key\s+update|key\s+share))\b/i.test(s)
  if (first === 'with') return !/\b(insert|update|delete|merge)\b/i.test(s)
  return false
}

type Raw = Record<string, unknown>

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// Properties shown under a node, in this order.
const DETAIL_KEYS = [
  'Index Name',
  'Index Cond',
  'Recheck Cond',
  'Hash Cond',
  'Merge Cond',
  'Join Filter',
  'Filter',
  'Sort Key',
  'Group Key',
  'Presorted Key',
  'Cache Key',
  'One-Time Filter',
  'Subplan Name',
  'CTE Name',
  'Function Name',
  'Strategy',
  'Partial Mode',
  'Workers Planned',
  'Workers Launched',
  'Sort Method',
  'Sort Space Used',
  'Sort Space Type',
  'Peak Memory Usage',
  'Hash Batches',
  'Rows Removed by Filter',
  'Rows Removed by Join Filter',
  'Rows Removed by Index Recheck',
  'Heap Fetches'
]

function label(n: Raw): string {
  let s = String(n['Node Type'] ?? '?')
  const join = n['Join Type']
  if (typeof join === 'string' && join !== 'Inner') {
    if (s === 'Nested Loop') s = `Nested Loop ${join} Join`
    else if (s.endsWith(' Join')) s = `${s.slice(0, -5)} ${join} Join`
  }
  if (n['Parallel Aware']) s = `Parallel ${s}`
  const rel = n['Relation Name']
  if (typeof rel === 'string') {
    const schema = typeof n.Schema === 'string' ? `${n.Schema}.` : ''
    s += ` on ${schema}${rel}`
    if (typeof n.Alias === 'string' && n.Alias !== rel) s += ` ${n.Alias}`
  } else if (typeof n['CTE Name'] === 'string') s += ` on ${n['CTE Name']}`
  else if (typeof n['Function Name'] === 'string') s += ` on ${n['Function Name']}()`
  if (typeof n['Index Name'] === 'string' && /Index/.test(s)) s += ` using ${n['Index Name']}`
  if (typeof n['Parent Relationship'] === 'string' && n['Parent Relationship'] === 'SubPlan' && typeof n['Subplan Name'] === 'string')
    s = `${n['Subplan Name']}: ${s}`
  return s
}

const fmtVal = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v))

export function parsePlan(json: string): Plan {
  const doc = JSON.parse(json) as unknown
  const top = (Array.isArray(doc) ? doc[0] : doc) as Raw
  if (!top || typeof top !== 'object' || !top.Plan) throw new Error('not an EXPLAIN (FORMAT JSON) result')
  let id = 0
  let analyze = false
  let maxSelf = 0

  const walk = (n: Raw): PlanNode => {
    const loops = num(n['Actual Loops'])
    const actual = loops !== undefined
    if (actual) analyze = true
    const children = ((n.Plans as Raw[] | undefined) ?? []).map(walk)
    const totalMs = actual ? (num(n['Actual Total Time']) ?? 0) * (loops || 1) : undefined
    const actualRows = actual ? (num(n['Actual Rows']) ?? 0) * (loops || 1) : undefined
    const totalCost = num(n['Total Cost']) ?? 0
    const childMs = children.reduce((a, c) => a + (c.totalMs ?? 0), 0)
    // InitPlans/SubPlans run inside the parent; costs of children overlap the
    // parent's, so the difference is this node's own share.
    const selfMs = totalMs !== undefined ? Math.max(0, totalMs - childMs) : undefined
    const selfCost = Math.max(0, totalCost - children.reduce((a, c) => a + c.totalCost, 0))
    const planRows = num(n['Plan Rows']) ?? 0
    const warnings: string[] = []
    if (actual && actualRows !== undefined && loops) {
      const est = planRows * loops
      const ratio = Math.max(est, 1) / Math.max(actualRows, 1)
      if ((ratio >= 10 || ratio <= 0.1) && Math.max(est, actualRows) >= 100) warnings.push(ratio > 1 ? `overestimate:${Math.round(ratio)}` : `underestimate:${Math.round(1 / ratio)}`)
      const removed = num(n['Rows Removed by Filter']) ?? 0
      if (removed * (loops || 1) > 1000 && removed > (num(n['Actual Rows']) ?? 0)) warnings.push('filterDiscard')
    }
    if (n['Sort Space Type'] === 'Disk' || (num(n['Hash Batches']) ?? 1) > 1) warnings.push('disk')
    if (n['Node Type'] === 'Seq Scan' && (actualRows ?? planRows) >= 10000 && n.Filter) warnings.push('seqScan')
    if (num(n['Workers Launched']) !== undefined && (num(n['Workers Launched']) ?? 0) < (num(n['Workers Planned']) ?? 0)) warnings.push('workers')
    const self = selfMs ?? selfCost
    if (self > maxSelf) maxSelf = self
    return {
      id: id++,
      type: String(n['Node Type'] ?? '?'),
      label: label(n),
      detail: DETAIL_KEYS.filter((k) => n[k] !== undefined && n[k] !== null && k !== 'Index Name').map((k) => `${k}: ${fmtVal(n[k])}`),
      startupCost: num(n['Startup Cost']) ?? 0,
      totalCost,
      planRows,
      width: num(n['Plan Width']) ?? 0,
      actualRows,
      loops,
      totalMs,
      selfMs,
      selfCost,
      sharedHit: num(n['Shared Hit Blocks']),
      sharedRead: num(n['Shared Read Blocks']),
      warnings,
      children
    }
  }

  const root = walk(top.Plan as Raw)
  return {
    root,
    analyze,
    planningMs: num(top['Planning Time']),
    executionMs: num(top['Execution Time']),
    maxSelf,
    nodes: id
  }
}
