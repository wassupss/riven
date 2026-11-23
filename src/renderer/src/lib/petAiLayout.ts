import { extractJson } from './petAi'
import { setOverride, toRel, type Box, type DecorLayout, type DecorZ } from '../state/petLayout'

// ---------------------------------------------------------------------------
// "AI에게 배치 맡기기" in the decoration layout, the pure half: the pet and its
// decorations as text for the model, and its answer (new top-left corners on
// the 32 grid) checked and turned into a layout. Contract: one JSON object,
// {items: [{id, x, y, z?, hidden?}]}; an id it does not know, a corner off
// the grid or a piece that would stick out of it refuses the whole answer.
// ---------------------------------------------------------------------------

export const LAYOUT_GRID = 32

export const LAYOUT_SYSTEM = [
  'You arrange decorations around a small pixel-art desktop pet.',
  'You get the pet as a text grid, the decorations with their sizes and places, and a picture.',
  'Reply with exactly one JSON object and nothing else: no prose, no code fences.',
  'The object is {"items": [{"id": "<id>", "x": <int>, "y": <int>, "z": "front"|"back"}]}.'
].join(' ')

/** One decoration as the model sees it: its key, a name, its size and its top-left now. */
export interface LayoutItem {
  id: string
  name: string
  w: number
  h: number
  x: number
  y: number
  z: DecorZ
  hidden: boolean
}

/** The pet on the 32 grid: '#' its body, 'F' its face, '.' air. */
export function layoutGrid(pet: ReadonlyArray<{ x: number; y: number }>, face: Box | null, n = LAYOUT_GRID): string[] {
  const g = Array.from({ length: n }, () => Array<string>(n).fill('.'))
  for (const d of pet) {
    if (d.x < 0 || d.y < 0 || d.x >= n || d.y >= n) continue
    const inFace = !!face && d.x >= face.x && d.x < face.x + face.w && d.y >= face.y && d.y < face.y + face.h
    g[d.y][d.x] = inFace ? 'F' : '#'
  }
  return g.map((r) => r.join(''))
}

export function buildLayoutPrompt(opts: { grid: string[]; items: LayoutItem[]; request: string; scale: number }): string {
  const n = opts.grid.length
  const list = opts.items.map((i) => ({
    id: i.id,
    name: i.name,
    w: i.w,
    h: i.h,
    x: i.x,
    y: i.y,
    z: i.z,
    ...(i.hidden ? { hidden: true } : {})
  }))
  return [
    `Request: ${opts.request.trim() || 'Arrange them so they look good and do not overlap.'}`,
    '',
    `The pet on a ${n}x${n} grid, one character per dot: '#' is its body, 'F' its face, '.' empty air.`,
    'x grows to the right, y grows down, (0,0) is the top-left dot.',
    ...opts.grid,
    '',
    `The decorations (x, y is each one's top-left dot now; w x h its size in dots; z front is drawn over the pet, back behind it):`,
    JSON.stringify(list),
    '',
    `Image attached: the pet with its decorations as they are now, each dot drawn as a ${opts.scale}x${opts.scale} square.`,
    '',
    'Rules:',
    `- x, y are whole numbers with 0 <= x <= ${n} - w and 0 <= y <= ${n} - h, so every piece stays on the grid.`,
    "- Never cover the face ('F') unless the request asks for it.",
    '- Use only the ids above. List only the pieces you move or change; the rest stay where they are.',
    '- "hidden": true hides a piece and "hidden": false shows a hidden one, only when the request asks.',
    '',
    'Answer with only: {"items": [{"id": "...", "x": 0, "y": 0, "z": "front"}]}'
  ].join('\n')
}

export type LayoutAnswer =
  | { ok: true; layout: DecorLayout | undefined; moved: number }
  | { ok: false; reason: string; vars?: Record<string, string | number> }

const fail = (reason: string, vars?: Record<string, string | number>): LayoutAnswer => ({ ok: false, reason, ...(vars ? { vars } : {}) })

/**
 * The model's answer applied to `layout`: each listed piece moved to its new
 * corner (stored relative to the pet's box, as every override is), its z
 * and visibility set when given. Refused whole on any bad item.
 */
export function parseLayoutAnswer(text: string, items: LayoutItem[], bbox: Box, layout: DecorLayout | undefined, n = LAYOUT_GRID): LayoutAnswer {
  const j = extractJson(text) as { items?: unknown } | null
  if (!j) return fail('pet.ai.err.json')
  if (!Array.isArray(j.items)) return fail('pet.ai.err.items')
  const byId = new Map(items.map((i) => [i.id, i]))
  let next = layout
  let moved = 0
  const seen = new Set<string>()
  for (const raw of j.items as unknown[]) {
    if (!raw || typeof raw !== 'object') return fail('pet.ai.err.items')
    const o = raw as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : ''
    const it = byId.get(id)
    if (!it) return fail('pet.ai.err.unknown', { id: id || '?' })
    if (seen.has(id)) continue
    seen.add(id)
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
    const x = num(o.x)
    const y = num(o.y)
    if (x === null || y === null) return fail('pet.ai.err.xy', { id })
    const moves = x !== it.x || y !== it.y
    // Left where it is, it passes as it is (a smaller stand-in may sit nearer an edge than the piece would).
    if (moves && (x < 0 || y < 0 || x > n - it.w || y > n - it.h)) return fail('pet.ai.err.bounds', { id, x, y })
    const patch: { x?: number; y?: number; z?: DecorZ; hidden?: true | undefined } = {}
    if (moves) {
      const rel = toRel({ x, y }, { w: it.w, h: it.h }, bbox)
      patch.x = rel.x
      patch.y = rel.y
    }
    if (o.z === 'front' || o.z === 'back') if (o.z !== it.z) patch.z = o.z
    if (o.hidden === true && !it.hidden) patch.hidden = true
    if (o.hidden === false && it.hidden) patch.hidden = undefined
    if (!Object.keys(patch).length) continue
    next = setOverride(next, id, patch)
    moved++
  }
  return { ok: true, layout: next, moved }
}

/** Approximate colours for the pet's dot characters, for the picture the model gets. */
const DOT_HEX: Record<string, string> = {
  o: '#2a2233',
  b: '#f2b36b',
  s: '#d9904a',
  h: '#ffe0a8',
  w: '#ffffff',
  e: '#2a2233',
  m: '#c0505a',
  a: '#f5c542',
  p: '#8899aa',
  l: '#fff3d6',
  d: '#b7773a',
  g: '#fff1a8',
  k: '#ffe0a8',
  c: '#f5c542',
  n: '#d9904a',
  v: '#ffffff',
  u: '#c0505a'
}

/** Dots (pet and decorations, back to front) as RGBA on the 32 grid. */
export function rgbaOfDots(
  layers: ReadonlyArray<ReadonlyArray<{ x: number; y: number; ch: string }>>,
  colourOf: (ch: string) => string | undefined,
  hexToRgb: (hex: string) => [number, number, number],
  n = LAYOUT_GRID
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * n * 4)
  for (const dots of layers)
    for (const d of dots) {
      if (d.x < 0 || d.y < 0 || d.x >= n || d.y >= n) continue
      const hex = colourOf(d.ch) ?? DOT_HEX[d.ch] ?? '#888888'
      const [r, g, b] = hexToRgb(hex)
      const i = (d.y * n + d.x) * 4
      out[i] = r
      out[i + 1] = g
      out[i + 2] = b
      out[i + 3] = 255
    }
  return out
}
