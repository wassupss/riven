import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TOLERANCE,
  MIN_CROP,
  autoCrop,
  backgroundMask,
  clampCrop,
  cropSquare,
  defaultCrop,
  faithfulDesignFromPhoto,
  foregroundOf,
  squareAround,
  subjectBox,
  type Crop
} from './petPhoto'
import { PHOTO, PHOTO_MAX_COLORS } from '../state/petSpecies'
import { canvas, catPhoto, grain, paint } from './petPhoto.fixtures'
import { nextName } from './petMaker'

/** Whether a crop holds a box (inclusive pixel bounds) whole. */
const holds = (c: Crop, b: { x0: number; y0: number; x1: number; y1: number }): boolean =>
  c.x <= b.x0 && c.y <= b.y0 && c.x + c.size >= b.x1 + 1 && c.y + c.size >= b.y1 + 1

describe('subjectBox', () => {
  it('is null for an empty mask', () => {
    expect(subjectBox(new Uint8Array(16), 4)).toBeNull()
  })

  it('boxes the largest piece only, a speck elsewhere left out', () => {
    const w = 10
    const m = new Uint8Array(w * w)
    for (let y = 2; y <= 6; y++) for (let x = 3; x <= 7; x++) m[y * w + x] = 1
    m[9 * w + 0] = 1
    expect(subjectBox(m, w)).toEqual({ x0: 3, y0: 2, x1: 7, y1: 6, count: 25 })
  })
})

describe('squareAround', () => {
  it('is square, centred on the box, with air round it', () => {
    const c = squareAround({ x0: 100, y0: 50, x1: 140, y1: 130 }, 400, 300, 0.1)
    // 80 tall: 80 * 1.2 = 96.
    expect(c.size).toBe(96)
    expect(c.x + c.size / 2).toBeCloseTo(120, 0)
    expect(c.y + c.size / 2).toBeCloseTo(90, 0)
  })

  it('stays on the photo near an edge', () => {
    const c = squareAround({ x0: 0, y0: 0, x1: 30, y1: 30 }, 200, 100)
    expect(c.x).toBe(0)
    expect(c.y).toBe(0)
  })

  it('is never bigger than the long side, and centred where it cannot fit', () => {
    const c = squareAround({ x0: 0, y0: 0, x1: 200, y1: 100 }, 200, 100)
    expect(c.size).toBe(200)
    expect(c.x).toBe(0)
    expect(c.y).toBe(-50)
  })

  it('is never smaller than MIN_CROP', () => {
    expect(squareAround({ x0: 5, y0: 5, x1: 6, y1: 6 }, 100, 100).size).toBe(MIN_CROP)
  })
})

describe('clampCrop', () => {
  it('keeps the size between MIN_CROP and the long side', () => {
    expect(clampCrop({ x: 0, y: 0, size: 2 }, 100, 50).size).toBe(MIN_CROP)
    expect(clampCrop({ x: 0, y: 0, size: 500 }, 100, 50).size).toBe(100)
  })

  it('lets at most half of it off the photo', () => {
    const c = clampCrop({ x: -200, y: 999, size: 40 }, 100, 80)
    expect(c.x).toBe(-20)
    expect(c.y).toBe(60)
  })
})

describe('autoCrop', () => {
  it('finds a subject off centre on a wide photo', () => {
    const img = canvas(300, 200, (x, y) => [232 + grain(x, y) / 3, 234, 236])
    // A red animal near the right edge: x 200..260, y 90..150.
    paint(img, (x, y) => (x - 230) ** 2 / 30 ** 2 + (y - 120) ** 2 / 30 ** 2 <= 1, () => [200, 60, 70])
    const c = autoCrop(img)
    expect(holds(c, { x0: 201, y0: 91, x1: 259, y1: 149 })).toBe(true)
    // Much tighter than the centred square (200), which would cut the animal off.
    expect(c.size).toBeLessThan(110)
    expect(holds(defaultCrop(300, 200), { x0: 201, y0: 91, x1: 259, y1: 149 })).toBe(false)
    // Air on every side, so the cut-out still reads the background off the edges.
    expect(c.x).toBeLessThan(201)
    expect(c.x + c.size).toBeGreaterThan(260)
  })

  it('goes photo to picture with the defaults alone (the two-click path)', () => {
    const img = canvas(300, 200, (x, y) => [232 + grain(x, y) / 3, 234, 236])
    paint(img, (x, y) => (x - 230) ** 2 / 30 ** 2 + (y - 120) ** 2 / 30 ** 2 <= 1, () => [200, 60, 70])
    const sq = cropSquare(img, autoCrop(img))
    const d = faithfulDesignFromPhoto(sq, foregroundOf(backgroundMask(sq, DEFAULT_TOLERANCE)), 'x', PHOTO_MAX_COLORS, PHOTO)
    expect(d?.photo?.rows.length).toBe(PHOTO)
  })

  it('holds the whole cat, ears included', () => {
    const c = autoCrop(catPhoto())
    // Ears from y 22, head to y 112, x 24..104.
    expect(holds(c, { x0: 26, y0: 24, x1: 102, y1: 110 })).toBe(true)
  })

  it('falls back to the centred square when nothing stands out', () => {
    const flat = canvas(160, 100, (x, y) => [120 + grain(x, y) / 4, 130, 140])
    expect(autoCrop(flat)).toEqual(defaultCrop(160, 100))
  })

  it('falls back when the subject fills the photo', () => {
    const img = canvas(100, 100, () => [240, 240, 240])
    paint(img, (x, y) => x > 0 && y > 0 && x < 99 && y < 99, () => [30, 90, 200])
    expect(autoCrop(img)).toEqual(defaultCrop(100, 100))
  })

  it('falls back for a speck', () => {
    const img = canvas(200, 200, () => [240, 240, 240])
    paint(img, (x, y) => x >= 50 && x < 53 && y >= 50 && y < 53, () => [0, 0, 0])
    expect(autoCrop(img)).toEqual(defaultCrop(200, 200))
  })
})

describe('nextName', () => {
  const label = (n: number): string => `내 펫 ${n}`

  it('starts at 1', () => {
    expect(nextName([], label)).toBe('내 펫 1')
    expect(nextName(['치즈'], label)).toBe('내 펫 1')
  })

  it('skips names in use, trimmed and case-blind', () => {
    expect(nextName(['내 펫 1', ' 내 펫 2 '], label)).toBe('내 펫 3')
    expect(nextName(['내 펫 2'], label)).toBe('내 펫 1')
    expect(nextName(['MY PET 1'], (n) => `My pet ${n}`)).toBe('My pet 2')
  })
})
