// ER diagram: the model read from the catalog, a layered auto layout, edge
// geometry and a Mermaid export. Pure; shared with the renderer.

export interface ErdColumn {
  name: string
  type: string
  notNull: boolean
  pk: boolean
  fk: boolean
}

export interface ErdTable {
  /** Key: the name inside the schema, or "schema.name" for an external table. */
  key: string
  schema: string
  name: string
  kind: 'table' | 'partitioned' | 'foreign'
  comment?: string
  columns: ErdColumn[]
  /** A table of another schema a foreign key points at (only its key columns). */
  external?: boolean
}

export interface ErdRef {
  name: string
  /** Referencing table key and columns. */
  from: string
  fromCols: string[]
  /** Referenced table key and columns. */
  to: string
  toCols: string[]
}

export interface ErdModel {
  schema: string
  tables: ErdTable[]
  refs: ErdRef[]
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const ERD_HEAD = 30
export const ERD_ROW = 20
const PAD = 8
const GAP_X = 90
const GAP_Y = 28
const COMP_GAP = 70

/** The columns a node shows: all, or only key columns. */
export const shownColumns = (t: ErdTable, keysOnly: boolean): ErdColumn[] =>
  keysOnly ? t.columns.filter((c) => c.pk || c.fk) : t.columns

export const nodeHeight = (rows: number): number => ERD_HEAD + Math.max(1, rows) * ERD_ROW + PAD / 2

/**
 * Lays the tables out left to right by reference: a referenced table sits left
 * of the tables pointing at it. Connected groups are laid out on their own and
 * shelf-packed, unrelated tables last in a grid.
 */
export function layoutErd(model: ErdModel, size: (t: ErdTable) => { w: number; h: number }): Record<string, Box> {
  const keys = model.tables.map((t) => t.key)
  const byKey = new Map(model.tables.map((t) => [t.key, t]))
  const sizes = new Map(model.tables.map((t) => [t.key, size(t)]))
  // parent -> children (referenced -> referencing), no self loops, no duplicates.
  const out = new Map<string, Set<string>>()
  const inc = new Map<string, Set<string>>()
  for (const k of keys) {
    out.set(k, new Set())
    inc.set(k, new Set())
  }
  for (const r of model.refs) {
    if (r.from === r.to || !byKey.has(r.from) || !byKey.has(r.to)) continue
    out.get(r.to)!.add(r.from)
    inc.get(r.from)!.add(r.to)
  }

  // Connected components (undirected).
  const comp = new Map<string, number>()
  const comps: string[][] = []
  for (const k of keys) {
    if (comp.has(k)) continue
    const id = comps.length
    const members: string[] = []
    const stack = [k]
    comp.set(k, id)
    while (stack.length) {
      const x = stack.pop()!
      members.push(x)
      for (const y of [...out.get(x)!, ...inc.get(x)!])
        if (!comp.has(y)) {
          comp.set(y, id)
          stack.push(y)
        }
    }
    comps.push(members.sort())
  }

  const boxes: Record<string, Box> = {}
  const groups: Array<{ keys: string[]; w: number; h: number }> = []
  const singles: string[] = []
  for (const members of comps) {
    if (members.length === 1) singles.push(members[0])
    else groups.push(layoutGroup(members, out, inc, sizes, boxes))
  }

  // Unrelated tables become one grid block.
  if (singles.length) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(singles.length * 1.5)))
    const colW: number[] = []
    singles.forEach((k, i) => {
      const c = i % cols
      colW[c] = Math.max(colW[c] ?? 0, sizes.get(k)!.w)
    })
    const xs = colW.map((_, c) => colW.slice(0, c).reduce((a, b) => a + b + GAP_Y, 0))
    let y = 0
    let w = 0
    for (let i = 0; i < singles.length; i += cols) {
      const row = singles.slice(i, i + cols)
      const rowH = Math.max(...row.map((k) => sizes.get(k)!.h))
      row.forEach((k, c) => {
        const s = sizes.get(k)!
        boxes[k] = { x: xs[c], y, w: s.w, h: s.h }
        w = Math.max(w, xs[c] + s.w)
      })
      y += rowH + GAP_Y
    }
    groups.push({ keys: singles, w, h: y - GAP_Y })
  }

  // Shelf-pack the groups, biggest first, rows no wider than a rough square.
  const area = groups.reduce((a, g) => a + g.w * g.h, 0)
  const maxW = Math.max(...groups.map((g) => g.w), Math.sqrt(area) * 1.6)
  const order = groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (a.g.keys === singles ? 1 : b.g.keys === singles ? -1 : b.g.w * b.g.h - a.g.w * a.g.h || a.i - b.i))
  let x = 0
  let y = 0
  let shelf = 0
  for (const { g } of order) {
    if (x > 0 && x + g.w > maxW) {
      x = 0
      y += shelf + COMP_GAP
      shelf = 0
    }
    for (const k of g.keys) {
      boxes[k].x += x
      boxes[k].y += y
    }
    x += g.w + COMP_GAP
    shelf = Math.max(shelf, g.h)
  }
  return boxes
}

function layoutGroup(
  members: string[],
  out: Map<string, Set<string>>,
  inc: Map<string, Set<string>>,
  sizes: Map<string, { w: number; h: number }>,
  boxes: Record<string, Box>
): { keys: string[]; w: number; h: number } {
  // Drop back edges (cycles) with a DFS from the roots, then rank by longest path.
  const state = new Map<string, 1 | 2>()
  const dag = new Map<string, string[]>(members.map((k) => [k, []]))
  const visit = (k: string): void => {
    state.set(k, 1)
    for (const c of [...out.get(k)!].sort()) {
      const s = state.get(c)
      if (s === 1) continue // back edge
      dag.get(k)!.push(c)
      if (!s) visit(c)
    }
    state.set(k, 2)
  }
  const roots = members.filter((k) => inc.get(k)!.size === 0)
  for (const k of [...roots, ...members]) if (!state.has(k)) visit(k)

  const rank = new Map<string, number>(members.map((k) => [k, 0]))
  const indeg = new Map<string, number>(members.map((k) => [k, 0]))
  for (const k of members) for (const c of dag.get(k)!) indeg.set(c, indeg.get(c)! + 1)
  const queue = members.filter((k) => indeg.get(k) === 0)
  while (queue.length) {
    const k = queue.shift()!
    for (const c of dag.get(k)!) {
      rank.set(c, Math.max(rank.get(c)!, rank.get(k)! + 1))
      indeg.set(c, indeg.get(c)! - 1)
      if (indeg.get(c) === 0) queue.push(c)
    }
  }
  // Pull leaf parents next to their children (a lookup table referenced only from rank 3 sits at rank 2).
  for (const k of members) {
    const kids = dag.get(k)!
    if (kids.length && inc.get(k)!.size === 0) rank.set(k, Math.min(...kids.map((c) => rank.get(c)!)) - 1)
  }

  const layers: string[][] = []
  for (const k of members) (layers[rank.get(k)!] ??= []).push(k)
  const nonEmpty = layers.filter((l) => l?.length)

  // Barycenter ordering sweeps to cut crossings.
  const pos = new Map<string, number>()
  const index = (): void => nonEmpty.forEach((l) => l.forEach((k, i) => pos.set(k, i)))
  index()
  const neighbors = (k: string): string[] => [...out.get(k)!, ...inc.get(k)!].filter((x) => pos.has(x))
  for (let pass = 0; pass < 6; pass++) {
    const seq = pass % 2 ? [...nonEmpty].reverse() : nonEmpty
    for (const layer of seq) {
      const bc = new Map(
        layer.map((k) => {
          const ns = neighbors(k)
          return [k, ns.length ? ns.reduce((a, n) => a + pos.get(n)!, 0) / ns.length : pos.get(k)!]
        })
      )
      layer.sort((a, b) => bc.get(a)! - bc.get(b)! || a.localeCompare(b))
      layer.forEach((k, i) => pos.set(k, i))
    }
  }

  let x = 0
  let h = 0
  const heights = nonEmpty.map((l) => l.reduce((a, k) => a + sizes.get(k)!.h, 0) + GAP_Y * (l.length - 1))
  const tallest = Math.max(...heights)
  nonEmpty.forEach((layer, li) => {
    const w = Math.max(...layer.map((k) => sizes.get(k)!.w))
    let y = (tallest - heights[li]) / 2
    for (const k of layer) {
      const s = sizes.get(k)!
      boxes[k] = { x, y, w: s.w, h: s.h }
      y += s.h + GAP_Y
    }
    h = Math.max(h, y - GAP_Y)
    x += w + GAP_X
  })
  return { keys: members, w: x - GAP_X, h }
}

/** The y of a column's row (or the header when it isn't shown). */
export function rowY(b: Box, row: number): number {
  return row < 0 ? b.y + ERD_HEAD / 2 : b.y + ERD_HEAD + ERD_ROW * row + ERD_ROW / 2
}

/** A curve from the referencing column to the referenced one, leaving each box on its facing side. */
export function edgePath(from: Box, fromRow: number, to: Box, toRow: number): { d: string; x1: number; y1: number; x2: number; y2: number; dir1: number; dir2: number } {
  const y1 = rowY(from, fromRow)
  const y2 = rowY(to, toRow)
  const fc = from.x + from.w / 2
  const tc = to.x + to.w / 2
  let dir1: number
  let dir2: number
  if (from.x >= to.x + to.w) {
    dir1 = -1
    dir2 = 1
  } else if (to.x >= from.x + from.w) {
    dir1 = 1
    dir2 = -1
  } else {
    // Overlapping columns of boxes (or a self reference): loop out on one side.
    dir1 = dir2 = fc <= tc ? -1 : 1
    if (from === to) dir1 = dir2 = 1
  }
  const x1 = dir1 > 0 ? from.x + from.w : from.x
  const x2 = dir2 > 0 ? to.x + to.w : to.x
  const reach = Math.max(36, Math.min(160, Math.abs(x2 - x1) / 2))
  const d = `M${r(x1)},${r(y1)} C${r(x1 + dir1 * reach)},${r(y1)} ${r(x2 + dir2 * reach)},${r(y2)} ${r(x2)},${r(y2)}`
  return { d, x1, y1, x2, y2, dir1, dir2 }
}

const r = (n: number): number => Math.round(n * 10) / 10

/** The extent of the boxes. */
export function bounds(boxes: Box[]): Box {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const x2 = Math.max(...boxes.map((b) => b.x + b.w))
  const y2 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x, y, w: x2 - x, h: y2 - y }
}

// ---- Mermaid -----------------------------------------------------------------

const mmName = (s: string): string => (/^[A-Za-z_][\w-]*$/.test(s) ? s : `"${s.replace(/"/g, "'")}"`)
const mmType = (s: string): string => s.replace(/\[\]/g, '_array').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'
const mmWord = (s: string): string => s.replace(/[^\w-]+/g, '_') || '_'

/** The model as a Mermaid erDiagram. */
export function erdMermaid(model: ErdModel): string {
  const lines = ['erDiagram']
  for (const t of model.tables) {
    const cols = t.columns.map((c) => {
      const keys = [c.pk && 'PK', c.fk && 'FK'].filter(Boolean).join(',')
      return `    ${mmType(c.type)} ${mmWord(c.name)}${keys ? ` ${keys}` : ''}`
    })
    lines.push(cols.length ? `  ${mmName(t.key)} {\n${cols.join('\n')}\n  }` : `  ${mmName(t.key)} {\n  }`)
  }
  const byKey = new Map(model.tables.map((t) => [t.key, t]))
  for (const ref of model.refs) {
    const from = byKey.get(ref.from)
    const required = !!from && ref.fromCols.every((n) => from.columns.find((c) => c.name === n)?.notNull)
    lines.push(`  ${mmName(ref.to)} ${required ? '||' : '|o'}--o{ ${mmName(ref.from)} : "${ref.name.replace(/"/g, "'")}"`)
  }
  return lines.join('\n') + '\n'
}
