import { describe, it, expect } from 'vitest'
import { FACES, PALETTE, SPRITES, SPRITE_SIZE, pixelsOf, spriteKey } from './petSprites'
import { STAGES, type Form } from '../state/pet'

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

  it('has a body for every stage and grown-up form', () => {
    for (const stage of STAGES)
      for (const form of FORMS) {
        if (form !== 'base' && stage !== 'adult') continue
        expect(SPRITES[spriteKey(stage, form)]).toBeDefined()
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
    const dots = pixelsOf('child', 'base', 'ok')
    // The dot between the eyes is body, not a hole.
    const between = dots.find((d) => d.x === 7 && d.y === 8)
    expect(between?.ch).toBe('b')
  })

  it('gives an egg no face at all', () => {
    const dots = pixelsOf('egg', 'base', 'happy')
    expect(dots.some((d) => d.ch === 'e' || d.ch === 'm')).toBe(false)
  })

  it('changes body with the grown-up form', () => {
    const sturdy = pixelsOf('adult', 'sturdy', 'ok').length
    const titan = pixelsOf('adult', 'titan', 'ok').length
    const wraith = pixelsOf('adult', 'wraith', 'ok').length
    expect(titan).toBeGreaterThan(sturdy)
    expect(wraith).toBeLessThan(sturdy)
  })

  it('never lights a dot outside the grid', () => {
    for (const stage of STAGES)
      for (const d of pixelsOf(stage, 'base', 'hungry')) {
        expect(d.x).toBeGreaterThanOrEqual(0)
        expect(d.x).toBeLessThan(SPRITE_SIZE)
        expect(d.y).toBeGreaterThanOrEqual(0)
        expect(d.y).toBeLessThan(SPRITE_SIZE)
      }
  })
})
