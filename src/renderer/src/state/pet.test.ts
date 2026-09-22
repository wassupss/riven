import { describe, it, expect } from 'vitest'
import type { ModelUsage, UsageToday } from './usage'
import { DEFAULT_SETTINGS } from './settings'
import { feedFrame, drawSpecies, speciesFromBirth, strainsSeen, SPECIES } from './pet'
import {
  archive,
  awardsOf,
  dietOf,
  effectiveMs,
  feedStreak,
  flavorOf,
  freshByFlavor,
  isNight,
  nightMsBetween,
  noteEvolution,
  clean,
  cure,
  dayKey,
  decay,
  feed,
  freshTokens,
  formOf,
  growthOf,
  initialState,
  moodOf,
  normalize,
  pet,
  play,
  sampleAccounts,
  stageIndexOf,
  tokenDelta,
  tokensToKibble,
  FULLNESS_PER_KIBBLE,
  HUNGER_PER_HOUR,
  KIBBLE_TOKENS,
  MOOD_DROP_PER_HOUR,
  PET_COOLDOWN_MS,
  PET_MOOD,
  KIBBLE_PER_POOP,
  MAX_POOPS,
  MOOD_DROP_PER_POOP_HOUR,
  PLAY_COOLDOWN_MS,
  PLAY_FULLNESS_COST,
  PLAY_LOSE_MOOD,
  PLAY_WIN_MOOD,
  SICK_AFTER_HOURS,
  SLEEP_RATE,
  STAGE_XP,
  type PetSave
} from './pet'

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
const base = (over: Partial<PetSave> = {}): PetSave => ({
  ...initialState(T0),
  ...over
})

describe('tokensToKibble', () => {
  it('converts whole kibble and carries the remainder', () => {
    expect(tokensToKibble(2 * KIBBLE_TOKENS + 500, 0)).toEqual({ kibble: 2, carry: 500 })
  })

  it('lets carried remainders add up to a meal', () => {
    const a = tokensToKibble(KIBBLE_TOKENS * 0.6, 0)
    expect(a.kibble).toBe(0)
    expect(tokensToKibble(KIBBLE_TOKENS * 0.6, a.carry)).toEqual({
      kibble: 1,
      carry: KIBBLE_TOKENS * 0.2
    })
  })

  it('ignores negative and fractional noise', () => {
    expect(tokensToKibble(-50, 0)).toEqual({ kibble: 0, carry: 0 })
    expect(tokensToKibble(KIBBLE_TOKENS + 500.9, 0)).toEqual({ kibble: 1, carry: 500 })
  })
})

describe('freshTokens', () => {
  const today = (perModel: ModelUsage[]): UsageToday => ({
    totalCost: 0,
    totalTokens: 999_999,
    perModel
  })

  it('counts input, output and cache writes — never cache reads', () => {
    expect(
      freshTokens(
        today([
          { model: 'opus', input: 3000, output: 1_400_000, cacheWrite: 5_000_000, cacheRead: 478_000_000, cost: 0 }
        ])
      )
    ).toBe(6_403_000)
  })

  it('falls back to the plain total when there is no breakdown (Codex)', () => {
    expect(freshTokens(today([]))).toBe(999_999)
  })

  it('is zero for a missing day', () => {
    expect(freshTokens(null)).toBe(0)
    expect(freshTokens(undefined)).toBe(0)
  })
})

describe('feed', () => {
  it('raises fullness by 4 per kibble and counts xp', () => {
    const s = feed(base({ fullness: 0, mood: 0 }), 10 * KIBBLE_TOKENS, T0)
    expect(s.xp).toBe(10)
    expect(s.fullness).toBe(10 * FULLNESS_PER_KIBBLE)
    expect(s.mood).toBe(15)
    expect(s.feedCount).toBe(1)
    expect(s.lastFedAt).toBe(T0)
  })

  it('caps fullness at 100 but keeps crediting growth when overfed', () => {
    const s = feed(base({ fullness: 90 }), 500 * KIBBLE_TOKENS, T0)
    expect(s.fullness).toBe(100)
    expect(s.mood).toBe(100)
    expect(s.xp).toBe(500)
  })

  it('records sub-kibble tokens without a meal', () => {
    const s = feed(base({ fullness: 50 }), 400, T0)
    expect(s.xp).toBe(0)
    expect(s.carryTokens).toBe(400)
    expect(s.fullness).toBe(50)
    expect(s.feedCount).toBe(0)
    expect(s.totalTokens).toBe(400)
  })

  it('is a no-op for zero tokens', () => {
    const s = base()
    expect(feed(s, 0, T0)).toBe(s)
  })
})

describe('decay', () => {
  it('drains fullness at 12.5/hour', () => {
    const s = decay(base({ fullness: 100, lastTickAt: T0 }), T0 + 4 * HOUR)
    expect(s.fullness).toBeCloseTo(100 - 4 * HUNGER_PER_HOUR)
    expect(s.neglectMs).toBe(0)
  })

  it('empties after 8 hours and never goes below zero', () => {
    const s = decay(base({ fullness: 100, lastTickAt: T0 }), T0 + 20 * HOUR)
    expect(s.fullness).toBe(0)
  })

  it('counts only the time spent empty as neglect', () => {
    // Full-from-50 lasts 4h; 10h elapsed leaves 6h of starving.
    const s = decay(base({ fullness: 50, mood: 100, lastTickAt: T0 }), T0 + 10 * HOUR)
    expect(s.neglectMs).toBeCloseTo(6 * HOUR)
    expect(s.mood).toBeCloseTo(100 + 4 * 4 - 6 * MOOD_DROP_PER_HOUR)
  })

  it('lifts mood while there is still food in the belly', () => {
    const s = decay(base({ fullness: 100, mood: 50, lastTickAt: T0 }), T0 + 2 * HOUR)
    expect(s.mood).toBeCloseTo(58)
  })

  it('replaying one long interval matches many small ticks', () => {
    const start = base({ fullness: 80, mood: 60, lastTickAt: T0 })
    const oneShot = decay(start, T0 + 12 * HOUR)
    let stepped = start
    for (let h = 1; h <= 12; h++) stepped = decay(stepped, T0 + h * HOUR)
    expect(stepped.fullness).toBeCloseTo(oneShot.fullness)
    expect(stepped.mood).toBeCloseTo(oneShot.mood)
    expect(stepped.neglectMs).toBeCloseTo(oneShot.neglectMs)
  })

  it('does not refund hunger when the clock goes backwards', () => {
    const s = base({ fullness: 40, lastTickAt: T0 })
    const back = decay(s, T0 - HOUR)
    expect(back.fullness).toBe(40)
    expect(back.lastTickAt).toBe(T0 - HOUR)
  })
})

describe('pet', () => {
  it('bumps mood and starts a cooldown', () => {
    const s = pet(base({ mood: 50 }), T0)
    expect(s.mood).toBe(50 + PET_MOOD)
    expect(pet(s, T0 + PET_COOLDOWN_MS - 1)).toBe(s)
    expect(pet(s, T0 + PET_COOLDOWN_MS).mood).toBe(50 + 2 * PET_MOOD)
  })
})

describe('growth', () => {
  it('advances a stage at each xp threshold', () => {
    expect(stageIndexOf(0)).toBe(0)
    expect(stageIndexOf(STAGE_XP[1] - 1)).toBe(0)
    expect(stageIndexOf(STAGE_XP[1])).toBe(1)
    expect(stageIndexOf(STAGE_XP[3])).toBe(3)
    expect(stageIndexOf(STAGE_XP[4] * 10)).toBe(4)
  })

  it('reports progress toward the next stage', () => {
    const g = growthOf(base({ xp: 35 }), T0)
    expect(g.stage).toBe('hatchling')
    expect(g.progress).toBeCloseTo((35 - 10) / (60 - 10))
    expect(g.toNext).toBe(25)
  })

  it('is complete at the final stage', () => {
    const g = growthOf(base({ xp: 2000, bornAt: T0 - 400 * HOUR }), T0)
    expect(g.stage).toBe('adult')
    expect(g.progress).toBe(1)
    expect(g.toNext).toBe(0)
  })
})

describe('formOf', () => {
  // 1000 kibble over 300h ≈ 3.3 kibble/h: a moderate eater, well under titan.
  const grown = (over: Partial<PetSave>): PetSave =>
    base({ xp: 1000, bornAt: T0 - 300 * HOUR, ...over })

  it('stays "base" until fully grown', () => {
    expect(formOf(base({ xp: STAGE_XP[3] }), T0)).toBe('base')
  })

  it('grows into a wraith when left starving most of its life', () => {
    expect(formOf(grown({ neglectMs: 150 * HOUR }), T0)).toBe('wraith')
  })

  it('grows into a titan when gorged', () => {
    // 1000 kibble in 20h = 50/h, way over the titan rate.
    expect(formOf(grown({ bornAt: T0 - 20 * HOUR, neglectMs: 0 }), T0)).toBe('titan')
  })

  it('grows radiant when fed steadily and barely ever hungry', () => {
    expect(formOf(grown({ neglectMs: 6 * HOUR }), T0)).toBe('radiant')
  })

  it('grows sturdy in between', () => {
    expect(formOf(grown({ neglectMs: 60 * HOUR }), T0)).toBe('sturdy')
  })

  it('a starved pet is a wraith even if it was gorged early on', () => {
    // Neglect is checked first: how it was treated outranks how much it ate.
    expect(formOf(grown({ bornAt: T0 - 20 * HOUR, neglectMs: 15 * HOUR }), T0)).toBe('wraith')
  })
})

describe('moodOf', () => {
  it('reads sad when empty or miserable', () => {
    expect(moodOf(base({ fullness: 0, mood: 90 }))).toBe('sad')
    expect(moodOf(base({ fullness: 80, mood: 10 }))).toBe('sad')
  })
  it('reads hungry below the hunger line', () => {
    expect(moodOf(base({ fullness: 20, mood: 80 }))).toBe('hungry')
  })
  it('reads happy when full and cheerful', () => {
    expect(moodOf(base({ fullness: 80, mood: 80 }))).toBe('happy')
    expect(moodOf(base({ fullness: 80, mood: 50 }))).toBe('ok')
  })
})

describe('tokenDelta', () => {
  it('returns the increase between samples', () => {
    expect(tokenDelta(1000, 2500)).toBe(1500)
  })
  it('treats a drop as a fresh daily total, not a refund', () => {
    expect(tokenDelta(900_000, 1200)).toBe(1200)
  })
  it('ignores garbage', () => {
    expect(tokenDelta(100, Number.NaN)).toBe(0)
    expect(tokenDelta(100, -5)).toBe(0)
  })
})

describe('droppings', () => {
  const kib = (n: number): number => n * KIBBLE_TOKENS

  it('appears once per 30 kibble eaten', () => {
    const s = feed(base(), kib(KIBBLE_PER_POOP), T0)
    expect(s.poops).toBe(1)
    expect(s.poopCarry).toBe(0)
  })

  it('carries a part-finished dropping into the next meal', () => {
    const a = feed(base(), kib(KIBBLE_PER_POOP - 5), T0)
    expect(a.poops).toBe(0)
    expect(a.poopCarry).toBe(KIBBLE_PER_POOP - 5)
    expect(feed(a, kib(5), T0).poops).toBe(1)
  })

  it('never buries the screen, however big the meal', () => {
    expect(feed(base(), kib(KIBBLE_PER_POOP * 50), T0).poops).toBe(MAX_POOPS)
  })

  it('drags the mood down while it is left there', () => {
    // Below the ceiling on purpose: a mood already at 100 would clamp the gap away.
    const dirty = decay(base({ fullness: 100, mood: 50, poops: 2, lastTickAt: T0 }), T0 + 2 * HOUR)
    const cleanPet = decay(base({ fullness: 100, mood: 50, poops: 0, lastTickAt: T0 }), T0 + 2 * HOUR)
    expect(cleanPet.mood - dirty.mood).toBeCloseTo(2 * 2 * MOOD_DROP_PER_POOP_HOUR)
  })

  it('is cleared by cleaning, and cleaning a clean floor changes nothing', () => {
    const s = base({ poops: 3 })
    expect(clean(s).poops).toBe(0)
    const already = base({ poops: 0 })
    expect(clean(already)).toBe(already)
  })
})

describe('illness', () => {
  it('sets in after six hours of starving', () => {
    const s = decay(base({ fullness: 0, mood: 50, lastTickAt: T0 }), T0 + SICK_AFTER_HOURS * HOUR)
    expect(s.sick).toBe(true)
  })

  it('sets in from living in a full mess, even when fed', () => {
    const s = decay(
      base({ fullness: 100, mood: 90, poops: MAX_POOPS, lastTickAt: T0 }),
      T0 + (SICK_AFTER_HOURS + 1) * HOUR
    )
    expect(s.sick).toBe(true)
  })

  it('does not set in on a pet that is fed and clean', () => {
    // Six hours with food still in the belly — no neglect to accumulate.
    const s = decay(base({ fullness: 100, mood: 90, lastTickAt: T0 }), T0 + 6 * HOUR)
    expect(s.sick).toBe(false)
    expect(s.illHours).toBe(0)
  })

  it('backs off again once it is looked after', () => {
    const ill = decay(base({ fullness: 0, lastTickAt: T0 }), T0 + 4 * HOUR)
    expect(ill.illHours).toBeCloseTo(4)
    const fed = decay({ ...ill, fullness: 100, lastTickAt: T0 + 4 * HOUR }, T0 + 7 * HOUR)
    expect(fed.illHours).toBeCloseTo(1)
    expect(fed.sick).toBe(false)
  })

  it('bleeds mood faster while ill', () => {
    const ill = decay(base({ fullness: 100, mood: 100, sick: true, lastTickAt: T0 }), T0 + 2 * HOUR)
    const well = decay(base({ fullness: 100, mood: 100, lastTickAt: T0 }), T0 + 2 * HOUR)
    expect(well.mood).toBeGreaterThan(ill.mood)
  })

  it('is what medicine is for', () => {
    const healthy = cure(base({ sick: true, illHours: 9, mood: 40 }))
    expect(healthy.sick).toBe(false)
    expect(healthy.illHours).toBe(0)
    expect(healthy.mood).toBe(45)
    const notIll = base({ sick: false })
    expect(cure(notIll)).toBe(notIll)
  })

  it('reads as the mood above every other feeling', () => {
    expect(moodOf(base({ sick: true, fullness: 100, mood: 100 }))).toBe('sick')
  })
})

describe('play', () => {
  it('lifts the mood more for a win than a loss, and costs appetite', () => {
    const won = play(base({ mood: 50, fullness: 50 }), 'left', 'left', T0)
    expect(won.win).toBe(true)
    expect(won.state.mood).toBe(50 + PLAY_WIN_MOOD)
    expect(won.state.fullness).toBe(50 - PLAY_FULLNESS_COST)
    expect(won.state.wins).toBe(1)

    const lost = play(base({ mood: 50, fullness: 50 }), 'left', 'right', T0)
    expect(lost.win).toBe(false)
    expect(lost.state.mood).toBe(50 + PLAY_LOSE_MOOD)
    expect(lost.state.wins).toBe(0)
    expect(lost.state.plays).toBe(1)
  })

  it('is rate-limited', () => {
    const first = play(base({ fullness: 50 }), 'left', 'left', T0).state
    expect(play(first, 'left', 'left', T0 + PLAY_COOLDOWN_MS - 1).played).toBe(false)
    expect(play(first, 'left', 'left', T0 + PLAY_COOLDOWN_MS).played).toBe(true)
  })

  it('is declined by a pet that is ill or starving', () => {
    expect(play(base({ sick: true, fullness: 90 }), 'left', 'left', T0).played).toBe(false)
    expect(play(base({ fullness: 1 }), 'left', 'left', T0).played).toBe(false)
  })
})

describe('feed history', () => {
  it('tallies kibble under the day it was eaten', () => {
    const a = feed(base(), 4 * KIBBLE_TOKENS, T0)
    const b = feed(a, 6 * KIBBLE_TOKENS, T0 + HOUR)
    expect(b.history).toEqual([{ day: dayKey(T0), kibble: 10 }])
    const nextDay = feed(b, 2 * KIBBLE_TOKENS, T0 + 30 * HOUR)
    expect(nextDay.history).toHaveLength(2)
    expect(nextDay.history[1]).toEqual({ day: dayKey(T0 + 30 * HOUR), kibble: 2 })
  })

  it('keeps at most a fortnight', () => {
    let s = base()
    for (let d = 0; d < 20; d++) s = feed(s, KIBBLE_TOKENS, T0 + d * 24 * HOUR)
    expect(s.history).toHaveLength(14)
    expect(s.history[13].day).toBe(dayKey(T0 + 19 * 24 * HOUR))
  })

  it('records nothing for tokens too small to be a kibble', () => {
    expect(feed(base(), 500, T0).history).toEqual([])
  })
})

describe('album', () => {
  it('keeps a page for a pet that lived', () => {
    const s = base({ xp: 900, name: '첫째', bornAt: T0 - 300 * HOUR, neglectMs: 6 * HOUR, totalTokens: 18_000_000 })
    const [entry] = archive(s, T0)
    expect(entry.name).toBe('첫째')
    expect(entry.stage).toBe('adult')
    expect(entry.form).toBe('radiant')
    expect(entry.xp).toBe(900)
  })

  it('does not keep a page for an egg that never ate', () => {
    expect(archive(base({ xp: 0 }), T0)).toEqual([])
  })

  it('remembers the last eight only', () => {
    let album: ReturnType<typeof archive> = []
    for (let i = 0; i < 12; i++) album = archive(base({ xp: 100, name: `p${i}`, album }), T0)
    expect(album).toHaveLength(8)
    expect(album[7].name).toBe('p11')
  })
})

// A moment at a known LOCAL hour, so the night tests read the same clock the
// pet does whatever the machine's timezone is.
const atHour = (h: number, dayOffset = 0): number => {
  const d = new Date(T0)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, 0, 0, 0)
  return d.getTime()
}

describe('night', () => {
  it('sleeps through the small hours and is up in the day', () => {
    expect(isNight(atHour(2))).toBe(true)
    expect(isNight(atHour(23))).toBe(true)
    expect(isNight(atHour(6))).toBe(true)
    expect(isNight(atHour(7))).toBe(false)
    expect(isNight(atHour(14))).toBe(false)
  })

  it('measures how much of a span was night', () => {
    expect(nightMsBetween(atHour(9), atHour(17))).toBe(0)
    expect(nightMsBetween(atHour(23), atHour(7, 1))).toBeCloseTo(8 * HOUR)
    // 22:00 → 02:00 is three hours of night.
    expect(nightMsBetween(atHour(22), atHour(2, 1))).toBeCloseTo(3 * HOUR)
  })

  it('makes night hours pass slowly for the pet', () => {
    expect(effectiveMs(atHour(9), atHour(12))).toBeCloseTo(3 * HOUR)
    expect(effectiveMs(atHour(23), atHour(7, 1))).toBeCloseTo(8 * HOUR * SLEEP_RATE)
  })

  it('costs a sleeping pet far less hunger than a waking one', () => {
    const night = decay(base({ fullness: 100, lastTickAt: atHour(23) }), atHour(7, 1))
    const day = decay(base({ fullness: 100, lastTickAt: atHour(9) }), atHour(17))
    expect(night.fullness).toBeGreaterThan(day.fullness)
    expect(night.fullness).toBeCloseTo(100 - 8 * SLEEP_RATE * HUNGER_PER_HOUR)
  })

  it('will not play in the middle of the night', () => {
    expect(play(base({ fullness: 80 }), 'left', 'left', atHour(3)).played).toBe(false)
    expect(play(base({ fullness: 80 }), 'left', 'left', atHour(15)).played).toBe(true)
  })
})

describe('diet', () => {
  it('reads the flavour off a model id', () => {
    expect(flavorOf('claude-opus-5')).toBe('opus')
    expect(flavorOf('claude-sonnet-5')).toBe('sonnet')
    expect(flavorOf('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(flavorOf('gpt-5.6-terra')).toBe('codex')
    expect(flavorOf('<synthetic>')).toBe('other')
  })

  it('splits today by model, counting only fresh tokens', () => {
    const today = {
      totalCost: 0,
      totalTokens: 0,
      perModel: [
        { model: 'claude-opus-5', input: 10, output: 90, cacheWrite: 100, cacheRead: 9_000_000, cost: 0 },
        { model: 'claude-haiku-4-5', input: 0, output: 50, cacheWrite: 0, cacheRead: 5000, cost: 0 }
      ]
    }
    expect(freshByFlavor(today)).toEqual({ opus: 200, haiku: 50 })
  })

  it('records what each meal was made of', () => {
    let s = feed(base(), 60 * KIBBLE_TOKENS, T0, 'opus')
    s = feed(s, 20 * KIBBLE_TOKENS, T0, 'haiku')
    expect(s.diet.opus).toBe(60)
    expect(s.diet.haiku).toBe(20)
    const d = dietOf(s)
    expect(d.top).toBe('opus')
    expect(d.share).toBeCloseTo(0.75)
    expect(d.total).toBe(80)
  })

  it('has no favourite before it has eaten', () => {
    expect(dietOf(base()).total).toBe(0)
  })
})

describe('evolutions', () => {
  it('records the stage a pet has just reached, after the egg it started as', () => {
    const before = base({ xp: 5 })
    const after = { ...before, xp: 20 } // past the hatchling threshold
    const log = noteEvolution(before, after, T0)
    expect(log.map((e) => e.stage)).toEqual(['egg', 'hatchling'])
    expect(log[1].at).toBe(T0)
  })

  it('returns the same array when nothing grew', () => {
    const before = base({ xp: 20, evolutions: [{ stage: 'hatchling', form: 'base', at: T0 }] })
    const after = { ...before, xp: 25 }
    expect(noteEvolution(before, after, T0 + HOUR)).toBe(after.evolutions)
  })

  it('opens the story with the egg it was born as', () => {
    expect(base().evolutions).toEqual([{ stage: 'egg', form: 'base', at: T0 }])
    // And nothing is added while it is still an egg.
    expect(noteEvolution(base(), base(), T0 + HOUR)).toEqual(base().evolutions)
  })
})

describe('feedStreak', () => {
  const day = (n: number): string => dayKey(T0 + n * 24 * HOUR)

  it('counts consecutive days only', () => {
    expect(feedStreak([])).toBe(0)
    expect(
      feedStreak([0, 1, 2, 4, 5].map((n) => ({ day: day(n), kibble: 1 })))
    ).toBe(3)
  })

  it('counts a full week', () => {
    expect(feedStreak(Array.from({ length: 7 }, (_, i) => ({ day: day(i), kibble: 5 })))).toBe(7)
  })
})

describe('awards', () => {
  const ids = (s: PetLike, now = T0): string[] =>
    awardsOf(s, now).filter((a) => a.done).map((a) => a.id)
  type PetLike = Parameters<typeof awardsOf>[0]

  it('starts with nothing to show for itself', () => {
    expect(ids(base())).toEqual([])
  })

  it('lights up as the pet earns them', () => {
    const grown = base({
      xp: 900,
      totalTokens: 12_000_000,
      bornAt: T0 - 300 * HOUR,
      neglectMs: 2 * HOUR,
      plays: 12,
      wins: 6,
      album: [1, 2, 3].map(() => ({ name: '', species: 'cat' as const, stage: 'adult' as const, form: 'sturdy' as const, xp: 1, tokens: 1, ageMs: 1, neglectMs: 0, endedAt: T0 })),
      history: Array.from({ length: 7 }, (_, i) => ({ day: dayKey(T0 + i * 24 * HOUR), kibble: 3 }))
    })
    expect(ids(grown).sort()).toEqual(
      ['devoted', 'grown', 'hatch', 'keeper', 'lucky', 'million', 'playful', 'streak', 'tenMillion', 'tidy'].sort()
    )
  })

  it('withholds the spotless one from a pet that has been ill', () => {
    const s = base({ xp: 900, everSick: true, bornAt: T0 - 300 * HOUR })
    expect(ids(s)).not.toContain('tidy')
  })
})

describe('sampleAccounts', () => {
  it('only baselines an account the first time it is seen', () => {
    const r = sampleAccounts({}, { work: 120_000 })
    expect(r.delta).toBe(0)
    expect(r.seen).toEqual({ work: 120_000 })
  })

  it('feeds the growth of every known account', () => {
    const r = sampleAccounts({ work: 1000, home: 500 }, { work: 4000, home: 700 })
    expect(r.delta).toBe(3200)
    // Per key too, so each model's tokens can be fed as their own flavour.
    expect(r.deltas).toEqual({ work: 3000, home: 200 })
  })

  it('does not read a new account as a burst of spend', () => {
    const r = sampleAccounts({ work: 1000 }, { work: 1500, codex: 900_000 })
    expect(r.delta).toBe(500)
    expect(r.seen.codex).toBe(900_000)
  })

  it('handles the midnight reset of one account', () => {
    const r = sampleAccounts({ work: 900_000, home: 100 }, { work: 300, home: 100 })
    expect(r.delta).toBe(300)
  })

  it('keeps accounts that dropped out of the sample', () => {
    const r = sampleAccounts({ work: 1000, gone: 42 }, { work: 1000 })
    expect(r.seen).toEqual({ work: 1000, gone: 42 })
    expect(r.delta).toBe(0)
  })
})

describe('normalize', () => {
  it('falls back to a fresh pet for junk input', () => {
    expect(normalize(null, T0).bornAt).toBe(T0)
    expect(normalize('nope', T0).xp).toBe(0)
  })

  it('clamps out-of-range and NaN fields', () => {
    const s = normalize(
      { version: 1, fullness: 900, mood: Number.NaN, xp: -3, neglectMs: -1, carryTokens: 9e9 },
      T0
    )
    expect(s.fullness).toBe(100)
    expect(s.mood).toBe(initialState(T0).mood)
    expect(s.xp).toBe(0)
    expect(s.neglectMs).toBe(0)
    expect(s.carryTokens).toBe(KIBBLE_TOKENS - 1)
  })

  it('never keeps a pet born or ticked in the future', () => {
    const s = normalize({ bornAt: T0 + 10 * HOUR, lastTickAt: T0 + 20 * HOUR }, T0)
    expect(s.bornAt).toBe(T0)
    expect(s.lastTickAt).toBe(T0)
  })

  it('keeps a good save intact', () => {
    const saved = base({ xp: 120, fullness: 55, mood: 44, neglectMs: 3 * HOUR, name: '리븐이' })
    expect(normalize(saved, T0 + HOUR)).toEqual(saved)
  })
})

describe('how it ships', () => {
  // The pet lives on the desk, not in the dock: a first-run riven shows the
  // floating device straight away. It is also NOT always-on-top, so main/pet.ts
  // has to open it BESIDE riven's window — inside those bounds it would be
  // covered the moment riven took focus, i.e. open but invisible.
  it('is out on the desk by default, and not in the way', () => {
    expect(DEFAULT_SETTINGS.petShow).toBe(true)
    expect(DEFAULT_SETTINGS.petDetached).toBe(true)
    expect(DEFAULT_SETTINGS.petChrome).toBe('full')
    // Floating above everything is offered, not assumed.
    expect(DEFAULT_SETTINGS.petOnTop).toBe(false)
  })
})

describe('feedFrame', () => {
  const DAY = 24 * 3600_000
  const key = (ms: number): string => {
    const d = new Date(ms)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  it('draws seven calendar days even when only one has a meal', () => {
    const f = feedFrame([{ day: key(T0), kibble: 152 }], T0)
    expect(f).toHaveLength(7)
    expect(f.map((d) => d.kibble)).toEqual([0, 0, 0, 0, 0, 0, 152])
    expect(f[6].today).toBe(true)
    expect(f.filter((d) => d.today)).toHaveLength(1)
  })

  it('keeps the gaps between days that are far apart', () => {
    // Fed today and six days ago: the two must NOT end up side by side, which is
    // what plotting the history array directly used to do.
    const f = feedFrame(
      [
        { day: key(T0 - 6 * DAY), kibble: 20 },
        { day: key(T0), kibble: 40 }
      ],
      T0
    )
    expect(f[0].kibble).toBe(20)
    expect(f[6].kibble).toBe(40)
    expect(f.slice(1, 6).every((d) => d.kibble === 0)).toBe(true)
  })

  it('leaves out days older than the frame', () => {
    const f = feedFrame([{ day: key(T0 - 30 * DAY), kibble: 999 }], T0)
    expect(f.every((d) => d.kibble === 0)).toBe(true)
  })

  it('is oldest first, and ends on today', () => {
    const f = feedFrame([], T0)
    expect(f[0].day < f[6].day).toBe(true)
    expect(f[6].day).toBe(key(T0))
  })

  it('draws an empty week as an empty week, not as nothing', () => {
    expect(feedFrame([], T0, 3)).toEqual([
      { day: key(T0 - 2 * DAY), kibble: 0, today: false },
      { day: key(T0 - DAY), kibble: 0, today: false },
      { day: key(T0), kibble: 0, today: true }
    ])
  })
})

describe('species', () => {
  it('draws evenly across the strains', () => {
    // The draw is a pure function of one number, so the whole distribution is
    // checkable without a random source.
    const n = 600
    const drawn = Array.from({ length: n }, (_, i) => drawSpecies(i / n))
    for (const sp of SPECIES)
      expect(drawn.filter((d) => d === sp)).toHaveLength(n / SPECIES.length)
  })

  it('never falls off either end of the table', () => {
    expect(drawSpecies(0)).toBe(SPECIES[0])
    expect(drawSpecies(1)).toBe(SPECIES[SPECIES.length - 1])
    expect(SPECIES).toContain(drawSpecies(-5))
    expect(SPECIES).toContain(drawSpecies(99))
  })

  it('gives a new egg one of them', () => {
    expect(SPECIES).toContain(initialState(T0).species)
  })

  it('keeps the strain a save already has', () => {
    const s = normalize({ ...base(), species: 'turtle' }, T0 + HOUR)
    expect(s.species).toBe('turtle')
  })

  it('gives a pet from before strains existed a stable one', () => {
    // Same pet, two loads: it must not turn into something else on reload, which
    // a fresh random draw in normalize would have done.
    const old = { ...base(), species: undefined }
    const first = normalize(old, T0 + HOUR)
    const second = normalize(old, T0 + 5 * HOUR)
    expect(first.species).toBe(second.species)
    expect(first.species).toBe(speciesFromBirth(first.bornAt))
    expect(SPECIES).toContain(first.species)
  })

  it('refuses a strain that is not one of them', () => {
    const s = normalize({ ...base(), species: 'unicorn' }, T0)
    expect(SPECIES).toContain(s.species)
    expect(s.species).not.toBe('unicorn')
  })

  it('spreads birthdays across every strain', () => {
    const seen = new Set(
      Array.from({ length: 400 }, (_, i) => speciesFromBirth(T0 + i * 60_000))
    )
    expect(seen.size).toBe(SPECIES.length)
  })

  it('survives being fed, starved and played with', () => {
    let s = base({ species: 'fish' })
    s = feed(s, 100 * KIBBLE_TOKENS, T0)
    s = decay(s, T0 + 30 * HOUR)
    s = play(s, 'left', 'left', T0 + 31 * HOUR).state
    s = pet(s, T0 + 32 * HOUR)
    expect(s.species).toBe('fish')
  })

  it('remembers what each past pet was', () => {
    const album = archive(base({ species: 'bird', xp: 40 }), T0 + HOUR)
    expect(album[album.length - 1].species).toBe('bird')
  })

  it('counts the strains a keeper has met, current pet included', () => {
    const entry = (species: (typeof SPECIES)[number]): PetSave['album'][number] => ({
      name: '', species, stage: 'adult', form: 'sturdy', xp: 1, tokens: 1, ageMs: 1, neglectMs: 0, endedAt: T0
    })
    expect(strainsSeen(base({ species: 'cat', album: [] }))).toBe(1)
    expect(strainsSeen(base({ species: 'cat', album: [entry('cat'), entry('cat')] }))).toBe(1)
    expect(strainsSeen(base({ species: 'cat', album: [entry('rabbit'), entry('turtle')] }))).toBe(3)
  })
})
