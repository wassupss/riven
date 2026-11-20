import { describe, it, expect, beforeAll } from 'vitest'
import { CUSTOM_EXTRA, bodyProblems, customBodies } from './petCustomArt'
import { GRID, PALETTE, SPRITE_SIZE, bigFaceOf, bodyOf, outfitPixels, pixelsOf } from './petSprites'
import { backgroundMask, cropSquare, defaultCrop, designFromPhoto, foregroundOf, type Rgba } from '../lib/petPhoto'
import { catPhoto, diskPhoto, fishPhoto, penguinPhoto } from '../lib/petPhoto.fixtures'
import { ART, noteDesign, type CustomDesign, type CustomSpeciesId } from '../state/petSpecies'
import { FORMS, STAGES } from '../state/pet'

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
  // A thin pole: no 6x4 window fits anywhere, so the bodies make room.
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

  it('grows through three sizes, the hatchling in its shell', () => {
    for (const d of Object.values(DESIGNS)) {
      const b = customBodies(d)
      expect(b.baby.rows[12]).toBe('....wwwwwwww....')
      // Sitting in it: the body ends on the row above the shell.
      const last = b.baby.rows.slice(0, 11).map((r) => r.replace(/\./g, '') !== '').lastIndexOf(true)
      expect(last).toBe(10)
    }
  })

  it('only uses the palette and the photo colours', () => {
    for (const d of Object.values(DESIGNS))
      for (const s of Object.values(customBodies(d)))
        for (const ch of s.rows.join('')) expect(PALETTE + CUSTOM_EXTRA).toContain(ch)
  })

  it('draws the same dots for the same design, every time', () => {
    const copy = JSON.parse(JSON.stringify(DESIGNS.cat)) as CustomDesign
    expect(customBodies(copy)).toEqual(customBodies(DESIGNS.cat))
  })
})

describe('a custom species through pixelsOf', () => {
  it('is drawn at every stage and form, inside the grid', () => {
    for (const id of ids)
      for (const stage of STAGES)
        for (const form of FORMS)
          for (const d of pixelsOf(stage, form, 'hungry', id)) {
            expect(d.x >= 0 && d.x < SPRITE_SIZE && d.y >= 0 && d.y < SPRITE_SIZE).toBe(true)
          }
  })

  it('goes through the same adult forms as every animal', () => {
    for (const id of ids) {
      const dots = (form: (typeof FORMS)[number]): number => pixelsOf('adult', form, 'ok', id).length
      expect(dots('titan'), id).toBeGreaterThan(dots('sturdy'))
      expect(dots('wraith'), id).toBeLessThan(dots('sturdy'))
      expect(dots('radiant'), id).toBeGreaterThan(dots('sturdy'))
    }
  })

  it('gets limbs as a teen', () => {
    for (const id of ids) {
      const limbs = pixelsOf('teen', 'base', 'ok', id).filter((d) => d.ch === 's')
      expect(limbs.length, id).toBeGreaterThan(0)
    }
  })

  it('wears its own colours, and its egg wears its markings', () => {
    const cat = pixelsOf('adult', 'sturdy', 'ok', 'u-testcat')
    expect(cat.some((d) => d.ch === 'n')).toBe(true)
    expect(cat.some((d) => d.ch === 'v')).toBe(true)
    for (const id of ids) {
      const egg = pixelsOf('egg', 'base', 'ok', id)
      expect(egg.some((d) => 'nkcvu'.includes(d.ch)), id).toBe(true)
      expect(egg.some((d) => d.ch === 'e')).toBe(false)
    }
  })

  it('shows its mood on its face, unless it keeps the photo look', () => {
    for (const id of ids) {
      const eyes = pixelsOf('child', 'base', 'happy', id).filter((d) => d.ch === 'e')
      if (id === 'u-testbare') expect(eyes).toEqual([])
      else expect(eyes.length, id).toBeGreaterThanOrEqual(8)
    }
    for (const id of ids.filter((i) => i !== 'u-testbare')) expect(bigFaceOf(bodyOf(id, 'adult')), id).not.toBeNull()
  })

  it('wears prizes off its face, with or without one', () => {
    for (const id of ids) {
      const body = bodyOf(id, 'adult')
      const face = bigFaceOf(body) ?? { ...body.face! }
      const w = bigFaceOf(body) ? 12 : 8
      const { back, front } = outfitPixels('adult', 'sturdy', id, ['crown', 'scarf', 'star'])
      expect(back.length + front.length, id).toBeGreaterThan(0)
      for (const d of [...back, ...front]) {
        const onFace = d.x >= face.x * 2 && d.x < face.x * 2 + w && d.y >= face.y * 2 && d.y < face.y * 2 + 8
        expect(onFace, id).toBe(false)
      }
    }
  })

  it('falls back to a drawable animal for a species nobody knows', () => {
    expect(bodyOf('u-nobodyknows', 'adult').rows).toHaveLength(GRID)
    expect(pixelsOf('adult', 'base', 'ok', 'u-nobodyknows').length).toBeGreaterThan(0)
  })
})
