import { PHOTO, PHOTO_CHARS, PHOTO_MAX_COLORS, type PhotoArt, type PhotoSize } from './petPhotoGrid'

// ---------------------------------------------------------------------------
// The pet maker's little pixel editor, the pure half (PetPixelEditor.tsx draws
// it and turns pointers into these calls). A picture is a square of cells, one
// byte each: 0 is air, k + 1 is palette colour k. Everything here works on
// that flat array in place or returns a new one, so it is tested without a
// browser and a stroke over a 64x64 grid never allocates per dot.
// ---------------------------------------------------------------------------

export const EMPTY = 0

/** What is being drawn: the grid and its colours. */
export interface PixelDoc {
  n: number
  cells: Uint8Array
  palette: string[]
}

export const cloneDoc = (d: PixelDoc): PixelDoc => ({ n: d.n, cells: d.cells.slice(), palette: [...d.palette] })

/** A picture's rows into cells. */
export function docOfPhoto(p: PhotoArt): PixelDoc {
  const n = p.rows.length
  const cells = new Uint8Array(n * n)
  p.rows.forEach((row, y) => {
    for (let x = 0; x < n; x++) {
      const ch = row[x]
      if (ch && ch !== '.') cells[y * n + x] = PHOTO_CHARS.indexOf(ch) + 1
    }
  })
  return { n, cells, palette: [...p.palette] }
}

/** Cells back into a picture's rows (unused colours are kept; finishPhoto drops them on save). */
export function photoOfDoc(d: PixelDoc): PhotoArt {
  const rows: string[] = []
  for (let y = 0; y < d.n; y++) {
    let row = ''
    for (let x = 0; x < d.n; x++) {
      const v = d.cells[y * d.n + x]
      row += v ? PHOTO_CHARS[v - 1] : '.'
    }
    rows.push(row)
  }
  return d.n === PHOTO ? { palette: [...d.palette], rows } : { palette: [...d.palette], rows, size: d.n as PhotoSize }
}

export const blankDoc = (n: number, palette: string[]): PixelDoc => ({ n, cells: new Uint8Array(n * n), palette: [...palette] })

export const countDots = (cells: Uint8Array): number => {
  let k = 0
  for (let i = 0; i < cells.length; i++) if (cells[i]) k++
  return k
}

// ---- drawing ----

/** The dot mirrored across the vertical middle. */
export const mirrorX = (n: number, x: number): number => n - 1 - x

/** Every cell on the straight line from a to b, ends included, with no gaps (Bresenham). */
export function lineCells(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let x = x0
  let y = y0
  for (;;) {
    out.push([x, y])
    if (x === x1 && y === y1) return out
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
}

/** The outline of the rectangle with corners a and b. */
export function rectCells(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const [l, r] = x0 < x1 ? [x0, x1] : [x1, x0]
  const [t, b] = y0 < y1 ? [y0, y1] : [y1, y0]
  for (let x = l; x <= r; x++) {
    out.push([x, t])
    if (b !== t) out.push([x, b])
  }
  for (let y = t + 1; y < b; y++) {
    out.push([l, y])
    if (r !== l) out.push([r, y])
  }
  return out
}

/**
 * A square brush of `size` (1, 2 or 3) at (x, y), and its mirror image when
 * `mirror`. A size-2 brush covers the dot and the ones right and below, a 3
 * is centred. Returns whether anything changed.
 */
export function stamp(cells: Uint8Array, n: number, x: number, y: number, size: number, value: number, mirror = false): boolean {
  const from = -Math.floor((size - 1) / 2)
  let changed = false
  const put = (px: number, py: number): void => {
    if (px < 0 || py < 0 || px >= n || py >= n) return
    const i = py * n + px
    if (cells[i] === value) return
    cells[i] = value
    changed = true
  }
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      put(x + from + dx, y + from + dy)
      if (mirror) put(mirrorX(n, x + from + dx), y + from + dy)
    }
  return changed
}

/** Stamps along a list of cells (a line, a rectangle, a dragged stroke). */
export function stampAll(
  cells: Uint8Array,
  n: number,
  pts: Array<[number, number]>,
  size: number,
  value: number,
  mirror = false
): boolean {
  let changed = false
  for (const [x, y] of pts) if (stamp(cells, n, x, y, size, value, mirror)) changed = true
  return changed
}

/**
 * Fill: every cell four-connected to (x, y) through the same value as it
 * becomes `value` (air fills air too, so a fill outside the pet floods the
 * background). With `mirror`, the mirrored cell is filled the same way.
 */
export function floodFill(cells: Uint8Array, n: number, x: number, y: number, value: number, mirror = false): boolean {
  const one = (sx: number, sy: number): boolean => {
    if (sx < 0 || sy < 0 || sx >= n || sy >= n) return false
    const from = cells[sy * n + sx]
    if (from === value) return false
    const stack = [sy * n + sx]
    cells[sy * n + sx] = value
    while (stack.length) {
      const p = stack.pop()!
      const px = p % n
      const py = (p - px) / n
      const visit = (q: number): void => {
        if (cells[q] !== from) return
        cells[q] = value
        stack.push(q)
      }
      if (px > 0) visit(p - 1)
      if (px < n - 1) visit(p + 1)
      if (py > 0) visit(p - n)
      if (py < n - 1) visit(p + n)
    }
    return true
  }
  const a = one(x, y)
  const b = mirror ? one(mirrorX(n, x), y) : false
  return a || b
}

// ---- pieces ----

/**
 * The separate pieces of the drawing, biggest first, as lists of cell
 * indices. Corners join (eight-connected), the same rule the photo's own
 * clean-up (petCustomArt tidy) uses, so a thin leg drawn corner to corner is
 * one piece with its body.
 */
export function piecesOf(cells: Uint8Array, n: number): number[][] {
  const seen = new Uint8Array(cells.length)
  const out: number[][] = []
  for (let s = 0; s < cells.length; s++) {
    if (!cells[s] || seen[s]) continue
    const part: number[] = []
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const p = stack.pop()!
      part.push(p)
      const px = p % n
      const py = (p - px) / n
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx
          const qy = py + dy
          if ((!dx && !dy) || qx < 0 || qy < 0 || qx >= n || qy >= n) continue
          const q = qy * n + qx
          if (!cells[q] || seen[q]) continue
          seen[q] = 1
          stack.push(q)
        }
    }
    out.push(part)
  }
  return out.sort((a, b) => b.length - a.length)
}

/** Only the biggest piece is kept; returns whether anything went. */
export function keepBiggest(cells: Uint8Array, n: number): boolean {
  const pieces = piecesOf(cells, n)
  if (pieces.length < 2) return false
  for (const part of pieces.slice(1)) for (const p of part) cells[p] = EMPTY
  return true
}

// ---- palette ----

export const MAX_COLORS = PHOTO_MAX_COLORS

/**
 * A colour added to the palette: its index, the same index when it is
 * already there, or null when the palette is full (the caller then offers to
 * replace a swatch instead).
 */
export function addColor(palette: string[], hex: string, max = MAX_COLORS): { palette: string[]; index: number } | null {
  const c = hex.toLowerCase()
  const at = palette.indexOf(c)
  if (at >= 0) return { palette, index: at }
  if (palette.length >= max) return null
  return { palette: [...palette, c], index: palette.length }
}

/** Swatch `i` becomes `hex`: every dot of that colour changes with it. */
export function replaceColor(palette: string[], i: number, hex: string): string[] {
  if (i < 0 || i >= palette.length) return palette
  return palette.map((p, k) => (k === i ? hex.toLowerCase() : p))
}

// ---- undo ----

/** Undo and redo stacks of whole states (a 64x64 grid is 4 KB, so a snapshot is cheap). */
export interface History<T> {
  past: T[]
  future: T[]
  /** What the last push was, so a run of the same edit (dragging a colour picker) is one step. */
  key: string | null
}

export const HISTORY_LIMIT = 100

export const emptyHistory = <T>(): History<T> => ({ past: [], future: [], key: null })

/**
 * `before` (the state the edit started from) goes on the undo stack, the
 * redo stack is dropped. A push with the same non-null `key` as the last one
 * is folded into it (its `before` is older and already there).
 */
export function pushHistory<T>(h: History<T>, before: T, key: string | null = null, limit = HISTORY_LIMIT): History<T> {
  if (key !== null && key === h.key && h.past.length) return { past: h.past, future: [], key }
  const past = [...h.past, before]
  if (past.length > limit) past.splice(0, past.length - limit)
  return { past, future: [], key }
}

/** One step back: the state to show, and the stacks after it. Null when there is nothing to undo. */
export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (!h.past.length) return null
  const state = h.past[h.past.length - 1]
  return { history: { past: h.past.slice(0, -1), future: [...h.future, current], key: null }, state }
}

export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (!h.future.length) return null
  const state = h.future[h.future.length - 1]
  return { history: { past: [...h.past, current], future: h.future.slice(0, -1), key: null }, state }
}
