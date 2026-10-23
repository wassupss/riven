import { describe, it, expect } from 'vitest'
import {
  BIG_FACES,
  BODIES,
  FACES,
  GRID,
  PALETTE,
  SPRITES,
  SPRITE_SIZE,
  accessoryPixels,
  bigFaceOf,
  bodyOf,
  pixelsOf,
  runsOf
} from './petSprites'
import { SPECIES, STAGES, type Form } from '../state/pet'

const FORMS: Form[] = ['base', 'radiant', 'sturdy', 'titan', 'wraith']

describe('sprite grids', () => {
  // A miscounted row silently shifts every dot after it, which is invisible in
  // review and obvious only on screen — so the grid shape is asserted here.
  it.each(Object.keys(SPRITES))('%s is a %d×%d grid of palette dots', (name) => {
    const s = SPRITES[name]
    expect(s.rows).toHaveLength(GRID)
    for (const row of s.rows) {
      expect(row).toHaveLength(GRID)
      for (const ch of row) expect(PALETTE).toContain(ch)
    }
  })

  it('every mood face is 8 wide and 8 tall, drawn over a 4×4 window', () => {
    for (const rows of Object.values(FACES)) {
      expect(rows).toHaveLength(8)
      for (const row of rows) expect(row).toHaveLength(8)
    }
  })

  it('keeps each face inside its body', () => {
    for (const s of Object.values(SPRITES)) {
      if (!s.face) continue
      expect(s.face.x + 4).toBeLessThanOrEqual(GRID)
      expect(s.face.y + 4).toBeLessThanOrEqual(GRID)
    }
  })

  it('has a body for every animal at every stage', () => {
    for (const species of SPECIES)
      for (const stage of STAGES) {
        const body = bodyOf(species, stage)
        expect(body.rows).toHaveLength(GRID)
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
  it('draws at twice the size it is authored at', () => {
    expect(SPRITE_SIZE).toBe(GRID * 2)
  })

  it('stamps the mood face onto the body', () => {
    const eyeRow = (mood: 'happy' | 'sad'): number => {
      const eyes = pixelsOf('child', 'base', mood).filter((d) => d.ch === 'e')
      expect(eyes.length).toBeGreaterThanOrEqual(8) // two eyes, several dots each
      return Math.min(...eyes.map((d) => d.y))
    }
    expect(eyeRow('sad')).toBeGreaterThan(eyeRow('happy')) // sad eyes droop
  })

  it('leaves the body showing through the gaps in a face', () => {
    const dots = pixelsOf('child', 'base', 'ok', 'cat')
    const face = bodyOf('cat', 'child').face!
    // The dot between the eyes is body (lit or shaded), not a hole.
    const between = dots.find((d) => d.x === face.x * 2 + 3 && d.y === face.y * 2 + 1)
    expect('bld').toContain(between?.ch)
  })

  it('outlines in a single dot, not a doubled one', () => {
    // Doubling the authored grid doubled the outline too, as heavy as an eye.
    // Every outline dot of a body must touch the air, or be a line drawn
    // inside it on purpose; here, a plain body without any.
    const dots = pixelsOf('child', 'base', 'ok', 'hamster')
    const lit = new Set(dots.map((d) => `${d.x},${d.y}`))
    const outline = dots.filter((d) => d.ch === 'o')
    const touchingAir = outline.filter((d) =>
      [[0, -1], [-1, 0], [1, 0], [0, 1]].some(([dx, dy]) => !lit.has(`${d.x + dx},${d.y + dy}`))
    )
    expect(touchingAir.length / outline.length).toBeGreaterThan(0.9)
  })

  it('shades the body: lit on top, shadowed underneath', () => {
    const dots = pixelsOf('adult', 'sturdy', 'ok', 'cat')
    const meanY = (ch: string): number => {
      const ys = dots.filter((d) => d.ch === ch).map((d) => d.y)
      expect(ys.length).toBeGreaterThan(0)
      return ys.reduce((a, b) => a + b, 0) / ys.length
    }
    expect(meanY('l')).toBeLessThan(meanY('d'))
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

  it('marks every strain, at every size, egg included', () => {
    // Including the hatchling, which is the hard one: its body is barely wider
    // than its own face, so a pattern has almost nowhere to land.
    for (const species of SPECIES) {
      for (const stage of STAGES) {
        const marks = pixelsOf(stage, 'base', 'ok', species).filter(
          (d) => d.ch === 'h' || d.ch === 'a'
        )
        expect(marks.length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps a coat off the face, at every size', () => {
    // The window the face is stamped into (4×4, or 6×4 for the big face from
    // the teens on) is off limits everywhere. (A dot of clearance around it is
    // kept too, but only on bodies wide enough to spare it, see pixelsOf.)
    for (const species of SPECIES)
      for (const stage of STAGES) {
        const body = bodyOf(species, stage)
        if (!body.face) continue
        const big = stage === 'teen' || stage === 'adult' ? bigFaceOf(body) : null
        const face = big ?? body.face
        const w = (big ? 6 : 4) * 2
        // Asleep, because the awake big face has its own blush ('h'), which
        // is part of the face, not a coat on it.
        const marks = pixelsOf(stage, 'base', 'asleep', species).filter(
          (d) => d.ch === 'h' || d.ch === 'a'
        )
        for (const d of marks) {
          const onFace =
            d.x >= face.x * 2 &&
            d.x < face.x * 2 + w &&
            d.y >= face.y * 2 &&
            d.y < face.y * 2 + 8
          expect(onFace).toBe(false)
        }
      }
  })

  it('gives every grown-up the big face', () => {
    // The complaint: adults looked worse than the babies. The big eyes are
    // most of what fixes that, so no animal may silently fall back to dots.
    for (const species of SPECIES) expect(bigFaceOf(bodyOf(species, 'adult'))).not.toBeNull()
  })

  it('keeps every big face 12 wide and 8 tall, drawn over a 6×4 window', () => {
    for (const rows of Object.values(BIG_FACES)) {
      expect(rows).toHaveLength(8)
      for (const row of rows) expect(row).toHaveLength(12)
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

describe('accessoryPixels', () => {
  it('only a grown-up wears anything', () => {
    expect(accessoryPixels('teen', 'base', 'cat', 'crown')).toEqual([])
    expect(accessoryPixels('adult', 'sturdy', 'cat', null)).toEqual([])
  })

  it('sits on the head, inside the grid and never over the eyes', () => {
    for (const species of SPECIES)
      for (const form of FORMS)
        for (const acc of ['sprout', 'bow', 'crown'] as const) {
          const worn = accessoryPixels('adult', form, species, acc)
          expect(worn.length).toBeGreaterThan(0)
          const face = bigFaceOf(bodyOf(species, 'adult'))!
          for (const d of worn) {
            expect(d.x).toBeGreaterThanOrEqual(0)
            expect(d.x).toBeLessThan(SPRITE_SIZE)
            expect(d.y).toBeGreaterThanOrEqual(0)
            expect(d.y).toBeLessThan(face.y * 2)
          }
        }
  })
})

describe('runsOf', () => {
  it('merges a row of one colour into one run, and keeps every dot', () => {
    const dots = pixelsOf('adult', 'radiant', 'happy', 'dragon')
    const runs = runsOf(dots)
    expect(runs.length).toBeLessThan(dots.length / 2)
    const back = runs.flatMap((r) =>
      Array.from({ length: r.w }, (_, i) => `${r.x + i},${r.y},${r.ch}`)
    )
    expect(new Set(back)).toEqual(new Set(dots.map((d) => `${d.x},${d.y},${d.ch}`)))
  })
})
