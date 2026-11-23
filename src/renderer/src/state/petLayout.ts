import type { Accessory, AccessorySlot } from './pet'

// ---------------------------------------------------------------------------
// Where a pet's decorations go when the keeper has moved them (장식 배치).
//
// Every piece (a keepsake it wears, a level decoration, one twinkle of a
// shine) has a key; the automatic placement in petSprites.ts (outfitPieces)
// is the default, and only what the keeper changed is saved here: a piece
// moved (its centre, relative to the pet's bounding box on the 32 grid, so it
// lands in the same place on the pet at 32, 48 or 64 and at any scale),
// hidden, or put in front of / behind the pet.
//
// Keys: `acc:<id>` (a hat, neckwear, a floating friend), `acc:<id>:<i>` (the
// pair at its feet, the twinkles of a shine), `decor:<id>` and
// `decor:sparkle:<i>`. A key whose piece it no longer has (a hat taken off)
// keeps its place for when it comes back.
// ---------------------------------------------------------------------------

export type DecorZ = 'front' | 'back'

export interface DecorOverride {
  /** The piece's centre, as a fraction of the pet's box (0 its left edge, 1 its right). */
  x?: number
  y?: number
  hidden?: true
  z?: DecorZ
}

export type DecorLayout = Record<string, DecorOverride>

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const LAYOUT_KEY = /^(acc|decor):[a-z]{2,16}(?::[0-9])?$/
/** More pieces than any pet can have at once, with room for ones put away. */
export const LAYOUT_MAX = 48
/** How far outside its box a piece may be kept (a fraction of the box). */
const REL_MIN = -2
const REL_MAX = 3

const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** A saved layout read defensively; undefined when there is nothing in it. */
export function sanitizeLayout(raw: unknown): DecorLayout | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: DecorLayout = {}
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= LAYOUT_MAX) break
    if (!LAYOUT_KEY.test(k) || !v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const o2: DecorOverride = {}
    const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
    if (fin(o.x) && fin(o.y)) {
      o2.x = round3(Math.min(REL_MAX, Math.max(REL_MIN, o.x)))
      o2.y = round3(Math.min(REL_MAX, Math.max(REL_MIN, o.y)))
    }
    if (o.hidden === true) o2.hidden = true
    if (o.z === 'front' || o.z === 'back') o2.z = o.z
    if (Object.keys(o2).length) {
      out[k] = o2
      n++
    }
  }
  return n ? out : undefined
}

/** The box round a set of dots (a 1x1 box at the middle of the grid when there are none). */
export function bboxOf(dots: ReadonlyArray<{ x: number; y: number }>, grid = 32): Box {
  if (!dots.length) return { x: grid / 2, y: grid / 2, w: 1, h: 1 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const d of dots) {
    if (d.x < x0) x0 = d.x
    if (d.y < y0) y0 = d.y
    if (d.x > x1) x1 = d.x
    if (d.y > y1) y1 = d.y
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** A piece's top-left on the grid as the centre relative to the pet's box. */
export function toRel(at: { x: number; y: number }, size: { w: number; h: number }, box: Box): { x: number; y: number } {
  return {
    x: round3(Math.min(REL_MAX, Math.max(REL_MIN, (at.x + size.w / 2 - box.x) / box.w))),
    y: round3(Math.min(REL_MAX, Math.max(REL_MIN, (at.y + size.h / 2 - box.y) / box.h)))
  }
}

/** Back from relative: the whole-dot top-left, kept inside the grid. */
export function fromRel(rel: { x: number; y: number }, size: { w: number; h: number }, box: Box, grid = 32): { x: number; y: number } {
  const x = Math.round(box.x + rel.x * box.w - size.w / 2)
  const y = Math.round(box.y + rel.y * box.h - size.h / 2)
  return {
    x: Math.max(0, Math.min(grid - size.w, x)),
    y: Math.max(0, Math.min(grid - size.h, y))
  }
}

/** One piece's override changed; an override with nothing left in it goes. */
export function setOverride(layout: DecorLayout | undefined, key: string, patch: Partial<DecorOverride> | null): DecorLayout | undefined {
  const next: DecorLayout = { ...(layout ?? {}) }
  if (patch === null) delete next[key]
  else {
    const o: DecorOverride = { ...(next[key] ?? {}) }
    for (const [k, v] of Object.entries(patch) as Array<[keyof DecorOverride, unknown]>) {
      if (v === undefined) delete o[k]
      else (o as Record<string, unknown>)[k] = v
    }
    if (Object.keys(o).length) next[key] = o
    else delete next[key]
  }
  return sanitizeLayout(next)
}

/** A layout as a stable string, for memo keys and comparing. */
export function layoutKey(layout: DecorLayout | undefined): string {
  if (!layout) return ''
  return Object.keys(layout)
    .sort()
    .map((k) => {
      const o = layout[k]
      return `${k}=${o.x ?? ''},${o.y ?? ''},${o.hidden ? 'h' : ''},${o.z ?? ''}`
    })
    .join(';')
}

/**
 * Showing or hiding a keepsake in the layout editor is wearing it: one per
 * slot, so putting one on takes off the one in its slot. Only a won prize can
 * be put on; one already worn can always come off.
 */
export function toggleWornList(
  worn: readonly Accessory[],
  won: readonly Accessory[],
  id: Accessory,
  slotOf: (a: Accessory) => AccessorySlot
): Accessory[] {
  if (worn.includes(id)) return worn.filter((w) => w !== id)
  if (!won.includes(id)) return [...worn]
  return [...worn.filter((w) => slotOf(w) !== slotOf(id)), id]
}
