import { describe, it, expect } from 'vitest'
import {
  HISTORY_LIMIT,
  addColor,
  blankDoc,
  clearRect,
  countDots,
  docOfPhoto,
  emptyHistory,
  floodFill,
  fullRect,
  keepBiggest,
  lineCells,
  mirrorX,
  moveRect,
  photoOfDoc,
  piecesOf,
  pushHistory,
  rectCells,
  rectOf,
  redo,
  resampleRows,
  replaceColor,
  stamp,
  stampAll,
  undo
} from './pixelEdit'
import { designFromPicture, finishPhoto } from './petPhoto'
import { MIN_CELLS, cellsOf, sanitizeDesign } from '../state/petSpecies'

/** A grid drawn as text ('.' air, digits colours + 1) for readable expectations. */
const draw = (rows: string[]): Uint8Array => {
  const n = rows.length
  const c = new Uint8Array(n * n)
  rows.forEach((r, y) => [...r].forEach((ch, x) => (c[y * n + x] = ch === '.' ? 0 : Number(ch))))
  return c
}
const show = (c: Uint8Array, n: number): string[] =>
  Array.from({ length: n }, (_, y) => Array.from(c.subarray(y * n, y * n + n), (v) => (v ? String(v) : '.')).join(''))

describe('lineCells', () => {
  it('has no gaps however steep or long, and both ends', () => {
    for (const [x0, y0, x1, y1] of [
      [0, 0, 7, 2],
      [7, 2, 0, 0],
      [3, 0, 3, 9],
      [0, 9, 9, 0],
      [5, 5, 5, 5]
    ]) {
      const pts = lineCells(x0, y0, x1, y1)
      expect(pts[0]).toEqual([x0, y0])
      expect(pts[pts.length - 1]).toEqual([x1, y1])
      expect(pts.length).toBe(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1)
      for (let i = 1; i < pts.length; i++) {
        expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThanOrEqual(1)
        expect(Math.abs(pts[i][1] - pts[i - 1][1])).toBeLessThanOrEqual(1)
      }
    }
  })

  it('a fast drag painted through it leaves a solid stroke', () => {
    const n = 8
    const c = new Uint8Array(n * n)
    stampAll(c, n, n, lineCells(0, 0, 7, 0), 1, 1)
    expect(show(c, n)[0]).toBe('11111111')
  })
})

describe('rectCells', () => {
  it('is an outline with no repeats', () => {
    const pts = rectCells(3, 3, 0, 1)
    const keys = new Set(pts.map((p) => p.join(',')))
    expect(keys.size).toBe(pts.length)
    const c = new Uint8Array(25)
    stampAll(c, 5, 5, pts, 1, 2)
    expect(show(c, 5)).toEqual(['.....', '2222.', '2..2.', '2222.', '.....'])
  })
  it('a single row or dot', () => {
    expect(rectCells(1, 1, 1, 1)).toEqual([[1, 1]])
    expect(rectCells(0, 2, 2, 2)).toHaveLength(3)
  })
})

describe('stamp', () => {
  it('sizes 1, 2, 3 and the edges', () => {
    const n = 5
    let c = new Uint8Array(n * n)
    stamp(c, n, n, 2, 2, 3, 1)
    expect(show(c, n)).toEqual(['.....', '.111.', '.111.', '.111.', '.....'])
    c = new Uint8Array(n * n)
    stamp(c, n, n, 0, 0, 2, 1)
    expect(show(c, n).slice(0, 2)).toEqual(['11...', '11...'])
    c = new Uint8Array(n * n)
    expect(stamp(c, n, n, 0, 0, 3, 1)).toBe(true)
    expect(countDots(c)).toBe(4)
    expect(stamp(c, n, n, 0, 0, 3, 1)).toBe(false)
  })

  it('mirrors left and right', () => {
    const n = 6
    const c = new Uint8Array(n * n)
    stamp(c, n, n, 1, 0, 1, 3, true)
    expect(show(c, n)[0]).toBe('.3..3.')
    expect(mirrorX(n, 1)).toBe(4)
    const d = new Uint8Array(n * n)
    stamp(d, n, n, 0, 0, 2, 1, true)
    expect(show(d, n)[0]).toBe('11..11')
  })
})

describe('floodFill', () => {
  it('fills the four-connected region only (a diagonal does not leak)', () => {
    const c = draw(['.1..', '1...', '....', '....'])
    expect(floodFill(c, 4, 4, 0, 0, 2)).toBe(true)
    expect(show(c, 4)).toEqual(['21..', '1...', '....', '....'])
  })

  it('fills a closed shape inside and leaves the outside', () => {
    const c = draw(['.....', '.111.', '.1.1.', '.111.', '.....'])
    floodFill(c, 5, 5, 2, 2, 3)
    expect(show(c, 5)).toEqual(['.....', '.111.', '.131.', '.111.', '.....'])
  })

  it('does nothing on the same colour, and mirrors', () => {
    const c = draw(['11..', '....', '....', '....'])
    expect(floodFill(c, 4, 4, 0, 0, 1)).toBe(false)
    const m = draw(['1..2', '1..2', '....', '....'])
    floodFill(m, 4, 4, 0, 0, 3, true)
    expect(show(m, 4).slice(0, 2)).toEqual(['3..3', '3..3'])
  })

  it('erases a region with 0', () => {
    const c = draw(['22..', '2...', '....', '...1'])
    floodFill(c, 4, 4, 0, 0, 0)
    expect(countDots(c)).toBe(1)
  })
})

describe('pieces', () => {
  it('corners join, gaps separate, biggest first', () => {
    const c = draw(['11...', '..1..', '.....', '...11', '...11'])
    const p = piecesOf(c, 5, 5)
    expect(p.map((x) => x.length)).toEqual([4, 3])
    expect(keepBiggest(c, 5, 5)).toBe(true)
    expect(show(c, 5)).toEqual(['.....', '.....', '.....', '...11', '...11'])
    expect(keepBiggest(c, 5, 5)).toBe(false)
  })
})

describe('palette', () => {
  it('adds, finds an existing colour, refuses when full', () => {
    const r = addColor(['#000000'], '#FF0000')
    expect(r).toEqual({ palette: ['#000000', '#ff0000'], index: 1 })
    expect(addColor(['#000000', '#ff0000'], '#ff0000')?.index).toBe(1)
    const full = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`)
    expect(addColor(full, '#123456')).toBeNull()
    expect(addColor(full, '#00000f')?.index).toBe(15)
  })
  it('replaces a swatch in place', () => {
    expect(replaceColor(['#000000', '#111111'], 1, '#ABCDEF')).toEqual(['#000000', '#abcdef'])
    const p = ['#000000']
    expect(replaceColor(p, 5, '#ffffff')).toBe(p)
  })
})

describe('history', () => {
  it('undo and redo walk the states', () => {
    let h = emptyHistory<number>()
    h = pushHistory(h, 0)
    h = pushHistory(h, 1)
    let cur = 2
    const u1 = undo(h, cur)!
    expect(u1.state).toBe(1)
    cur = u1.state
    const u2 = undo(u1.history, cur)!
    expect(u2.state).toBe(0)
    expect(undo(u2.history, 0)).toBeNull()
    const r1 = redo(u2.history, 0)!
    expect(r1.state).toBe(1)
    const r2 = redo(r1.history, 1)!
    expect(r2.state).toBe(2)
    expect(redo(r2.history, 2)).toBeNull()
  })

  it('a new edit drops the redo stack', () => {
    let h = pushHistory(emptyHistory<number>(), 0)
    h = undo(h, 1)!.history
    expect(h.future).toHaveLength(1)
    h = pushHistory(h, 0)
    expect(h.future).toHaveLength(0)
  })

  it('is bounded', () => {
    let h = emptyHistory<number>()
    for (let i = 0; i < HISTORY_LIMIT + 30; i++) h = pushHistory(h, i)
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    expect(h.past[0]).toBe(30)
  })

  it('folds a run with the same key into one step', () => {
    let h = emptyHistory<string>()
    h = pushHistory(h, 'a', 'recolor:1')
    h = pushHistory(h, 'b', 'recolor:1')
    h = pushHistory(h, 'c', 'recolor:1')
    expect(h.past).toEqual(['a'])
    h = pushHistory(h, 'd', 'recolor:2')
    h = pushHistory(h, 'e')
    h = pushHistory(h, 'f')
    expect(h.past).toEqual(['a', 'd', 'e', 'f'])
  })
})

describe('docs and pictures', () => {
  it('keeps a tall picture tall and a wide one wide', () => {
    const rows = ['..1.', '..1.', '.111', '.111', '.111', '.111']
    const d = docOfPhoto({ palette: ['#000000'], rows })
    expect([d.w, d.h]).toEqual([4, 6])
    expect(photoOfDoc(d)).toEqual({ palette: ['#000000'], rows })
  })

  it('round-trips a picture', () => {
    const rows = Array.from({ length: 32 }, (_, y) => (y === 3 ? '..01' + '.'.repeat(28) : '.'.repeat(32)))
    const d = docOfPhoto({ palette: ['#000000', '#ffffff'], rows })
    expect(d.w).toBe(32)
    expect(d.h).toBe(32)
    expect(countDots(d.cells)).toBe(2)
    expect(photoOfDoc(d)).toEqual({ palette: ['#000000', '#ffffff'], rows })
    const big = photoOfDoc(blankDoc(48, 48, ['#000000']))
    expect(big.size).toBe(48)
    expect(big.rows).toHaveLength(48)
  })

  it('a picture drawn on a blank canvas becomes a whole design', () => {
    const doc = blankDoc(32, 32, ['#2d2a32', '#f2c38b', '#ffffff'])
    // A body, a head and two separate ears floating above.
    for (let y = 12; y < 28; y++) for (let x = 8; x < 24; x++) stamp(doc.cells, 32, 32, x, y, 1, 2)
    for (let y = 14; y < 18; y++) stamp(doc.cells, 32, 32, 11, y, 1, 3, true)
    stamp(doc.cells, 32, 32, 9, 8, 2, 1, true)
    expect(piecesOf(doc.cells, 32, 32).length).toBe(3)
    const pic = photoOfDoc(doc)
    const photo = finishPhoto(
      pic.rows.map((r) => [...r]),
      pic.palette
    )!
    expect(photo).not.toBeNull()
    const d = designFromPicture(photo, 'Doodle')!
    expect(d).not.toBeNull()
    expect(cellsOf(d.art)).toBeGreaterThanOrEqual(MIN_CELLS)
    // Saved as drawn: the floating ears stay in the picture.
    const clean = sanitizeDesign(d)!
    expect(clean.photo?.rows).toEqual(photo.rows)
    expect(clean.noFace).toBe(true)
  })

  it('too few dots is no picture', () => {
    const doc = blankDoc(32, 32, ['#000000'])
    stamp(doc.cells, 32, 32, 5, 5, 3, 1)
    const pic = photoOfDoc(doc)
    expect(finishPhoto(pic.rows.map((r) => [...r]), pic.palette)).toBeNull()
  })
})

describe('moving and clearing a part of the picture', () => {
  it('moves the whole picture by an offset and drops what leaves the edge', () => {
    const n = 4
    const cells = new Uint8Array(n * n)
    cells[0] = 1 // top-left
    cells[1 * n + 3] = 2 // right edge
    moveRect(cells, n, n, fullRect(n, n), 1, 1)
    expect(cells[1 * n + 1]).toBe(1)
    // the dot at x=3 would go to x=4: gone
    expect(Array.from(cells).filter((v) => v === 2)).toHaveLength(0)
  })

  it('moves only the selected part and leaves the rest alone', () => {
    const n = 4
    const cells = new Uint8Array(n * n)
    cells[0] = 1
    cells[3 * n + 3] = 2
    moveRect(cells, n, n, { x0: 0, y0: 0, x1: 1, y1: 1 }, 2, 0)
    expect(cells[0]).toBe(0)
    expect(cells[2]).toBe(1)
    expect(cells[3 * n + 3]).toBe(2)
  })

  it('clears only the selected rectangle', () => {
    const n = 3
    const cells = new Uint8Array(n * n).fill(1)
    clearRect(cells, n, { x0: 1, y0: 1, x1: 2, y1: 2 })
    expect(Array.from(cells)).toEqual([1, 1, 1, 1, 0, 0, 1, 0, 0])
  })

  it('makes a rectangle from two corners in either order', () => {
    expect(rectOf(3, 1, 1, 3)).toEqual({ x0: 1, y0: 1, x1: 3, y1: 3 })
  })
})

describe('changing a finished picture grid', () => {
  it('grows by repeating dots and shrinks by dropping them', () => {
    expect(resampleRows(['01', '23'], 4, 2)).toEqual(['0011', '2233'])
    expect(resampleRows(['0011', '2233'], 2, 2)).toEqual(['01', '23'])
  })
  it('takes a new width and height on their own (a tall picture from a square one)', () => {
    expect(resampleRows(['01', '23'], 2, 4)).toEqual(['01', '01', '23', '23'])
  })
})
