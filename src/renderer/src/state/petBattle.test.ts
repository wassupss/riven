import { describe, it, expect } from 'vitest'
import { FOUGHT_KEEP, initialState, normalize, recordBattle } from './pet'
import {
  ADVANTAGE,
  DISADVANTAGE,
  MAX_BLOWS,
  cardOf,
  decodeCard,
  encodeCard,
  fight,
  fighterOf,
  hashOf,
  isUpset,
  legacyLevel,
  matchup,
  readCode,
  type BattleCard
} from './petBattle'
import { statsOf, statTotal, xpForLevel } from './petLevel'

const card = (over: Partial<BattleCard> = {}): BattleCard => {
  const level = over.level ?? 10
  const species = over.species ?? 'cat'
  return {
    name: '뭉치',
    species,
    level,
    stats: statsOf(level, species),
    bornAt: 1_700_000_000_000,
    ...over
  }
}

/** A well-formed code (right checksum) around any body, as a given version wrote it. */
const codeOf = (fields: unknown[], version = 1): string => {
  const bin = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(fields)))
  const body = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `RP${version}.${body}.${hashOf(body).toString(36)}`
}

describe('battle codes', () => {
  it('round-trips, Korean names included', () => {
    const c = card({ name: '꼬마 용🐉', species: 'dragon', level: 42, stats: statsOf(42, 'dragon') })
    expect(encodeCard(c).startsWith('RP2.')).toBe(true)
    expect(decodeCard(encodeCard(c))).toEqual(c)
  })

  it('finds the code inside whatever it was pasted with', () => {
    const c = card()
    expect(decodeCard(`내 거야: ${encodeCard(c)} 한 판 붙자!`)).toEqual(c)
  })

  it('rejects typos, tampering and junk', () => {
    const code = encodeCard(card())
    const [pre, body, check] = code.split('.')
    const flipped = body.slice(0, 5) + (body[5] === 'A' ? 'B' : 'A') + body.slice(6)
    expect(decodeCard(`${pre}.${flipped}.${check}`)).toBeNull()
    expect(decodeCard(code.slice(0, -1) + (code.endsWith('0') ? '1' : '0'))).toBeNull()
    expect(decodeCard('hello')).toBeNull()
    expect(decodeCard('')).toBeNull()
  })

  it('rejects pets that cannot exist', () => {
    // Well-formed codes around pets that cannot exist: level 0 or 1000, an
    // unknown species, stats that do not add up to the level's total, a stat
    // under the base.
    const s = statsOf(10, 'cat')
    for (const bad of [
      card({ level: 0 }),
      card({ level: 1000 }),
      card({ species: 'unicorn' as BattleCard['species'] }),
      card({ stats: { ...s, power: s.power + 50 } }),
      card({ stats: { ...s, power: 1, smarts: s.smarts + s.power - 1 } })
    ]) {
      expect(decodeCard(encodeCard(bad))).toBeNull()
    }
  })

  it('says so when a code is from a newer riven', () => {
    const newer = codeOf(['x', 'cat', 10, 1, 2, 3, 4, 5], 3)
    expect(readCode(newer)).toEqual({ error: 'newer' })
    expect(readCode('RP3.abc.0')).toEqual({ error: 'bad' })
    expect(readCode('nonsense')).toEqual({ error: 'bad' })
  })

  it('every pet has a card, a new one too', () => {
    const c = cardOf(initialState(Date.now()))
    expect(c.level).toBe(1)
    expect(decodeCard(encodeCard(c))).toEqual(c)
  })
})

describe('old (RP1) codes', () => {
  // [name, species, stage index, form, level, fullness, mood, sick, bornAt, worn?, design?]
  it('still read, at the level that much work is now', () => {
    const adult = decodeCard(codeOf(['뭉치', 'fox', 4, 'radiant', 10, 80, 60, 0, 42, ['crown']]))!
    expect(adult).not.toBeNull()
    expect(adult.level).toBe(legacyLevel(4, 10))
    expect(adult.stats).toEqual(statsOf(adult.level, 'fox'))
    expect(adult.worn).toEqual(['crown'])
    expect(adult.bornAt).toBe(42)
    const teen = decodeCard(codeOf(['', 'cat', 3, 'base', 0, 50, 50, 1, 7]))!
    expect(teen.level).toBe(legacyLevel(3, 0))
  })

  it('map stage and level onto the new curve', () => {
    // A v1 adult was 800 kibble; its level 10 took another 900 + 50 * 36.
    expect(legacyLevel(1, 0)).toBe(1)
    expect(legacyLevel(4, 1)).toBe(11)
    expect(legacyLevel(4, 10)).toBe(25)
    expect(xpForLevel(legacyLevel(4, 10))).toBeLessThanOrEqual(3500)
  })

  it('reject what the old format rejected', () => {
    for (const bad of [
      ['x', 'cat', 0, 'base', 0, 50, 50, 0, 1], // an egg
      ['x', 'cat', 3, 'titan', 0, 50, 50, 0, 1], // a form before adulthood
      ['x', 'cat', 4, 'base', 0, 50, 50, 0, 1], // an adult at level 0
      ['x', 'unicorn', 4, 'base', 3, 50, 50, 0, 1],
      ['x', 'cat', 4, 'nope', 3, 50, 50, 0, 1],
      ['x', 'cat', 4, 'base', 3, 500, 50, 0, 1]
    ])
      expect(decodeCard(codeOf(bad))).toBeNull()
  })
})

describe('fight', () => {
  it('is the same fight from either side', () => {
    const a = card({ name: 'A', species: 'fox', level: 20, stats: statsOf(20, 'fox') })
    const b = card({ name: 'B', species: 'crab', level: 25, stats: statsOf(25, 'crab'), bornAt: 1 })
    const ab = fight(a, b)
    const ba = fight(b, a)
    expect(ab).toEqual(fight(a, b))
    expect(ba.winner).toBe(ab.winner === null ? null : ab.winner === 0 ? 1 : 0)
    expect(ba.blows.map((w) => w.dmg)).toEqual(ab.blows.map((w) => w.dmg))
    expect(ba.blows.map((w) => w.hp)).toEqual(ab.blows.map((w) => [w.hp[1], w.hp[0]]))
  })

  it('ends: a knockout, or time', () => {
    const bout = fight(card(), card({ name: 'X', bornAt: 2 }))
    expect(bout.blows.length).toBeLessThanOrEqual(MAX_BLOWS)
    const last = bout.blows[bout.blows.length - 1]
    if (bout.winner !== null && bout.blows.length < MAX_BLOWS) expect(last.hp[bout.winner === 0 ? 1 : 0]).toBe(0)
  })

  it('wild beats sea beats spark beats wild', () => {
    expect(matchup('cat', 'fish')).toBe(ADVANTAGE)
    expect(matchup('fish', 'bird')).toBe(ADVANTAGE)
    expect(matchup('bird', 'cat')).toBe(ADVANTAGE)
    expect(matchup('fish', 'cat')).toBe(DISADVANTAGE)
    expect(matchup('cat', 'dog')).toBe(1)
  })

  it('a higher level usually wins, but not by a mile', () => {
    let wins = 0
    for (let i = 0; i < 40; i++) {
      const big = card({ name: `big${i}`, species: 'dog', level: 60, stats: statsOf(60, 'dog'), bornAt: i })
      const small = card({ name: `small${i}`, species: 'bear', level: 5, stats: statsOf(5, 'bear'), bornAt: 1000 + i })
      if (fight(big, small).winner === 0) wins++
    }
    expect(wins).toBeGreaterThanOrEqual(32)
    const hp = (lvl: number): number => fighterOf(card({ level: lvl, stats: statsOf(lvl, 'cat') })).hp
    expect(hp(60)).toBeLessThan(hp(5) * 2)
  })

  it('reads each stat for its own part of a fight', () => {
    const even = statsOf(30, 'cat')
    const total = statTotal(30)
    const lean = (k: keyof typeof even): typeof even => {
      const rest = (total - 150) / 3
      return { power: rest, smarts: rest, speed: rest, stamina: rest, [k]: 150 }
    }
    const f = (s: typeof even): ReturnType<typeof fighterOf> => fighterOf(card({ level: 30, stats: s }))
    const plain = f({ power: total / 4, smarts: total / 4, speed: total / 4, stamina: total / 4 })
    expect(f(lean('power')).atk).toBeGreaterThan(plain.atk)
    expect(f(lean('stamina')).hp).toBeGreaterThan(plain.hp)
    expect(f(lean('speed')).spd).toBeGreaterThan(plain.spd)
    expect(f(lean('smarts')).crit).toBeGreaterThan(plain.crit)
  })

  it('makes two pets of the same level a fair match', () => {
    // Same level, opposite leans: neither side wins every time.
    let wins = 0
    for (let i = 0; i < 60; i++) {
      const a = card({ name: `a${i}`, species: 'crab', level: 30, stats: statsOf(30, 'crab', { opus: 100 }), bornAt: i })
      const b = card({ name: `b${i}`, species: 'turtle', level: 30, stats: statsOf(30, 'turtle', { codex: 100 }), bornAt: 500 + i })
      if (fight(a, b).winner === 0) wins++
    }
    expect(wins).toBeGreaterThan(10)
    expect(wins).toBeLessThan(50)
  })

  it('an upset is a win over a pet ten levels up', () => {
    expect(isUpset(card({ level: 5 }), card({ level: 15 }))).toBe(true)
    expect(isUpset(card({ level: 5 }), card({ level: 14 }))).toBe(false)
  })
})

describe('the record', () => {
  it('counts a friend once a day', () => {
    const now = new Date(2026, 9, 23, 12).getTime()
    const s0 = initialState(now)
    const s1 = recordBattle(s0, 42, 'win', now)
    expect(s1.battles).toBe(1)
    expect(s1.battleWins).toBe(1)
    expect(recordBattle(s1, 42, 'loss', now + 60_000)).toBe(s1)
    const s2 = recordBattle(s1, 42, 'loss', now + 86_400_000)
    expect(s2.battles).toBe(2)
    expect(s2.battleWins).toBe(1)
    expect(recordBattle(s1, 43, 'draw', now).battles).toBe(2)
  })

  it('old saves get an empty record, and the list stays bounded', () => {
    const now = Date.now()
    const n = normalize({ bornAt: now }, now)
    expect(n.battles).toBe(0)
    expect(n.battleWins).toBe(0)
    expect(n.fought).toEqual([])
    const long = normalize({ bornAt: now, fought: Array.from({ length: 100 }, (_, i) => `${i}@d`) }, now)
    expect(long.fought.length).toBe(FOUGHT_KEEP)
  })
})
