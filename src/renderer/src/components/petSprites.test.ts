import { describe, it, expect } from 'vitest'
import { BODIES, FACES, PALETTE, SPRITES, SPRITE_SIZE, bodyOf, pixelsOf } from './petSprites'
import { SPECIES, STAGES, type Form } from '../state/pet'

const FORMS: Form[] = ['base', 'radiant', 'sturdy', 'titan', 'wraith']

describe('sprite grids', () => {
  // A miscounted row silently shifts every dot after it, which is invisible in
  // review and obvious only on screen — so the grid shape is asserted here.
  it.each(Object.keys(SPRITES))('%s is a %d×%d grid of palette dots', (name) => {
    const s = SPRITES[name]
    expect(s.rows).toHaveLength(SPRITE_SIZE)
    for (const row of s.rows) {
      expect(row).toHaveLength(SPRITE_SIZE)
      for (const ch of row) expect(PALETTE).toContain(ch)
    }
  })

  it('every mood face is 4 wide and 4 tall', () => {
    for (const rows of Object.values(FACES)) {
      expect(rows).toHaveLength(4)
      for (const row of rows) expect(row).toHaveLength(4)
    }
  })

  it('keeps each face inside its body', () => {
    for (const s of Object.values(SPRITES)) {
      if (!s.face) continue
      expect(s.face.x + 4).toBeLessThanOrEqual(SPRITE_SIZE)
      expect(s.face.y + 4).toBeLessThanOrEqual(SPRITE_SIZE)
    }
  })

  it('has a body for every animal at every stage', () => {
    for (const species of SPECIES)
      for (const stage of STAGES) {
        const body = bodyOf(species, stage)
        expect(body.rows).toHaveLength(SPRITE_SIZE)
        // Every stage but the egg shows a face, and the egg never does.
        expect(!!body.face).toBe(stage !== 'egg')
      }
  })

  it('gives every animal its own silhouette, not a recolour of one body', () => {
    // The complaint this answers: six strains that were the same blob in six
    // colours. Compare the shapes with the pattern and the face stripped out.
    const shapeOf = (sp: (typeof SPECIES)[number], stage: 'child' | 'adult'): string =>
      bodyOf(sp, stage)
        .rows.map((r) => r.replace(/[bshwa]/g, '#'))
        .join('')
    for (const stage of ['child', 'adult'] as const) {
      const shapes = SPECIES.map((sp) => shapeOf(sp, stage))
      expect(new Set(shapes).size).toBe(SPECIES.length)
    }
  })

  it('draws each animal at three sizes, and grows through them', () => {
    for (const species of SPECIES) {
      const b = BODIES[species]
      const dots = (rows: string[]): number => rows.join('').replace(/\./g, '').length
      expect(dots(b.baby.rows)).toBeLessThan(dots(b.grown.rows))
      expect(dots(b.young.rows)).toBeLessThanOrEqual(dots(b.grown.rows))
    }
  })
})

describe('pixelsOf', () => {
  it('stamps the mood face onto the body', () => {
    const eyeRow = (mood: 'happy' | 'sad'): number => {
      const eyes = pixelsOf('child', 'base', mood).filter((d) => d.ch === 'e')
      expect(eyes).toHaveLength(2) // one dot per eye
      return eyes[0].y
    }
    expect(eyeRow('sad')).toBe(eyeRow('happy') + 1) // sad eyes droop a row
  })

  it('leaves the body showing through the gaps in a face', () => {
    const dots = pixelsOf('child', 'base', 'ok', 'cat')
    const face = bodyOf('cat', 'child').face!
    // The dot between the eyes is body, not a hole.
    const between = dots.find((d) => d.x === face.x + 1 && d.y === face.y)
    expect(between?.ch).toBe('b')
  })

  it('gives an egg no face at all', () => {
    const dots = pixelsOf('egg', 'base', 'happy')
    expect(dots.some((d) => d.ch === 'e' || d.ch === 'm')).toBe(false)
  })

  it('changes the grown-up it became, whichever animal it is', () => {
    // A form is a change made to the animal's own body, so it has to hold for
    // every one of them — not just for the single body forms used to be.
    for (const species of SPECIES) {
      const dots = (form: Form): number => pixelsOf('adult', form, 'ok', species).length
      expect(dots('titan')).toBeGreaterThan(dots('sturdy'))
      expect(dots('wraith')).toBeLessThan(dots('sturdy'))
      // Radiant adds its halo without eating into the body.
      expect(dots('radiant')).toBeGreaterThan(dots('sturdy'))
    }
  })

  it('marks every strain, on the egg as well as the animal', () => {
    for (const species of SPECIES) {
      for (const stage of ['egg', 'child', 'adult'] as const) {
        const marks = pixelsOf(stage, 'base', 'ok', species).filter(
          (d) => d.ch === 'h' || d.ch === 'a'
        )
        expect(marks.length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps a coat off the face', () => {
    for (const species of SPECIES) {
      const face = bodyOf(species, 'child').face!
      const marks = pixelsOf('child', 'base', 'ok', species).filter(
        (d) => d.ch === 'h' || d.ch === 'a'
      )
      for (const d of marks) {
        const onFace =
          d.x >= face.x - 1 && d.x <= face.x + 4 && d.y >= face.y - 1 && d.y <= face.y + 4
        expect(onFace).toBe(false)
      }
    }
  })

  it('never lights a dot outside the grid', () => {
    for (const species of SPECIES)
      for (const stage of STAGES)
        for (const form of FORMS)
          for (const d of pixelsOf(stage, form, 'hungry', species)) {
            expect(d.x).toBeGreaterThanOrEqual(0)
            expect(d.x).toBeLessThan(SPRITE_SIZE)
            expect(d.y).toBeGreaterThanOrEqual(0)
            expect(d.y).toBeLessThan(SPRITE_SIZE)
          }
  })

  it('never lights a dot outside the grid, for any stage', () => {
    for (const stage of STAGES)
      for (const d of pixelsOf(stage, 'base', 'hungry')) {
        expect(d.x).toBeGreaterThanOrEqual(0)
        expect(d.x).toBeLessThan(SPRITE_SIZE)
        expect(d.y).toBeGreaterThanOrEqual(0)
        expect(d.y).toBeLessThan(SPRITE_SIZE)
      }
  })
})
