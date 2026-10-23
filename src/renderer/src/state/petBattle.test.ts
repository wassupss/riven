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
  matchup,
  type BattleCard
} from './petBattle'

const card = (over: Partial<BattleCard> = {}): BattleCard => ({
  name: '뭉치',
  species: 'cat',
  stage: 'adult',
  form: 'base',
  level: 10,
  fullness: 80,
  mood: 60,
  sick: false,
  bornAt: 1_700_000_000_000,
  ...over
})

describe('battle codes', () => {
  it('round-trips, Korean names included', () => {
    const c = card({ name: '꼬마 용🐉', species: 'dragon', form: 'radiant', level: 42 })
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
    // Well-formed codes (right checksum) around pets that cannot exist: an egg,
    // a non-adult with a form, an adult at level 0, an unknown species, Lv1000.
    for (const bad of [
      card({ stage: 'egg' as BattleCard['stage'], level: 0 }),
      card({ stage: 'teen', level: 0, form: 'titan' }),
      card({ stage: 'adult', level: 0 }),
      card({ species: 'unicorn' as BattleCard['species'] }),
      card({ level: 1000 })
    ]) {
      expect(decodeCard(encodeCard(bad))).toBeNull()
    }
  })

  it('an egg has no card', () => {
    expect(cardOf(initialState(Date.now()), Date.now())).toBeNull()
  })
})

describe('fight', () => {
  it('is the same fight from either side', () => {
    const a = card({ name: 'A', species: 'fox', level: 20 })
    const b = card({ name: 'B', species: 'crab', level: 25, bornAt: 1 })
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

  it('a well raised pet usually wins, but not always by a mile', () => {
    let wins = 0
    for (let i = 0; i < 40; i++) {
      const big = card({ name: `big${i}`, species: 'dog', level: 60, bornAt: i })
      const small = card({ name: `small${i}`, species: 'bear', level: 5, bornAt: 1000 + i })
      if (fight(big, small).winner === 0) wins++
    }
    expect(wins).toBeGreaterThanOrEqual(32)
    expect(fighterOf(card({ level: 60 })).hp).toBeLessThan(fighterOf(card({ level: 5 })).hp * 2)
  })

  it('a sick, hungry pet hits softer', () => {
    expect(fighterOf(card({ sick: true, fullness: 0 })).atk).toBeLessThan(fighterOf(card()).atk)
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
