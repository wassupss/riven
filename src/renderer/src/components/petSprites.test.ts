import { describe, it, expect } from 'vitest'
import {
  BIG_FACES,
  BODIES,
  DECOR_ART,
  FACES,
  GRID,
  PALETTE,
  SPRITE_SIZE,
  accessoryPixels,
  outfitPixels,
  bigFaceOf,
  bodyOf,
  pixelsOf,
  runsOf,
  type Dot
} from './petSprites'
import { PRIZES, SPECIES, outfitOf, slotOf, type Accessory, type Species } from '../state/pet'

const ORDER = ['head', 'neck', 'float', 'ground', 'aura']
const sorted = (worn: Accessory[]): Accessory[] =>
  [...worn].sort((a, b) => ORDER.indexOf(slotOf(a)) - ORDER.indexOf(slotOf(b)))

/** Inside the grid, never on the big face, and no dot placed twice. */
function expectClear(species: Species, dots: Dot[], what: string): void {
  const face = bigFaceOf(bodyOf(species))!
  const seen = new Set<string>()
  for (const d of dots) {
    expect(d.x >= 0 && d.x < SPRITE_SIZE && d.y >= 0 && d.y < SPRITE_SIZE, what).toBe(true)
    const onFace = d.x >= face.x * 2 && d.x < face.x * 2 + 12 && d.y >= face.y * 2 && d.y < face.y * 2 + 8
    expect(onFace, `${what} on its face`).toBe(false)
    expect(seen.has(`${d.x},${d.y}`), `${what} twice at ${d.x},${d.y}`).toBe(false)
    seen.add(`${d.x},${d.y}`)
  }
}

describe('sprite grids', () => {
  // A miscounted row silently shifts every dot after it, which is invisible in
  // review and obvious only on screen, so the grid shape is asserted here.
  it.each(Object.keys(BODIES))('%s is a 16x16 grid of palette dots', (name) => {
    const s = BODIES[name as keyof typeof BODIES]
    expect(s.rows).toHaveLength(GRID)
    for (const row of s.rows) {
      expect(row).toHaveLength(GRID)
      for (const ch of row) expect(PALETTE).toContain(ch)
    }
  })

  it('every mood face is 8 wide and 8 tall, drawn over a 4x4 window', () => {
    expect(Object.keys(FACES).sort()).toEqual(['happy', 'ok', 'sad'])
    for (const rows of Object.values(FACES)) {
      expect(rows).toHaveLength(8)
      for (const row of rows) expect(row).toHaveLength(8)
    }
  })

  it('keeps each face inside its body', () => {
    for (const s of Object.values(BODIES)) {
      expect(s.face).not.toBeNull()
      expect(s.face!.x + 4).toBeLessThanOrEqual(GRID)
      expect(s.face!.y + 4).toBeLessThanOrEqual(GRID)
    }
  })

  it('has one grown body for every animal, and no egg', () => {
    expect(Object.keys(BODIES).sort()).toEqual([...SPECIES].sort())
    for (const species of SPECIES) expect(bodyOf(species)).toBe(BODIES[species])
  })

  it('gives every animal its own silhouette, not a recolour of one body', () => {
    const shapeOf = (sp: (typeof SPECIES)[number]): string =>
      bodyOf(sp)
        .rows.map((r) => r.replace(/[bshwa]/g, '#'))
        .join('')
    expect(new Set(SPECIES.map(shapeOf)).size).toBe(SPECIES.length)
  })
})

describe('pixelsOf', () => {
  it('draws at twice the size it is authored at', () => {
    expect(SPRITE_SIZE).toBe(GRID * 2)
  })

  it('stamps the mood face onto the body', () => {
    const eyeRow = (mood: 'happy' | 'sad'): number => {
      const eyes = pixelsOf(mood, 'cat').filter((d) => d.ch === 'e')
      expect(eyes.length).toBeGreaterThanOrEqual(8) // two eyes, several dots each
      return Math.min(...eyes.map((d) => d.y))
    }
    expect(eyeRow('sad')).toBeGreaterThan(eyeRow('happy')) // sad eyes droop
  })

  it('outlines in a single dot, not a doubled one', () => {
    const dots = pixelsOf('ok', 'hamster')
    const lit = new Set(dots.map((d) => `${d.x},${d.y}`))
    const outline = dots.filter((d) => d.ch === 'o')
    const touchingAir = outline.filter((d) =>
      [[0, -1], [-1, 0], [1, 0], [0, 1]].some(([dx, dy]) => !lit.has(`${d.x + dx},${d.y + dy}`))
    )
    expect(touchingAir.length / outline.length).toBeGreaterThan(0.9)
  })

  it('shades the body: lit on top, shadowed underneath', () => {
    const dots = pixelsOf('ok', 'cat')
    const meanY = (ch: string): number => {
      const ys = dots.filter((d) => d.ch === ch).map((d) => d.y)
      expect(ys.length).toBeGreaterThan(0)
      return ys.reduce((a, b) => a + b, 0) / ys.length
    }
    expect(meanY('l')).toBeLessThan(meanY('d'))
  })

  it('marks every animal with its coat, never on its face', () => {
    for (const species of SPECIES) {
      const body = bodyOf(species)
      const face = bigFaceOf(body)!
      // The blush of the big face is 'h' too: look at the coat without a face.
      const marks = pixelsOf('sad', species).filter((d) => d.ch === 'h' || d.ch === 'a')
      expect(marks.length, species).toBeGreaterThan(0)
      for (const d of marks) {
        const onFace = d.x >= face.x * 2 && d.x < face.x * 2 + 12 && d.y >= face.y * 2 && d.y < face.y * 2 + 8
        expect(onFace, species).toBe(false)
      }
    }
  })

  it('gives every animal the big face', () => {
    for (const species of SPECIES) expect(bigFaceOf(bodyOf(species))).not.toBeNull()
  })

  it('keeps every big face 12 wide and 8 tall, drawn over a 6x4 window', () => {
    for (const rows of Object.values(BIG_FACES)) {
      expect(rows).toHaveLength(8)
      for (const row of rows) expect(row).toHaveLength(12)
    }
  })

  it('never lights a dot outside the grid', () => {
    for (const species of SPECIES)
      for (const mood of ['happy', 'ok', 'sad'] as const)
        for (const d of pixelsOf(mood, species)) {
          expect(d.x >= 0 && d.x < SPRITE_SIZE && d.y >= 0 && d.y < SPRITE_SIZE).toBe(true)
        }
  })
})

describe('keepsakes', () => {
  it('nothing worn and no decorations is nothing drawn', () => {
    expect(accessoryPixels('cat', null)).toEqual([])
    expect(outfitPixels('cat', [], 9)).toEqual({ back: [], front: [] })
  })

  it('a hat sits on the head, inside the grid and never over the eyes', () => {
    for (const species of SPECIES)
      for (const acc of ['sprout', 'bow', 'crown'] as const) {
        const worn = accessoryPixels(species, acc)
        expect(worn.length).toBeGreaterThan(0)
        const face = bigFaceOf(bodyOf(species))!
        for (const d of worn) {
          expect(d.x >= 0 && d.x < SPRITE_SIZE && d.y >= 0).toBe(true)
          expect(d.y).toBeLessThan(face.y * 2)
        }
      }
  })

  it('fits a full outfit, off its face and clear of each other', () => {
    const outfits: Accessory[][] = [
      ['scarf', 'sprout'],
      ['heart', 'scarf', 'crown'],
      ['sparkle', 'flowers', 'star', 'bell', 'bow'],
      ['glitter', 'mushrooms', 'moon', 'medal', 'crown'],
      ['legend', 'mushrooms', 'moon', 'medal', 'crown']
    ]
    for (const species of SPECIES)
      for (const outfit of outfits) {
        const worn = sorted(outfit)
        // Pieces are fitted in this order, so each one must add something.
        let before = 0
        worn.forEach((_, k) => {
          const o = outfitPixels(species, worn.slice(0, k + 1))
          const n = o.back.length + o.front.length
          expect(n, `${species}/${worn[k]}`).toBeGreaterThan(before)
          before = n
        })
        const { back, front } = outfitPixels(species, worn)
        expectClear(species, [...back, ...front], `${species} ${worn.join('+')}`)
      }
  })

  it('fits every prize, alone or over a full outfit', () => {
    for (const species of SPECIES)
      for (const { id } of PRIZES)
        for (const base of [[], ['legend', 'mushrooms', 'moon', 'medal', 'crown']] as Accessory[][]) {
          const worn = sorted(outfitOf([...base, id]))
          const alone = outfitPixels(species, [id])
          expect(alone.front.length + alone.back.length, `${species}/${id}`).toBeGreaterThan(0)
          const { back, front } = outfitPixels(species, worn)
          expectClear(species, [...back, ...front], `${species} ${id}`)
        }
  }, 30_000)
})

describe('decorations', () => {
  const count = (o: { back: Dot[]; front: Dot[] }): number => o.back.length + o.front.length

  it('appear every ten levels, each adding to the last', () => {
    for (const species of SPECIES) {
      let before = 0
      for (const level of [10, 20, 30, 40, 50]) {
        const n = count(outfitPixels(species, [], level))
        expect(n, `${species} Lv${level}`).toBeGreaterThan(before)
        before = n
      }
      // Between the tens nothing changes.
      expect(outfitPixels(species, [], 47)).toEqual(outfitPixels(species, [], 40))
      expect(outfitPixels(species, [], 99)).toEqual(outfitPixels(species, [], 50))
    }
  })

  it('are drawn off its face, clear of each other and of what it wears', () => {
    for (const species of SPECIES)
      for (const worn of [[], ['legend', 'mushrooms', 'moon', 'medal', 'crown'], ['scarf']] as Accessory[][]) {
        const { back, front } = outfitPixels(species, sorted(worn), 50)
        expectClear(species, [...back, ...front], `${species} Lv50 ${worn.join('+')}`)
      }
  })

  it('never cover the pet itself', () => {
    for (const species of SPECIES) {
      const pet = new Set(pixelsOf('ok', species).map((d) => `${d.x},${d.y}`))
      const { back } = outfitPixels(species, [], 50)
      for (const d of back) expect(pet.has(`${d.x},${d.y}`), species).toBe(false)
    }
  })

  it('show what each tier is: a badge, a ribbon, sparkles, a halo, a glow', () => {
    const at = (level: number): { back: Dot[]; front: Dot[] } => outfitPixels('cat', [], level)
    // The glow is its own colour, a ring round the silhouette, from 50 on.
    expect(at(40).back.some((d) => d.ch === 'g')).toBe(false)
    const glow = at(50).back.filter((d) => d.ch === 'g')
    expect(glow.length).toBeGreaterThan(40)
    // Sparkles twinkle on the back layer (accent dots), from 30 on.
    expect(at(20).back.filter((d) => d.ch === 'a')).toHaveLength(0)
    expect(at(30).back.filter((d) => d.ch === 'a').length).toBeGreaterThan(0)
    // The halo floats over its head.
    const face = bigFaceOf(bodyOf('cat'))!
    const halo = at(40).front.filter((d) => !at(30).front.some((e) => e.x === d.x && e.y === d.y))
    expect(halo.length).toBe(DECOR_ART.halo.join('').replace(/\./g, '').length)
    for (const d of halo) expect(d.y).toBeLessThan(face.y * 2)
  })

  it('cost a handful of runs, not a picture', () => {
    for (const species of SPECIES) {
      const { back, front } = outfitPixels(species, [], 50)
      expect(runsOf(back).length + runsOf(front).length, species).toBeLessThan(200)
    }
  })
})

describe('runsOf', () => {
  it('merges a row of one colour into one run, and keeps every dot', () => {
    const dots = pixelsOf('happy', 'dragon')
    const runs = runsOf(dots)
    expect(runs.length).toBeLessThan(dots.length / 2)
    const back = runs.flatMap((r) => Array.from({ length: r.w }, (_, i) => `${r.x + i},${r.y},${r.ch}`))
    expect(new Set(back)).toEqual(new Set(dots.map((d) => `${d.x},${d.y},${d.ch}`)))
  })
})
