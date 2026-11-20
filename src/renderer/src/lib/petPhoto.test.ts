import { describe, it, expect } from 'vitest'
import {
  WORK,
  assignRoles,
  backgroundMask,
  cropSquare,
  defaultCrop,
  designFromPhoto,
  dotsOf,
  faceSpots,
  foregroundOf,
  labOf,
  paintBrush,
  suggestFace,
  type Rgba
} from './petPhoto'
import { canvas, catPhoto, diskPhoto, fishPhoto, paint, penguinPhoto } from './petPhoto.fixtures'
import { ART, cellsOf, hslOf } from '../state/petSpecies'

const square = (img: Rgba): Rgba => cropSquare(img, defaultCrop(img.width, img.height))
const cutout = (img: Rgba, tol = 18): { sq: Rgba; fg: Uint8Array } => {
  const sq = square(img)
  return { sq, fg: foregroundOf(backgroundMask(sq, tol)) }
}
const sum = (m: Uint8Array): number => m.reduce((n, v) => n + v, 0)

/** Four-connected parts of a grid of characters. */
function parts(art: string[]): number {
  const seen = new Set<string>()
  let n = 0
  art.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.' || seen.has(`${x},${y}`)) return
      n++
      const stack = [[x, y]]
      seen.add(`${x},${y}`)
      while (stack.length) {
        const [cx, cy] = stack.pop()!
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx
          const ny = cy + dy
          if (art[ny]?.[nx] === undefined || art[ny][nx] === '.' || seen.has(`${nx},${ny}`)) continue
          seen.add(`${nx},${ny}`)
          stack.push([nx, ny])
        }
      }
    })
  )
  return n
}

describe('cropSquare', () => {
  it('resamples a square region to the working size', () => {
    const img = canvas(300, 200, (x) => (x < 150 ? [255, 0, 0] : [0, 0, 255]))
    const sq = cropSquare(img, defaultCrop(300, 200))
    expect(sq.width).toBe(WORK)
    expect(sq.height).toBe(WORK)
    // Left half red, right half blue, as in the middle 200x200 of the original.
    expect([sq.data[(64 * WORK + 10) * 4], sq.data[(64 * WORK + 10) * 4 + 2]]).toEqual([255, 0])
    expect([sq.data[(64 * WORK + 120) * 4], sq.data[(64 * WORK + 120) * 4 + 2]]).toEqual([0, 255])
  })

  it('treats outside the picture as transparent', () => {
    const img = canvas(10, 10, () => [10, 20, 30])
    const sq = cropSquare(img, { x: -10, y: 0, size: 20 }, 20)
    expect(sq.data[(5 * 20 + 2) * 4 + 3]).toBe(0)
    expect(sq.data[(5 * 20 + 15) * 4 + 3]).toBe(255)
  })
})

describe('background removal', () => {
  it('floods a flat background from the edges and keeps the subject', () => {
    const { sq, fg } = cutout(diskPhoto())
    // The disk is ~pi*40^2 of 128^2.
    const share = sum(fg) / (sq.width * sq.height)
    expect(share).toBeGreaterThan(0.28)
    expect(share).toBeLessThan(0.33)
    expect(fg[64 * WORK + 64]).toBe(1)
    expect(fg[2 * WORK + 2]).toBe(0)
  })

  it('takes a gradient background with it', () => {
    const { fg } = cutout(catPhoto())
    expect(fg[3 * WORK + 3]).toBe(0)
    expect(fg[125 * WORK + 125]).toBe(0)
    expect(fg[74 * WORK + 64]).toBe(1)
  })

  it('does not eat a hole of background colour that the edge cannot reach', () => {
    const img = diskPhoto()
    paint(img, (x, y) => (x - 64) ** 2 + (y - 64) ** 2 <= 36, () => [240, 240, 240])
    const { fg } = cutout(img)
    expect(fg[64 * WORK + 64]).toBe(1)
  })

  it('keeps a subject that runs off the frame', () => {
    // The fish's tail touches the right edge: its blue must not become "background".
    const { fg } = cutout(fishPhoto())
    expect(fg[64 * WORK + 64]).toBe(1)
    expect(fg[64 * WORK + 126]).toBe(1)
  })

  it('takes more with a higher tolerance', () => {
    const img = diskPhoto(128, 40, [210, 200, 200], [240, 240, 240])
    const low = sum(foregroundOf(backgroundMask(square(img), 5)))
    const high = sum(foregroundOf(backgroundMask(square(img), 40)))
    expect(high).toBeLessThan(low)
  })

  it('counts transparent pixels as background', () => {
    const img = canvas(64, 64, () => [0, 0, 0, 0])
    paint(img, (x, y) => (x - 32) ** 2 + (y - 32) ** 2 <= 400, () => [0, 0, 0])
    const fg = foregroundOf(backgroundMask(cropSquare(img, { x: 0, y: 0, size: 64 }, 64), 10))
    expect(fg[32 * 64 + 32]).toBe(1)
    expect(fg[0]).toBe(0)
  })

  it('lets the brush keep and erase by hand', () => {
    const sq = square(diskPhoto())
    const bg = backgroundMask(sq, 18)
    const brush = new Uint8Array(bg.length)
    paintBrush(brush, WORK, 5, 5, 3, 'keep')
    paintBrush(brush, WORK, 64, 64, 4, 'erase')
    const fg = foregroundOf(bg, brush)
    expect(fg[5 * WORK + 5]).toBe(1)
    expect(fg[64 * WORK + 64]).toBe(0)
    expect(fg[64 * WORK + 75]).toBe(1)
  })
})

describe('dots', () => {
  it('turns a disk into one round blob that fills the art', () => {
    const { sq, fg } = cutout(diskPhoto())
    const dots = dotsOf(sq, fg)!
    expect(dots.art).toHaveLength(ART)
    for (const row of dots.art) expect(row).toHaveLength(ART)
    expect(parts(dots.art)).toBe(1)
    // A circle in a 12x12 square: about pi/4 of it.
    const n = cellsOf(dots.art)
    expect(n).toBeGreaterThan(144 * 0.65)
    expect(n).toBeLessThan(144 * 0.9)
    // Round: the corners are empty, the middle row is full.
    expect(dots.art[0][0]).toBe('.')
    expect(dots.art[11][11]).toBe('.')
    expect(dots.art[6]).not.toContain('.')
    // Symmetric, near enough.
    const mirrored = dots.art.map((r) => [...r].reverse().join(''))
    let diff = 0
    dots.art.forEach((r, y) => [...r].forEach((ch, x) => (diff += (ch === '.') !== (mirrored[y][x] === '.') ? 1 : 0)))
    expect(diff).toBeLessThanOrEqual(4)
  })

  it('drops specks and fills holes, so the shape reads as one piece', () => {
    const img = diskPhoto()
    // A speck of subject far from it, and a hole cut through it to the background.
    paint(img, (x, y) => x > 4 && x < 9 && y > 4 && y < 9, () => [200, 60, 80])
    paint(img, (x, y) => (x - 64) ** 2 + (y - 64) ** 2 <= 64, () => [10, 10, 10])
    const sq = square(img)
    const bg = backgroundMask(sq, 18)
    const brush = new Uint8Array(bg.length)
    paintBrush(brush, WORK, 64, 64, 8, 'erase')
    const dots = dotsOf(sq, foregroundOf(bg, brush))!
    expect(parts(dots.art)).toBe(1)
    expect(dots.art[5][5]).not.toBe('.')
    expect(dots.art[6][6]).not.toBe('.')
  })

  it('keeps the proportions of a long subject, standing on the bottom row', () => {
    const { sq, fg } = cutout(penguinPhoto())
    const dots = dotsOf(sq, fg)!
    const cols = new Set<number>()
    dots.art.forEach((r) => [...r].forEach((ch, x) => ch !== '.' && cols.add(x)))
    expect(cols.size).toBeLessThanOrEqual(8)
    expect(dots.art[ART - 1]).not.toBe('.'.repeat(ART))
  })

  it('gives nothing for an empty cut-out', () => {
    const sq = square(diskPhoto())
    expect(dotsOf(sq, new Uint8Array(sq.width * sq.height))).toBeNull()
  })
})

describe('colours', () => {
  it('reads body, shade, white and markings off the photo, by lightness', () => {
    const { sq, fg } = cutout(catPhoto())
    const d = dotsOf(sq, fg)!
    const body = hslOf(d.colors.body)
    // Orange body.
    expect(body.h).toBeGreaterThan(18)
    expect(body.h).toBeLessThan(40)
    expect(body.s).toBeGreaterThan(0.5)
    const L = (hex: string): number => labOf(...(hex.match(/\w\w/g)!.map((v) => parseInt(v, 16)) as [number, number, number]))[0]
    // The dark chin is the shade, the muzzle the white.
    expect(L(d.colors.shade)).toBeLessThan(L(d.colors.body))
    expect(L(d.colors.white)).toBeGreaterThan(90)
    const all = d.art.join('')
    expect(all).toContain('s')
    expect(all).toContain('w')
    // Mostly body.
    expect(all.split('b').length - 1).toBeGreaterThan(cellsOf(d.art) / 2)
    // The muzzle is low in the middle, where it was.
    expect(d.art[9].slice(4, 8)).toContain('w')
  })

  it('takes a different colour as the accent', () => {
    const { sq, fg } = cutout(fishPhoto())
    const d = dotsOf(sq, fg)!
    expect(hslOf(d.colors.body).h).toBeGreaterThan(190)
    expect(hslOf(d.colors.body).h).toBeLessThan(230)
    const accent = hslOf(d.colors.accent)
    expect(accent.h).toBeGreaterThan(35)
    expect(accent.h).toBeLessThan(55)
    expect(d.art.join('')).toContain('a')
  })

  it('makes up the colours a one-colour subject does not have', () => {
    const { sq, fg } = cutout(diskPhoto())
    const d = dotsOf(sq, fg)!
    expect(d.art.join('').replace(/[.b]/g, '')).toBe('')
    for (const c of Object.values(d.colors)) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    expect(new Set(Object.values(d.colors)).size).toBe(5)
  })

  it('merges a colour barely different from the body into it', () => {
    const lab = labOf(200, 60, 80)
    const near = labOf(204, 62, 82)
    const { roles } = assignRoles([
      { lab, rgb: [200, 60, 80], count: 100 },
      { lab: near, rgb: [204, 62, 82], count: 40 }
    ])
    expect(roles).toEqual(['b', 'b'])
  })

  it('is deterministic: the same photo makes the same design', () => {
    const a = cutout(catPhoto())
    const b = cutout(catPhoto())
    expect(designFromPhoto(a.sq, a.fg, 'x')).toEqual(designFromPhoto(b.sq, b.fg, 'x'))
  })
})

describe('the face spot', () => {
  it('suggests a window that is all dots, up in the middle', () => {
    for (const photo of [catPhoto(), diskPhoto(), penguinPhoto()]) {
      const { sq, fg } = cutout(photo)
      const d = designFromPhoto(sq, fg, 'x')!
      const spots = faceSpots(d.art)
      expect(spots).toContainEqual(d.face)
      expect(d.face.y).toBeLessThan(ART / 2)
      expect(Math.abs(d.face.x + 3 - ART / 2)).toBeLessThanOrEqual(2)
    }
  })

  it('prefers the flat plain part over a patterned one', () => {
    // The lower half of a square is striped; the face goes in the plain top.
    const art = Array.from({ length: ART }, (_, y) => (y < 6 ? 'b'.repeat(ART) : 'sa'.repeat(ART / 2)))
    const colors = { body: '#c08040', shade: '#603010', highlight: '#e0b080', accent: '#4080c0', white: '#f0f0f0' }
    const at = suggestFace(art, colors)
    expect(at.y + 4).toBeLessThanOrEqual(6)
  })

  it('still answers where no window fits', () => {
    const art = Array.from({ length: ART }, () => '.....bb.....')
    const at = suggestFace(art, { body: '#c08040', shade: '#603010', highlight: '#e0b080', accent: '#4080c0', white: '#f0f0f0' })
    expect(at.x).toBeGreaterThanOrEqual(0)
    expect(at.x + 6).toBeLessThanOrEqual(ART)
  })
})
