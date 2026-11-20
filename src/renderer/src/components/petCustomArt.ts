import { ART, ART_AT, type CustomDesign } from '../state/petSpecies'
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
const inside = (ch: string | undefined): boolean => !!ch && ch !== '.' && ch !== 'o'

/** A 1-dot outline round everything drawn, four-connected so corners come out round. */
function outline(g: Grid): void {
  const before = g.map((r) => [...r])
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++)
      if (before[y][x] === '.' && N4.some(([dx, dy]) => inside(before[y + dy]?.[x + dx]))) g[y][x] = 'o'
}

/**
 * One piece, no holes: only the largest four-connected part is kept, and any
 * gap the outside cannot reach is filled with the colour around it.
 */
export function tidy(g: string[][]): void {
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
        for (const [dx, dy] of N4) {
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
function boxOf(art: string[]): Box {
  let x0 = ART
  let x1 = -1
  let y0 = ART
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
  return x1 < 0 ? { x0: 0, y0: 0, w: ART, h: ART } : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
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
  const bodies = {
    // The built-in hatchlings sit in their shell with the body on rows 3..10,
    // the children stand on row 12, the grown-ups fill the grid.
    baby: smaller(d, 0.58, 9, true),
    young: smaller(d, 0.78, 11, false),
    grown: grownOf(d)
  }
  cache.set(d, bodies)
  return bodies
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
