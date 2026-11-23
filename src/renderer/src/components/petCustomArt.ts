import {
  ART,
  ART_AT,
  PHOTO,
  PHOTO_CHARS,
  hexToRgb,
  labOf,
  photoLine,
  photoSizeOf,
  type CustomDesign,
  type PhotoArt
} from '../state/petSpecies'
import type { Sprite } from './petSprites'

// ---------------------------------------------------------------------------
// The bodies of a species made from a photo (see state/petSpecies.ts). The
// design is the grown-up; the child and the hatchling are that same animal
// scaled down inside the 16x16 grid, the way the built-in animals' three sizes
// relate (the hatchling sits in its broken shell). The teen and the adult
// forms are then made by the same transforms every animal goes through
// (withLimbs, fatten, haunt, branchMarks in petSprites.ts).
//
// The photo's colours are drawn with characters of their own, so they never
// collide with what the rest of the art means by a letter: 'w' is the shell of
// the egg and the glint in an eye, 'h' a blush, 'a' the twinkling gold of a
// star and 's' a limb. Body stays 'b', so the face, the shading and the forms
// treat it as body.
// ---------------------------------------------------------------------------

/** Design role -> drawn character. */
export const CUSTOM_CHAR: Record<string, string> = { b: 'b', s: 'n', h: 'k', a: 'c', w: 'v' }
/** The characters a custom body may hold, on top of the built-in palette ('u' is its body colour on the egg). */
export const CUSTOM_EXTRA = 'nkcvu'

export interface CustomBodies {
  baby: Sprite
  young: Sprite
  grown: Sprite
}

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

function grownOf(d: CustomDesign): Sprite {
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

/**
 * The design at `scale`, inside the 16x16 grid with the bottom of its body on
 * row `bottom`. A dot is body when at least about half of the area it covers
 * in the design is; it takes the colour that covers most of that area.
 */
function smaller(d: CustomDesign, scale: number, bottom: number, shell: boolean): Sprite {
  const art = plainArt(d)
  const b = boxOf(d.art)
  const tw = Math.max(4, Math.min(12, Math.round(b.w * scale)))
  const th = Math.max(4, Math.min(bottom - 1, Math.round(b.h * scale)))
  const sx = b.w / tw
  const sy = b.h / th
  const small: string[][] = Array.from({ length: th }, () => Array(tw).fill('.'))
  for (let j = 0; j < th; j++)
    for (let i = 0; i < tw; i++) {
      const weight: Record<string, number> = {}
      let body = 0
      const fx0 = b.x0 + i * sx
      const fx1 = fx0 + sx
      const fy0 = b.y0 + j * sy
      const fy1 = fy0 + sy
      for (let y = Math.floor(fy0); y < Math.ceil(fy1); y++)
        for (let x = Math.floor(fx0); x < Math.ceil(fx1); x++) {
          const ch = art[y]?.[x]
          if (!ch || ch === '.') continue
          const a = (Math.min(x + 1, fx1) - Math.max(x, fx0)) * (Math.min(y + 1, fy1) - Math.max(y, fy0))
          if (a <= 0) continue
          body += a
          weight[ch] = (weight[ch] ?? 0) + a
        }
      if (body / (sx * sy) < 0.45) continue
      // Body wins a tie: a scaled-down animal reads as its main colour.
      small[j][i] = Object.keys(weight).sort((p, q) => weight[q] - weight[p] || (p === 'b' ? -1 : q === 'b' ? 1 : 0))[0]
    }
  tidy(small)
  // Where it goes: centred, its feet on `bottom`.
  const offX = Math.max(2, Math.min(G - 2 - tw, Math.round((G - tw) / 2)))
  const offY = bottom - th + 1
  const g = blank()
  small.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== '.') g[y + offY][x + offX] = CUSTOM_CHAR[ch] ?? 'b'
    })
  )
  // The face, where the grown-up's is on the same animal: the nearest window
  // that is all body. The child also gets the 6x4 one if there is room near
  // there, which is what gives the teen its big eyes.
  const target = {
    x: ((d.face.x + 3 - b.x0) / b.w) * tw + offX,
    y: ((d.face.y + 2 - b.y0) / b.h) * th + offY
  }
  const fits = (x: number, y: number, w: number): boolean => {
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < w; dx++) if (!inside(g[y + dy]?.[x + dx])) return false
    return true
  }
  const nearest = (w: number, maxD = Infinity): { x: number; y: number } | null => {
    let best: { x: number; y: number } | null = null
    let bestD = maxD
    for (let y = 1; y + 4 <= bottom + 1; y++)
      for (let x = 1; x + w <= G - 1; x++) {
        if (!fits(x, y, w)) continue
        const dd = Math.hypot(x + w / 2 - target.x, y + 2 - target.y)
        if (dd < bestD) {
          best = { x, y }
          bestD = dd
        }
      }
    return best
  }
  const big = shell ? null : nearest(6, 2.5)
  let face = big ? { x: big.x + 1, y: big.y } : nearest(4)
  if (!face) {
    // Nowhere fits (a thin animal at a small size): the face makes its own room.
    face = {
      x: Math.max(2, Math.min(G - 6, Math.round(target.x - 2))),
      y: Math.max(2, Math.min(bottom - 3, Math.round(target.y - 2)))
    }
  }
  const win = big ? { x: big.x, w: 6 } : { x: face.x, w: 4 }
  if (!d.noFace || !fits(win.x, face.y, win.w))
    for (let dy = 0; dy < 4; dy++)
      for (let dx = 0; dx < win.w; dx++) {
        const ch = g[face.y + dy][win.x + dx]
        if (!d.noFace || !inside(ch)) g[face.y + dy][win.x + dx] = 'b'
      }
  outline(g)
  if (shell) {
    g[11] = [...'.....w.ww.w.....']
    g[12] = [...'....wwwwwwww....']
  }
  return {
    rows: g.map((r) => r.join('')),
    face,
    ...(big ? { bigFace: big } : {}),
    ...(d.noFace ? { hideFace: true } : {})
  }
}

const cache = new WeakMap<CustomDesign, CustomBodies>()

/** The three bodies of a custom species. Same design, same dots, on every machine. */
export function customBodies(d: CustomDesign): CustomBodies {
  const hit = cache.get(d)
  if (hit) return hit
  const bodies = d.photo
    ? {
        baby: photoBody(photoGrid(d, 'hatchling')),
        young: photoBody(photoGrid(d, 'child')),
        grown: photoBody(photoGrid(d, 'adult'))
      }
    : {
        // The built-in hatchlings sit in their shell with the body on rows 3..10,
        // the children stand on row 12, the grown-ups fill the grid.
        baby: smaller(d, 0.58, 9, true),
        young: smaller(d, 0.78, 11, false),
        grown: grownOf(d)
      }
  cache.set(d, bodies)
  return bodies
}

// ---------------------------------------------------------------------------
// The faithful picture (CustomDesign.photo): drawn as it is, on its own grid
// (32, 48 or 64 dots across the pet's 32 css pixels), with an outline of
// about a css pixel and no face. The younger stages are the same picture made
// smaller, resampled from the grown-up's dots. Everything here is cached per
// design and stage, so a frame never redoes it.
// ---------------------------------------------------------------------------

/** The drawn characters of the picture's colours: palette index i is PHOTO_DOT[i]. Never a palette letter. */
export const PHOTO_DOT = 'ABCDEFGHIJKLMNOP'

export type PhotoStage = 'hatchling' | 'child' | 'teen' | 'adult'
/**
 * Each stage's size next to the grown-up and the row its feet stand on, on
 * the 32 grid (a bigger grid scales the row). The hatchling sits in its
 * broken shell (drawn rows 22..25), as the built-in hatchlings do.
 */
export const PHOTO_STAGES: Record<PhotoStage, { scale: number; bottom: number }> = {
  hatchling: { scale: 0.5, bottom: 22 },
  child: { scale: 0.75, bottom: 29 },
  teen: { scale: 0.875, bottom: 29 },
  adult: { scale: 1, bottom: 30 }
}

/**
 * The picture's subject (its bounding box) at `scale`, as palette characters.
 * A dot covers its share of the original; it is lit where at least half of
 * that is lit, and takes the palette colour nearest (in Lab) to the mean
 * colour there. Corners count as touching, so a thin tail is not cut off.
 */
export function scalePhoto(p: PhotoArt, scale: number): string[][] {
  const b = boxOf(p.rows, photoSizeOf(p))
  const crop = (): string[][] => p.rows.slice(b.y0, b.y0 + b.h).map((r) => [...r.slice(b.x0, b.x0 + b.w)])
  if (scale >= 1) return crop()
  const tw = Math.max(3, Math.round(b.w * scale))
  const th = Math.max(3, Math.round(b.h * scale))
  const sx = b.w / tw
  const sy = b.h / th
  const rgbs = p.palette.map(hexToRgb)
  const labs = p.palette.map((c) => labOf(...hexToRgb(c)))
  const out: string[][] = Array.from({ length: th }, () => Array(tw).fill('.'))
  for (let j = 0; j < th; j++)
    for (let i = 0; i < tw; i++) {
      const fx0 = b.x0 + i * sx
      const fx1 = fx0 + sx
      const fy0 = b.y0 + j * sy
      const fy1 = fy0 + sy
      let area = 0
      const sum = [0, 0, 0]
      for (let y = Math.floor(fy0); y < Math.ceil(fy1); y++)
        for (let x = Math.floor(fx0); x < Math.ceil(fx1); x++) {
          const ch = p.rows[y]?.[x]
          if (!ch || ch === '.') continue
          const a = (Math.min(x + 1, fx1) - Math.max(x, fx0)) * (Math.min(y + 1, fy1) - Math.max(y, fy0))
          if (a <= 0) continue
          const c = rgbs[PHOTO_CHARS.indexOf(ch)]
          area += a
          sum[0] += c[0] * a
          sum[1] += c[1] * a
          sum[2] += c[2] * a
        }
      if (area < sx * sy * 0.5) continue
      const lab = labOf(sum[0] / area, sum[1] / area, sum[2] / area)
      let best = 0
      let bestD = Infinity
      labs.forEach((l, k) => {
        const d = (l[0] - lab[0]) ** 2 + (l[1] - lab[1]) ** 2 + (l[2] - lab[2]) ** 2
        if (d < bestD) {
          bestD = d
          best = k
        }
      })
      out[j][i] = PHOTO_CHARS[best]
    }
  tidy(out, true)
  return out
}

/**
 * The broken shell a hatchling sits in, on a picture's grid of `n` (the
 * built-in one, its 16 dots each made n/16 square: 2 at 32, 3 at 48, 4 at 64).
 */
function shellOf(n: number): Array<[number, string]> {
  const k = n / 16
  const wide = (row: string): string => [...row].map((c) => c.repeat(k)).join('')
  const out: Array<[number, string]> = []
  for (const [y, row] of [
    [11, '.....w.ww.w.....'],
    [12, '....wwwwwwww....']
  ] as const)
    for (let d = 0; d < k; d++) out.push([y * k + d, wide(row)])
  return out
}

const photoCache = new WeakMap<CustomDesign, Partial<Record<PhotoStage, string[]>>>()

/**
 * A stage of the picture on its own grid (photoSizeOf: 32, 48 or 64 square):
 * the colours as PHOTO_DOT characters, 'o' its outline, 'w' the hatchling's
 * shell. Cached; the rows are shared, so a caller that changes them copies
 * them first.
 */
export function photoGrid(d: CustomDesign, stage: PhotoStage): string[] {
  const p = d.photo
  if (!p) return Array(PHOTO).fill('.'.repeat(PHOTO))
  const per = photoCache.get(d) ?? {}
  const hit = per[stage]
  if (hit) return hit
  const n = photoSizeOf(p)
  const { scale, bottom: bottom32 } = PHOTO_STAGES[stage]
  // The row its feet stand on, where that row of the 32 grid ends.
  const bottom = Math.floor(((bottom32 + 1) * n) / PHOTO) - 1
  const g: string[][] = Array.from({ length: n }, () => Array(n).fill('.'))
  const put = (small: string[][], offX: number, offY: number): void =>
    small.forEach((row, y) =>
      row.forEach((ch, x) => {
        if (ch !== '.' && g[y + offY]?.[x + offX] !== undefined) g[y + offY][x + offX] = PHOTO_DOT[PHOTO_CHARS.indexOf(ch)]
      })
    )
  if (scale >= 1) {
    // The grown-up is the picture itself, where it was made.
    put(
      p.rows.map((r) => [...r]),
      0,
      0
    )
  } else {
    const small = scalePhoto(p, scale)
    const tw = small[0]?.length ?? 0
    put(small, Math.round((n - tw) / 2), bottom - small.length + 1)
  }
  // The outline, about a css pixel thick (photoLine dots), grown a dot at a
  // time four-connected so its corners come out round.
  for (let pass = photoLine(n); pass > 0; pass--) {
    const before = g.map((r) => [...r])
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (before[y][x] === '.' && N4.some(([dx, dy]) => (before[y + dy]?.[x + dx] ?? '.') !== '.')) g[y][x] = 'o'
  }
  if (stage === 'hatchling')
    for (const [y, row] of shellOf(n)) [...row].forEach((ch, x) => ch !== '.' && (g[y][x] = ch))
  const rows = g.map((r) => r.join(''))
  per[stage] = rows
  photoCache.set(d, per)
  return rows
}

/**
 * The 16x16 body a stage of the picture stands for: what the rest of the pet
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
 * The egg's coat: the photo's markings, projected onto the shell. The draw
 * you got is visible before it hatches, as with every animal.
 */
export function customCoat(d: CustomDesign): (x: number, y: number, b: { x0: number; x1: number; y0: number; y1: number }) => string | null {
  const box = boxOf(d.art)
  return (x, y, b) => {
    const ax = box.x0 + Math.floor(((x - b.x0) / (b.x1 - b.x0 + 1)) * box.w)
    const ay = box.y0 + Math.floor(((y - b.y0) / (b.y1 - b.y0 + 1)) * box.h)
    const ch = d.art[ay]?.[ax]
    if (!ch || ch === '.') return null
    // Its markings as they are; its body colour as a sprinkle, so the shell
    // still reads as a shell.
    if (ch === 'b') return (x + 2 * y) % 4 === 0 ? 'u' : null
    return CUSTOM_CHAR[ch]
  }
}

/**
 * What petSprites.test.ts asks of every built-in body, asked of a custom one:
 * 16x16, only known characters, a face that is inside the grid and a window of
 * plain body (unless it keeps the photo's look), the grown-up's big face, and
 * three sizes that grow. Empty when all is well.
 */
export function bodyProblems(d: CustomDesign, palette: string): string[] {
  const out: string[] = []
  const b = customBodies(d)
  const allowed = palette + CUSTOM_EXTRA
  const dots = (s: Sprite): number => s.rows.join('').replace(/\./g, '').length
  for (const [name, s] of Object.entries(b) as Array<[string, Sprite]>) {
    if (s.rows.length !== G) out.push(`${name}: ${s.rows.length} rows`)
    s.rows.forEach((row, y) => {
      if (row.length !== G) out.push(`${name}: row ${y} is ${row.length} wide`)
      for (const ch of row) if (!allowed.includes(ch)) out.push(`${name}: '${ch}' at row ${y}`)
    })
    if (!s.face) {
      out.push(`${name}: no face`)
      continue
    }
    if (s.face.x < 0 || s.face.y < 0 || s.face.x + 4 > G || s.face.y + 4 > G) out.push(`${name}: face outside`)
    if (!d.noFace) {
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 4; dx++)
          if (s.rows[s.face.y + dy]?.[s.face.x + dx] !== 'b') out.push(`${name}: face window not plain at ${dx},${dy}`)
      if (s.bigFace)
        for (let dy = 0; dy < 4; dy++)
          for (let dx = 0; dx < 6; dx++)
            if (s.rows[s.bigFace.y + dy]?.[s.bigFace.x + dx] !== 'b') out.push(`${name}: big face window not plain`)
    }
  }
  if (!d.noFace && !b.grown.bigFace) out.push('grown: no big face')
  if (dots(b.baby) >= dots(b.grown)) out.push('baby is not smaller than grown')
  if (dots(b.young) > dots(b.grown)) out.push('young is bigger than grown')
  return out
}
