import { describe, it, expect } from 'vitest'
import {
  ACCESSORIES,
  PRIZES,
  STAGE_XP,
  accessoriesOf,
  claimEvents,
  eventsOn,
  initialState,
  normalize,
  outfitOf,
  prizesOf,
  recordBattle,
  toggleWear,
  type PetSave
} from './pet'
import { cardOf, decodeCard, encodeCard, fight, isUpset, type BattleCard } from './petBattle'

const day = (m: number, d: number): number => new Date(2026, m - 1, d, 12).getTime()
const hatched = (now: number, over: Partial<PetSave> = {}): PetSave => ({
  ...initialState(now),
  xp: STAGE_XP[1],
  ...over
})
const slotOf = (id: string): string | undefined =>
  [...ACCESSORIES, ...PRIZES].find((p) => p.id === id)?.slot

describe('festivals', () => {
  it('knows its windows, Halloween across the month end included', () => {
    expect(eventsOn(day(10, 16))).toEqual([])
    expect(eventsOn(day(10, 17))).toEqual(['halloween'])
    expect(eventsOn(day(10, 31))).toEqual(['halloween'])
    expect(eventsOn(day(11, 1))).toEqual(['halloween'])
    expect(eventsOn(day(11, 2))).toEqual(['halloween'])
    expect(eventsOn(day(11, 3))).toEqual([])
    expect(eventsOn(day(12, 25))).toEqual(['christmas'])
    expect(eventsOn(day(4, 1))).toEqual(['spring'])
    expect(eventsOn(day(7, 1))).toEqual([])
  })

  it('an egg cannot join; a hatched pet joins once', () => {
    const now = day(10, 23)
    const egg = initialState(now)
    expect(claimEvents(egg, now)).toBe(egg)
    const s1 = claimEvents(hatched(now), now)
    expect(s1.events).toEqual(['halloween'])
    expect(claimEvents(s1, now + 86_400_000)).toBe(s1)
    expect(claimEvents(hatched(day(7, 1)), day(7, 1)).events).toEqual([])
  })
})

describe('prizes', () => {
  it('locked prizes cannot be worn; earned ones toggle', () => {
    const now = day(10, 23)
    const s0 = hatched(now)
    expect(prizesOf(s0, now)).not.toContain('pumpkin')
    expect(toggleWear(s0, 'pumpkin', now)).toBe(s0)
    const s1 = claimEvents(s0, now)
    expect(prizesOf(s1, now)).toContain('pumpkin')
    const on = toggleWear(s1, 'pumpkin', now)
    expect(on.worn).toEqual(['pumpkin'])
    expect(toggleWear(on, 'pumpkin', now).worn).toEqual([])
  })

  it('one prize per slot: a new hat replaces the old one', () => {
    const now = day(10, 23)
    const s = claimEvents(hatched(now, { battles: 1, battleWins: 1 }), now)
    const a = toggleWear(s, 'bandana', now)
    expect(a.worn).toEqual(['bandana'])
    const b = toggleWear(a, 'pumpkin', now)
    expect(b.worn).toEqual(['pumpkin'])
  })

  it('a worn prize takes its slot over the level keepsake', () => {
    const level = 60
    const base = accessoriesOf(level)
    const out = outfitOf(['pumpkin'], level)
    expect(out).toContain('pumpkin')
    expect(out.filter((a) => slotOf(a) === 'head')).toEqual(['pumpkin'])
    expect(out.length).toBe(base.length + (base.some((a) => slotOf(a) === 'head') ? 0 : 1))
    expect(outfitOf([], level)).toEqual(base)
  })

  it('old and junk saves come out clean', () => {
    const now = Date.now()
    const old = normalize({ bornAt: now }, now)
    expect(old.upsets).toBe(0)
    expect(old.events).toEqual([])
    expect(old.worn).toEqual([])
    const junk = normalize(
      { bornAt: now, upsets: -3, events: ['halloween', 'halloween', 'nope', 7], worn: ['pumpkin', 'santa', 'crown', 'x'] },
      now
    )
    expect(junk.upsets).toBe(0)
    expect(junk.events).toEqual(['halloween'])
    expect(junk.worn).toEqual(['pumpkin'])
  })
})

describe('upsets', () => {
  const card = (over: Partial<BattleCard> = {}): BattleCard => ({
    name: 'A',
    species: 'cat',
    stage: 'adult',
    form: 'base',
    level: 10,
    fullness: 80,
    mood: 60,
    sick: false,
    bornAt: 1,
    ...over
  })

  it('a bigger stage or ten levels up is an upset', () => {
    expect(isUpset(card(), card({ level: 20 }))).toBe(true)
    expect(isUpset(card(), card({ level: 19 }))).toBe(false)
    expect(isUpset(card({ stage: 'teen', level: 0 }), card())).toBe(true)
    expect(isUpset(card({ level: 30 }), card())).toBe(false)
  })

  it('counts only on a win', () => {
    const now = day(10, 23)
    const s = initialState(now)
    expect(recordBattle(s, 5, 'win', now, true).upsets).toBe(1)
    expect(recordBattle(s, 5, 'loss', now, true).upsets).toBe(0)
    expect(recordBattle(s, 5, 'win', now).upsets).toBe(0)
  })

  it('what it wears travels in the code, but never changes the fight', () => {
    const plain = card({ name: 'P', bornAt: 9 })
    const dressed: BattleCard = { ...plain, worn: ['sword', 'pumpkin'] }
    expect(decodeCard(encodeCard(dressed))).toEqual(dressed)
    const foe = card({ name: 'F', species: 'fox', level: 14, bornAt: 3 })
    expect(fight(dressed, foe)).toEqual(fight(plain, foe))
    const forged = encodeCard({ ...plain, worn: ['pumpkin', 'nope' as never] })
    expect(decodeCard(forged)?.worn).toEqual(['pumpkin'])
  })

  it('the card carries the worn prizes', () => {
    const now = day(10, 23)
    const s = toggleWear(claimEvents(hatched(now), now), 'pumpkin', now)
    expect(cardOf(s, now)?.worn).toEqual(['pumpkin'])
  })
})
