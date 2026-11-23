import { describe, it, expect, beforeAll } from 'vitest'
import { CUSTOM_EXTRA, bodyProblems, customBody } from './petCustomArt'
import { GRID, PALETTE, SPRITE_SIZE, bigFaceOf, bodyOf, outfitPixels, pixelsOf } from './petSprites'
import { backgroundMask, cropSquare, defaultCrop, designFromPhoto, foregroundOf, type Rgba } from '../lib/petPhoto'
import { catPhoto, diskPhoto, fishPhoto, penguinPhoto } from '../lib/petPhoto.fixtures'
import { ART, noteDesign, type CustomDesign, type CustomSpeciesId } from '../state/petSpecies'

const COLORS = { body: '#c08040', shade: '#603010', highlight: '#e0b080', accent: '#4080c0', white: '#f4f0ea' }
const fromPhoto = (img: Rgba, name: string): CustomDesign => {
  const sq = cropSquare(img, defaultCrop(img.width, img.height))
  return designFromPhoto(sq, foregroundOf(backgroundMask(sq, 18)), name)!
}
const fill = (f: (x: number, y: number) => string): string[] =>
  Array.from({ length: ART }, (_, y) => Array.from({ length: ART }, (_, x) => f(x, y)).join(''))

// Photos, and the awkward shapes a hand in the dot editor can make.
const DESIGNS: Record<string, CustomDesign> = {
  cat: fromPhoto(catPhoto(), 'cat'),
  fish: fromPhoto(fishPhoto(), 'fish'),
  penguin: fromPhoto(penguinPhoto(), 'penguin'),
  disk: fromPhoto(diskPhoto(), 'disk'),
  // A thin pole: no 6x4 window fits anywhere, so the body makes room.
  pole: { name: 'pole', colors: COLORS, art: fill((x) => (x >= 4 && x <= 7 ? 'b' : '.')), face: { x: 3, y: 2 }, noFace: false },
  // Full to every edge of the art.
  block: { name: 'block', colors: COLORS, art: fill((x, y) => ((x + y) % 5 === 0 ? 'a' : 'b')), face: { x: 3, y: 2 }, noFace: false },
  // A low, wide one, all at the bottom.
  flat: { name: 'flat', colors: COLORS, art: fill((_, y) => (y >= 7 ? (y === 11 ? 's' : 'b') : '.')), face: { x: 3, y: 7 }, noFace: false },
  // The photo's look kept: no face stamped, its markings left where they are.
  bare: { name: 'bare', colors: COLORS, art: fill((x, y) => ((x * y) % 4 === 0 ? 'h' : 'w')), face: { x: 3, y: 3 }, noFace: true }
}
const ids = Object.keys(DESIGNS).map((k) => `u-test${k}` as CustomSpeciesId)

beforeAll(() => {
  Object.entries(DESIGNS).forEach(([k, d]) => noteDesign(`u-test${k}`, d))
})

describe('custom bodies', () => {
  it.each(Object.keys(DESIGNS))('%s passes every check the built-in bodies pass', (k) => {
    expect(bodyProblems(DESIGNS[k], PALETTE)).toEqual([])
  })

  it('only uses the palette and the photo colours', () => {
    for (const d of Object.values(DESIGNS))
      for (const ch of customBody(d).rows.join('')) expect(PALETTE + CUSTOM_EXTRA).toContain(ch)
  })

  it('draws the same dots for the same design, every time', () => {
    const copy = JSON.parse(JSON.stringify(DESIGNS.cat)) as CustomDesign
    expect(customBody(copy)).toEqual(customBody(DESIGNS.cat))
  })
})

describe('a custom species through pixelsOf', () => {
  it('is drawn inside the grid, in every mood', () => {
    for (const id of ids)
      for (const mood of ['happy', 'ok', 'sad'] as const)
        for (const d of pixelsOf(mood, id)) {
          expect(d.x >= 0 && d.x < SPRITE_SIZE && d.y >= 0 && d.y < SPRITE_SIZE).toBe(true)
        }
  })

  it('wears its own colours', () => {
    const cat = pixelsOf('ok', 'u-testcat')
    expect(cat.some((d) => d.ch === 'n')).toBe(true)
    expect(cat.some((d) => d.ch === 'v')).toBe(true)
  })

  it('shows its mood on its face, unless it keeps the photo look', () => {
    for (const id of ids) {
      const eyes = pixelsOf('happy', id).filter((d) => d.ch === 'e')
      if (id === 'u-testbare') expect(eyes).toEqual([])
      else expect(eyes.length, id).toBeGreaterThanOrEqual(8)
    }
    for (const id of ids.filter((i) => i !== 'u-testbare')) expect(bigFaceOf(bodyOf(id)), id).not.toBeNull()
  })

  it('wears prizes and decorations off its face, with or without one', () => {
    for (const id of ids) {
      const body = bodyOf(id)
      const face = bigFaceOf(body) ?? { ...body.face! }
      const w = bigFaceOf(body) ? 12 : 8
      for (const level of [1, 50]) {
        const { back, front } = outfitPixels(id, ['crown', 'scarf', 'star'], level)
        expect(back.length + front.length, id).toBeGreaterThan(0)
        for (const d of [...back, ...front]) {
          const onFace = d.x >= face.x * 2 && d.x < face.x * 2 + w && d.y >= face.y * 2 && d.y < face.y * 2 + 8
          expect(onFace, `${id} Lv${level}`).toBe(false)
        }
      }
      expect(outfitPixels(id, [], 50).back.some((d) => d.ch === 'g'), id).toBe(true)
    }
  })

  it('falls back to a drawable animal for a species nobody knows', () => {
    expect(bodyOf('u-nobodyknows').rows).toHaveLength(GRID)
    expect(pixelsOf('ok', 'u-nobodyknows').length).toBeGreaterThan(0)
  })
})
