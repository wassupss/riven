import { describe, expect, it } from 'vitest'
import { bboxOf, fromRel, layoutKey, sanitizeLayout, setOverride, toRel, toggleWornList } from './petLayout'
import { applyCommand, briefOf, initialState, normalize, normalizeNest, prizesOf, slotOf, withDecor, PET_VERSION, type PetSave } from './pet'
import { levelOf } from './petLevel'
import { outfitPieces, outfitPixels, SPRITE_SIZE, type Dot } from '../components/petSprites'

const T0 = 1_700_000_000_000
const xpFor = (level: number): number => {
  let xp = 0
  while (levelOf(xp).level < level) xp += 10
  return xp
}
const key = (d: { x: number; y: number }): string => `${d.x},${d.y}`
const overlap = (a: Dot[], b: Dot[]): number => {
  const s = new Set(a.map(key))
  return b.filter((d) => s.has(key(d))).length
}

describe('relative positions', () => {
  const box = { x: 4, y: 2, w: 24, h: 28 }
  it('go to the centre as a fraction of the box and back to the same corner', () => {
    const rel = toRel({ x: 10, y: 5 }, { w: 5, h: 4 }, box)
    expect(rel).toEqual({ x: 0.354, y: 0.179 })
    expect(fromRel(rel, { w: 5, h: 4 }, box)).toEqual({ x: 10, y: 5 })
  })
  it('round trip every corner of the grid', () => {
    for (let x = 0; x <= SPRITE_SIZE - 7; x += 3)
      for (let y = 0; y <= SPRITE_SIZE - 3; y += 5) expect(fromRel(toRel({ x, y }, { w: 7, h: 3 }, box), { w: 7, h: 3 }, box)).toEqual({ x, y })
  })
  it('keep the same spot on the pet when its box is drawn bigger (32, 48, 64 or another scale)', () => {
    // The same pet, twice the size: a piece at its top-right lands at its top-right again.
    const small = { x: 8, y: 8, w: 16, h: 16 }
    const big = { x: 0, y: 0, w: 32, h: 32 }
    const rel = toRel({ x: 20, y: 6 }, { w: 3, h: 3 }, small)
    const at = fromRel(rel, { w: 3, h: 3 }, big)
    // Within half a dot of the exact spot (the corner is a whole dot).
    expect(Math.abs(at.x + 1.5 - ((20 + 1.5 - 8) / 16) * 32)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(at.y + 1.5 - Math.max(1.5, ((6 + 1.5 - 8) / 16) * 32))).toBeLessThanOrEqual(0.5)
  })
  it('stay on the grid however far out a saved spot is', () => {
    expect(fromRel({ x: 3, y: -2 }, { w: 5, h: 5 }, { x: 0, y: 0, w: 32, h: 32 })).toEqual({ x: 27, y: 0 })
  })
  it('measure a box round dots, and a dot in the middle round none', () => {
    expect(bboxOf([{ x: 3, y: 4 }, { x: 9, y: 1 }])).toEqual({ x: 3, y: 1, w: 7, h: 4 })
    expect(bboxOf([])).toEqual({ x: 16, y: 16, w: 1, h: 1 })
  })
})

describe('a saved layout', () => {
  it('is read defensively: known key shapes, finite numbers, clamped, nothing empty', () => {
    expect(sanitizeLayout(null)).toBeUndefined()
    expect(sanitizeLayout([1])).toBeUndefined()
    expect(sanitizeLayout({})).toBeUndefined()
    expect(
      sanitizeLayout({
        'acc:crown': { x: 0.5, y: -0.1234567, z: 'back' },
        'decor:sparkle:2': { hidden: true },
        'acc:star': { x: 'a', y: 1 },
        'acc:moon': { x: 99, y: -99 },
        'evil<script>': { x: 1, y: 1 },
        'decor:halo': { hidden: 'yes', z: 'up' }
      })
    ).toEqual({
      'acc:crown': { x: 0.5, y: -0.123, z: 'back' },
      'decor:sparkle:2': { hidden: true },
      'acc:moon': { x: 3, y: -2 }
    })
  })
  it('changes one piece at a time and forgets a piece with nothing left', () => {
    let l = setOverride(undefined, 'decor:badge', { x: 0.2, y: 0.9 })
    expect(l).toEqual({ 'decor:badge': { x: 0.2, y: 0.9 } })
    l = setOverride(l, 'decor:badge', { z: 'back' })
    expect(l).toEqual({ 'decor:badge': { x: 0.2, y: 0.9, z: 'back' } })
    l = setOverride(l, 'decor:badge', { x: undefined, y: undefined, z: undefined })
    expect(l).toBeUndefined()
    expect(setOverride({ 'acc:crown': { hidden: true } }, 'acc:crown', null)).toBeUndefined()
  })
  it('compares as a stable string', () => {
    expect(layoutKey({ b: { x: 1, y: 2 }, a: { hidden: true } })).toBe(layoutKey({ a: { hidden: true }, b: { x: 1, y: 2 } }))
    expect(layoutKey(undefined)).toBe('')
  })
  it('wears one keepsake per slot, and only won ones', () => {
    expect(toggleWornList(['crown'], ['crown', 'bow'], 'bow', slotOf)).toEqual(['bow'])
    expect(toggleWornList(['crown'], ['crown'], 'crown', slotOf)).toEqual([])
    expect(toggleWornList([], [], 'crown', slotOf)).toEqual([])
    expect(toggleWornList(['scarf'], ['crown'], 'crown', slotOf)).toEqual(['scarf', 'crown'])
  })
})

describe('placing with a layout', () => {
  const worn = ['sprout', 'heart', 'mushrooms', 'sparkle'] as const
  const all = (o: { back: Dot[]; front: Dot[] }): Dot[] => [...o.back, ...o.front]

  it('is the automatic placement, piece for piece, with no layout', () => {
    for (const species of ['cat', 'fish', 'slime', 'dragon'] as const) {
      const { pieces } = outfitPieces(species, [...worn], 50)
      const o = outfitPixels(species, [...worn], 50)
      expect(pieces.filter((p) => p.layer === 'back').flatMap((p) => p.dots)).toEqual(o.back)
      expect(pieces.filter((p) => p.layer === 'front').flatMap((p) => p.dots)).toEqual(o.front)
      expect(pieces.every((p) => !p.moved && !p.hidden)).toBe(true)
    }
  })
  it('names every piece by a stable key', () => {
    const keys = outfitPieces('cat', [...worn], 50).pieces.map((p) => p.key)
    expect(keys).toEqual([
      'acc:sprout',
      'acc:heart',
      'acc:mushrooms:0',
      'acc:mushrooms:1',
      'acc:sparkle:0',
      'acc:sparkle:1',
      'decor:halo',
      'decor:ribbon',
      'decor:badge',
      'decor:sparkle:0',
      'decor:sparkle:1',
      'decor:sparkle:2',
      'decor:glow'
    ])
    for (const k of keys) expect(sanitizeLayout({ [k]: { hidden: true } })).toEqual({ [k]: { hidden: true } })
  })
  it('puts a moved piece where it was put, full size', () => {
    const { pieces, bbox } = outfitPieces('cat', ['heart'], 0)
    const heart = pieces[0]
    const rel = toRel({ x: 1, y: 20 }, heart.size, bbox)
    const moved = outfitPieces('cat', ['heart'], 0, { 'acc:heart': rel }).pieces[0]
    expect(moved.moved).toBe(true)
    expect(moved.box).toEqual({ x: 1, y: 20, w: heart.size.w, h: heart.size.h })
  })
  it('hides a hidden piece and draws the rest as before', () => {
    const before = outfitPieces('cat', [...worn], 50)
    const after = outfitPieces('cat', [...worn], 50, { 'decor:halo': { hidden: true } })
    const halo = after.pieces.find((p) => p.key === 'decor:halo')!
    expect(halo.hidden).toBe(true)
    expect(halo.dots).toEqual([])
    expect(after.pieces.find((p) => p.key === 'acc:sprout')!.dots).toEqual(before.pieces.find((p) => p.key === 'acc:sprout')!.dots)
    expect(outfitPieces('cat', [], 50, { 'decor:glow': { hidden: true } }).pieces.find((p) => p.key === 'decor:glow')!.dots).toEqual([])
  })
  it('moves a piece in front of the pet or behind it', () => {
    const o = outfitPixels('cat', ['heart'], 0, { 'acc:heart': { z: 'back' } })
    expect(o.front).toEqual([])
    expect(o.back.length).toBeGreaterThan(0)
  })
  it('fits the automatic pieces round a moved one, an earned-later one too', () => {
    // At level 10 the badge is moved to where the floating friend goes.
    const ten = outfitPieces('cat', [], 10)
    const friendSpot = outfitPieces('cat', ['heart'], 0).pieces[0].box!
    const badge = ten.pieces.find((p) => p.key === 'decor:badge')!
    const layout = { 'decor:badge': toRel({ x: friendSpot.x, y: friendSpot.y }, badge.size, ten.bbox) }
    // Later: a heart to wear, and level 50 brings the halo, ribbon, sparkles and glow.
    const later = outfitPieces('cat', ['heart', 'sparkle'], 50, layout)
    const moved = later.pieces.find((p) => p.key === 'decor:badge')!
    expect(moved.moved).toBe(true)
    for (const p of later.pieces) {
      if (p.key === 'decor:badge') continue
      expect(overlap(moved.dots, p.dots), p.key).toBe(0)
    }
    // The heart found somewhere else.
    expect(later.pieces.find((p) => p.key === 'acc:heart')!.box).not.toEqual(friendSpot)
  })
  it('is cheap enough to place on every change', () => {
    const t0 = performance.now()
    for (let i = 0; i < 50; i++) all(outfitPixels('dragon', [...worn], 50, { 'decor:badge': { x: 0.1 + i / 100, y: 0.9 } }))
    expect((performance.now() - t0) / 50).toBeLessThan(20)
  })
})

describe('saving it', () => {
  const at = (level: number): PetSave => ({ ...initialState(T0), xp: xpFor(level) })

  it('loads a version 2 pet unchanged, with the automatic placement', () => {
    const v2 = JSON.parse(JSON.stringify({ ...at(30), version: 2, worn: ['heart'] })) as Record<string, unknown>
    delete v2.layout
    const p = normalize(v2, T0 + 1)
    expect(p.version).toBe(PET_VERSION)
    expect(PET_VERSION).toBe(3)
    expect('layout' in p).toBe(false)
    expect(p.worn).toEqual(['heart'])
    expect(p.xp).toBe(xpFor(30))
  })
  it('keeps a version 3 layout through a save and load, read defensively', () => {
    const p = { ...at(30), layout: { 'acc:heart': { x: 0.25, y: 0.1 }, 'decor:badge': { hidden: true }, bogus: { x: 1, y: 1 } } }
    const back = normalize(JSON.parse(JSON.stringify(p)), T0 + 1)
    expect(back.layout).toEqual({ 'acc:heart': { x: 0.25, y: 0.1 }, 'decor:badge': { hidden: true } })
    expect('layout' in normalize({ ...p, layout: { bogus: 1 } }, T0 + 1)).toBe(false)
  })
  it('a whole nest written before layouts loads the same', () => {
    const n = normalizeNest({ version: 3, active: 0, pets: [{ ...at(12), version: 2 }] }, T0 + 1)
    expect(n.pets[0].layout).toBeUndefined()
    expect(n.pets[0].version).toBe(3)
  })
  it('changes what it wears and its layout in one command, for that pet only', () => {
    const p = { ...at(30), bornAt: 5 }
    const n = { version: 3 as const, active: 0, pets: [p] }
    const r = applyCommand(n, { op: 'decor', index: 0, bornAt: 5, worn: ['heart'], layout: { 'acc:heart': { x: 0.1, y: 0.2 } } }, T0)
    expect(r.result).toBe('ok')
    expect(r.nest.pets[0].worn).toEqual(['heart'])
    expect(r.nest.pets[0].layout).toEqual({ 'acc:heart': { x: 0.1, y: 0.2 } })
    // Back to automatic.
    const r2 = applyCommand(r.nest, { op: 'decor', index: 0, bornAt: 5, worn: ['heart'], layout: null }, T0)
    expect('layout' in r2.nest.pets[0]).toBe(false)
    // About a pet that is not there any more: refused.
    expect(applyCommand(n, { op: 'decor', index: 0, bornAt: 6, worn: [], layout: null }, T0).result).toBe('stale')
  })
  it('never puts on a prize it has not won, nor two in one slot', () => {
    const p = at(5)
    expect(prizesOf(p)).toContain('sprout')
    expect(withDecor(p, ['crown'], null).worn).toEqual([])
    expect(withDecor(p, ['sprout', 'crown'], null).worn).toEqual(['sprout'])
    expect(withDecor(p, [], undefined)).toBe(p)
  })
  it('tells Settings what it wears, has won and how it is laid out', () => {
    const p = { ...at(20), worn: ['heart' as const], layout: { 'acc:heart': { x: 0.5, y: 0 } } }
    const b = briefOf({ active: 0, pets: [p] }).pets[0]
    expect(b.worn).toEqual(['heart'])
    expect(b.prizes).toEqual(prizesOf(p))
    expect(b.layout).toEqual(p.layout)
  })
})
