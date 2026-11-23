import { describe, it, expect } from 'vitest'
import {
  PRIZES,
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
import { statsOf, xpForLevel } from './petLevel'

const day = (m: number, d: number): number => new Date(2026, m - 1, d, 12).getTime()
/** A pet at level 5, the first level with a keepsake. */
const hatched = (now: number, over: Partial<PetSave> = {}): PetSave => ({
  ...initialState(now),
  xp: xpForLevel(5),
  ...over
})
const slotOf = (id: string): string | undefined =>
  PRIZES.find((p) => p.id === id)?.slot

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

  it('any pet joins, a new one too, and only once', () => {
    const now = day(10, 23)
    expect(claimEvents(initialState(now), now).events).toEqual(['halloween'])
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
    expect(prizesOf(s0)).not.toContain('pumpkin')
    expect(toggleWear(s0, 'pumpkin')).toBe(s0)
    const s1 = claimEvents(s0, now)
    expect(prizesOf(s1)).toContain('pumpkin')
    const on = toggleWear(s1, 'pumpkin')
    expect(on.worn).toEqual(['pumpkin'])
    expect(toggleWear(on, 'pumpkin').worn).toEqual([])
  })

  it('one prize per slot: a new hat replaces the old one', () => {
    const now = day(10, 23)
    const s = claimEvents(hatched(now, { battles: 1, battleWins: 1 }), now)
    const a = toggleWear(s, 'bandana')
    expect(a.worn).toEqual(['bandana'])
    const b = toggleWear(a, 'pumpkin')
    expect(b.worn).toEqual(['pumpkin'])
  })

  it('wears only what was put on, one per slot, drawn back to front', () => {
    expect(outfitOf([])).toEqual([])
    const out = outfitOf(['crown', 'legend', 'pumpkin'])
    expect(out).toEqual(['legend', 'pumpkin'])
    expect(out.filter((a) => slotOf(a) === 'head')).toEqual(['pumpkin'])
  })

  it('every keepsake comes with an award, the old care ones now with levels', () => {
    const now = day(10, 23)
    expect(prizesOf(initialState(now))).toEqual([])
    expect(prizesOf(hatched(now))).toEqual(['sprout'])
    expect(prizesOf(hatched(now, { xp: xpForLevel(20) }))).toEqual(expect.arrayContaining(['sprout', 'crown', 'heart']))
    expect(prizesOf(hatched(now, { xp: xpForLevel(40) }))).toContain('sparkle')
    const fed = hatched(now, { diet: { opus: 1, sonnet: 1, haiku: 1, codex: 0, other: 0 } })
    expect(prizesOf(fed)).toContain('medal')
    const award = new Set(PRIZES.map((p) => p.award))
    expect(award.size).toBe(PRIZES.length)
  })

  it('a prize already on stays on, earned under the new rules or not', () => {
    const now = Date.now()
    // A v1 pet that won the sparkle by never falling ill, at a level that would not win it now.
    const old = normalize({ version: 1, bornAt: now, xp: 900, everSick: false, worn: ['sparkle'] }, now)
    expect(old.worn).toEqual(['sparkle'])
    expect(prizesOf(old)).not.toContain('sparkle')
    // Taking it off is allowed; putting it back waits until it is earned again.
    const off = toggleWear(old, 'sparkle')
    expect(off.worn).toEqual([])
    expect(toggleWear(off, 'sparkle')).toBe(off)
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
    level: over.level ?? 10,
    stats: statsOf(over.level ?? 10, 'cat'),
    bornAt: 1,
    ...over
  })

  it('ten levels up is an upset', () => {
    expect(isUpset(card(), card({ level: 20 }))).toBe(true)
    expect(isUpset(card(), card({ level: 19 }))).toBe(false)
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
    const foe = card({ name: 'F', species: 'fox', level: 14, stats: statsOf(14, 'fox'), bornAt: 3 })
    expect(fight(dressed, foe)).toEqual(fight(plain, foe))
    const forged = encodeCard({ ...plain, worn: ['pumpkin', 'nope' as never] })
    expect(decodeCard(forged)?.worn).toEqual(['pumpkin'])
  })

  it('the card carries the worn prizes', () => {
    const now = day(10, 23)
    const s = toggleWear(claimEvents(hatched(now), now), 'pumpkin')
    expect(cardOf(s).worn).toEqual(['pumpkin'])
  })
})
