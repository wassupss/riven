import {
  ART,
  ART_AT,
  PHOTO,
  PHOTO_CHARS,
  photoLine,
  photoSizeOf,
  type CustomDesign
} from '../state/petSpecies'
import type { Sprite } from './petSprites'

// ---------------------------------------------------------------------------
// The body of a species made from a photo (see state/petSpecies.ts): the
// design on the 16x16 grid with an outline, drawn like any built-in animal.
//
// The photo's colours are drawn with characters of their own, so they never
// collide with what the rest of the art means by a letter: 'w' is the glint in
// an eye, 'h' a blush, 'a' the twinkling gold of a star and 's' a limb. Body
// stays 'b', so the face and the shading treat it as body.
// ---------------------------------------------------------------------------

/** Design role -> drawn character. */
export const CUSTOM_CHAR: Record<string, string> = { b: 'b', s: 'n', h: 'k', a: 'c', w: 'v' }
/** The characters a custom body may hold, on top of the built-in palette. */
export const CUSTOM_EXTRA = 'nkcv'

const G = 16
type Grid = string[][]
const blank = (): Grid => Array.from({ length: G }, () => Array(G).fill('.'))
const N4: Array<[number, number]> = [[0, -1], [-1, 0], [1, 0], [0, 1]]
const N8: Array<[number, number]> = [...N4, [-1, -1], [1, -1], [-1, 1], [1, 1]]
const inside = (ch: string | undefined): boolean => !!ch && ch !== '.' && ch !== 'o'

/** A 1-dot outline round everything drawn, four-connected so corners come out round. */
function outline(g: Grid): void {
  const before = g.map((r) => [...r])
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++)
      if (before[y][x] === '.' && N4.some(([dx, dy]) => inside(before[y + dy]?.[x + dx]))) g[y][x] = 'o'
}

/**
 * One piece, no holes: only the largest four-connected part is kept (eight-
 * connected with `diagonal`, so a thin leg or tail drawn corner to corner
 * stays on), and any gap the outside cannot reach is filled with the colour
 * around it.
 */
export function tidy(g: string[][], diagonal = false): void {
  const link = diagonal ? N8 : N4
  const h = g.length
  const w = g[0]?.length ?? 0
  const seen = new Uint8Array(w * h)
  let best: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (g[y][x] === '.' || seen[y * w + x]) continue
      const part: number[] = []
      const stack = [y * w + x]
      seen[y * w + x] = 1
      while (stack.length) {
        const i = stack.pop()!
        part.push(i)
        const cx = i % w
        const cy = (i - cx) / w
        for (const [dx, dy] of link) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const j = ny * w + nx
          if (seen[j] || g[ny][nx] === '.') continue
          seen[j] = 1
          stack.push(j)
        }
      }
      if (part.length > best.length) best = part
    }
  const keep = new Set(best)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!keep.has(y * w + x)) g[y][x] = '.'
  // Holes: empty dots the border cannot reach.
  const out = new Uint8Array(w * h)
  const stack: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && g[y][x] === '.') {
        out[y * w + x] = 1
        stack.push(y * w + x)
      }
  while (stack.length) {
    const i = stack.pop()!
    const cx = i % w
    const cy = (i - cx) / w
    for (const [dx, dy] of N4) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const j = ny * w + nx
      if (out[j] || g[ny][nx] !== '.') continue
      out[j] = 1
      stack.push(j)
    }
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (g[y][x] === '.' && !out[y * w + x]) {
        const near = N4.map(([dx, dy]) => g[y + dy]?.[x + dx]).find((c) => c && c !== '.')
        g[y][x] = near ?? 'b'
      }
}

interface Box {
  x0: number
  y0: number
  w: number
  h: number
}
function boxOf(art: string[], n = ART): Box {
  let x0 = n
  let x1 = -1
  let y0 = n
  let y1 = -1
  art.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    })
  )
  return x1 < 0 ? { x0: 0, y0: 0, w: n, h: n } : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** The design with its face window made plain body (where the face is stamped). */
function plainArt(d: CustomDesign): string[][] {
  const art = d.art.map((r) => [...r])
  if (!d.noFace)
    for (let dy = 0; dy < 4; dy++)
      for (let dx = 0; dx < 6; dx++) {
        const row = art[d.face.y + dy]
        if (row && d.face.x + dx < ART) row[d.face.x + dx] = 'b'
      }
  return art
}

function bodyOfDesign(d: CustomDesign): Sprite {
  const g = blank()
  plainArt(d).forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== '.') g[y + ART_AT][x + ART_AT] = CUSTOM_CHAR[ch] ?? 'b'
    })
  )
  outline(g)
  const bigFace = { x: d.face.x + ART_AT, y: d.face.y + ART_AT }
  return {
    rows: g.map((r) => r.join('')),
    face: { x: bigFace.x + 1, y: bigFace.y },
    bigFace,
    ...(d.noFace ? { hideFace: true } : {})
  }
}

const cache = new WeakMap<CustomDesign, Sprite>()

/** The body of a custom species. Same design, same dots, on every machine. */
export function customBody(d: CustomDesign): Sprite {
  const hit = cache.get(d)
  if (hit) return hit
  const body = d.photo ? photoBody(photoGrid(d)) : bodyOfDesign(d)
  cache.set(d, body)
  return body
}

// ---------------------------------------------------------------------------
// The faithful picture (CustomDesign.photo): drawn as it is, on its own grid
// (32, 48 or 64 dots across the pet's 32 css pixels), with an outline of
// about a css pixel and no face. Cached per design, so a frame never redoes it.
// ---------------------------------------------------------------------------

/** The drawn characters of the picture's colours: palette index i is PHOTO_DOT[i]. Never a palette letter. */
export const PHOTO_DOT = 'ABCDEFGHIJKLMNOP'

const photoCache = new WeakMap<CustomDesign, string[]>()

/**
 * The picture on its own grid (photoSizeOf: 32, 48 or 64 square): the
 * colours as PHOTO_DOT characters and 'o' its outline. Cached; the rows are
 * shared, so a caller that changes them copies them first.
 */
export function photoGrid(d: CustomDesign): string[] {
  const p = d.photo
  if (!p) return Array(PHOTO).fill('.'.repeat(PHOTO))
  const hit = photoCache.get(d)
  if (hit) return hit
  const n = photoSizeOf(p)
  const g: string[][] = Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      const ch = p.rows[y]?.[x] ?? '.'
      return ch === '.' ? '.' : (PHOTO_DOT[PHOTO_CHARS.indexOf(ch)] ?? '.')
    })
  )
  // The outline, about a css pixel thick (photoLine dots), grown a dot at a
  // time four-connected so its corners come out round.
  for (let pass = photoLine(n); pass > 0; pass--) {
    const before = g.map((r) => [...r])
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (before[y][x] === '.' && N4.some(([dx, dy]) => (before[y + dy]?.[x + dx] ?? '.') !== '.')) g[y][x] = 'o'
  }
  const rows = g.map((r) => r.join(''))
  photoCache.set(d, rows)
  return rows
}

/**
 * The 16x16 body the picture stands for: what the rest of the pet
 * code reads a body for (where a hat or a collar goes, how big it is), never
 * drawn itself. A dot is body where at least half of the picture's dots under
 * it are (2x2 of them at 32, 4x4 at 64); the face window, which only anchors
 * what it wears, is put where its head is.
 */
function photoBody(drawn: string[]): Sprite {
  const g = blank()
  const k = drawn.length / G
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      let n = 0
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) if (PHOTO_DOT.includes(drawn[k * y + dy][k * x + dx])) n++
      if (n * 2 >= k * k) g[y][x] = 'b'
    }
  const rows = g.map((r) => r.join(''))
  const b = boxOf(rows, G)
  // Where a face would be: across the middle, a little over a third down.
  const target = { x: b.x0 + b.w / 2, y: b.y0 + b.h * 0.38 }
  const fits = (x: number, y: number, w: number): boolean => {
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < w; dx++) if (g[y + dy]?.[x + dx] !== 'b') return false
    return true
  }
  const nearest = (w: number): { x: number; y: number } | null => {
    let best: { x: number; y: number } | null = null
    let bestD = Infinity
    for (let y = 0; y + 4 <= G; y++)
      for (let x = 0; x + w <= G; x++) {
        if (!fits(x, y, w)) continue
        const dd = Math.hypot(x + w / 2 - target.x, y + 2 - target.y)
        if (dd < bestD) {
          best = { x, y }
          bestD = dd
        }
      }
    return best
  }
  const big = nearest(6)
  const face = big
    ? { x: big.x + 1, y: big.y }
    : (nearest(4) ?? {
        x: Math.max(0, Math.min(G - 4, Math.round(target.x - 2))),
        y: Math.max(0, Math.min(G - 4, Math.round(target.y - 2)))
      })
  return { rows, face, ...(big ? { bigFace: big } : {}), hideFace: true }
}

/**
 * What petSprites.test.ts asks of every built-in body, asked of a custom one:
 * 16x16, only known characters, a face that is inside the grid and a window of
 * plain body (unless it keeps the photo's look), and the big face. Empty when
 * all is well.
 */
export function bodyProblems(d: CustomDesign, palette: string): string[] {
  const out: string[] = []
  const s = customBody(d)
  const allowed = palette + CUSTOM_EXTRA
  if (s.rows.length !== G) out.push(`${s.rows.length} rows`)
  s.rows.forEach((row, y) => {
    if (row.length !== G) out.push(`row ${y} is ${row.length} wide`)
    for (const ch of row) if (!allowed.includes(ch)) out.push(`'${ch}' at row ${y}`)
  })
  if (!s.face) return [...out, 'no face']
  if (s.face.x < 0 || s.face.y < 0 || s.face.x + 4 > G || s.face.y + 4 > G) out.push('face outside')
  if (!d.noFace) {
    for (let dy = 0; dy < 4; dy++)
      for (let dx = 0; dx < 4; dx++)
        if (s.rows[s.face.y + dy]?.[s.face.x + dx] !== 'b') out.push(`face window not plain at ${dx},${dy}`)
    if (!s.bigFace) out.push('no big face')
    else
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 6; dx++)
          if (s.rows[s.bigFace.y + dy]?.[s.bigFace.x + dx] !== 'b') out.push('big face window not plain')
  }
  return out
}
