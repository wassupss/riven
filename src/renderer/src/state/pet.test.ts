import { describe, it, expect } from 'vitest'
import type { ModelUsage, UsageToday } from './usage'
import { DEFAULT_SETTINGS, migrateLegacy, type Settings } from './settings'
import {
  adopt,
  applyCommand,
  archive,
  awardsOf,
  briefOf,
  claimEvents,
  dayKey,
  dayStreak,
  dietOf,
  drawSpecies,
  earn,
  feedFrame,
  flavorOf,
  foodByFlavor,
  foodTokens,
  foodTotals,
  initialState,
  normalize,
  normalizeNest,
  prizesOf,
  progressOf,
  release,
  rest,
  restart,
  sampleAccounts,
  show,
  speciesFromBirth,
  strainsSeen,
  tokenDelta,
  tokensToXp,
  wantsBreak,
  workStreakMs,
  BREAK_MIN_MS,
  BREAK_MS,
  BREAK_NAG_MS,
  CACHE_READ_WEIGHT,
  FOOD_FORMULA,
  MAX_PETS,
  NEST_VERSION,
  PET_VERSION,
  PRIZES,
  SPECIES,
  WORK_IDLE_RESET_MS,
  type AlbumEntry,
  type PetSave
} from './pet'
import { XP_TOKENS, xpForLevel } from './petLevel'

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
const base = (over: Partial<PetSave> = {}): PetSave => ({
  ...initialState(T0),
  ...over
})
const page = (over: Partial<AlbumEntry> = {}): AlbumEntry => ({
  name: '',
  species: 'cat',
  level: 1,
  xp: 1,
  tokens: 1,
  ageMs: 1,
  endedAt: T0,
  ...over
})
// A moment at a known LOCAL hour.
const atHour = (h: number, dayOffset = 0): number => {
  const d = new Date(T0)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, 0, 0, 0)
  return d.getTime()
}

describe('tokensToXp', () => {
  it('converts whole XP and carries the remainder', () => {
    expect(tokensToXp(2 * XP_TOKENS + 500, 0)).toEqual({ xp: 2, carry: 500 })
  })

  it('lets carried remainders add up', () => {
    const a = tokensToXp(XP_TOKENS * 0.6, 0)
    expect(a.xp).toBe(0)
    expect(tokensToXp(XP_TOKENS * 0.6, a.carry)).toEqual({ xp: 1, carry: XP_TOKENS * 0.2 })
  })

  it('ignores negative and fractional noise', () => {
    expect(tokensToXp(-50, 0)).toEqual({ xp: 0, carry: 0 })
    expect(tokensToXp(XP_TOKENS + 500.9, 0)).toEqual({ xp: 1, carry: 500 })
  })
})

describe('foodTokens', () => {
  const today = (perModel: ModelUsage[], extra: Partial<UsageToday> = {}): UsageToday => ({
    totalCost: 0,
    totalTokens: 999_999,
    perModel,
    ...extra
  })

  it('counts input, output and cache writes in full, and cache reads at their price ratio', () => {
    expect(CACHE_READ_WEIGHT).toBe(0.1)
    expect(
      foodTokens(
        today([
          { model: 'opus', input: 3000, output: 1_400_000, cacheWrite: 5_000_000, cacheRead: 478_000_000, cost: 0 }
        ])
      )
    ).toBe(6_403_000 + 47_800_000)
  })

  it('credits lean cache-read work, not only re-caching', () => {
    const lean = foodTokens(today([{ model: 'opus', input: 0, output: 100_000, cacheWrite: 0, cacheRead: 20_000_000, cost: 0 }]))
    expect(lean).toBe(2_100_000)
  })

  it('falls back to the plain total when there is no breakdown (Codex)', () => {
    expect(foodTokens(today([]))).toBe(999_999)
  })

  it("weighs Codex's cached input like a cache read", () => {
    expect(foodTokens(today([], { totalTokens: 1_000_000, cacheRead: 800_000 }))).toBe(200_000 + 80_000)
    // A figure past the total is clamped, never negative food.
    expect(foodTokens(today([], { totalTokens: 100, cacheRead: 500 }))).toBe(10)
  })

  it('is zero for a missing day', () => {
    expect(foodTokens(null)).toBe(0)
    expect(foodTokens(undefined)).toBe(0)
  })
})

describe('foodTotals', () => {
  const day = (cacheRead: number): UsageToday => ({
    totalCost: 0,
    totalTokens: 0,
    perModel: [{ model: 'claude-opus-5', input: 0, output: 1000, cacheWrite: 0, cacheRead, cost: 0 }]
  })

  it('keys every counter by formula, account and flavour', () => {
    expect(foodTotals([{ id: 'claude', today: day(10_000) }, { id: 'x', today: null }])).toEqual({
      [`f${FOOD_FORMULA}:claude::opus`]: 2000
    })
  })

  it('stays monotone through the day', () => {
    let prev = 0
    for (const r of [0, 5, 9, 10, 11, 19, 20, 1_000_001]) {
      const v = foodTotals([{ id: 'a', today: day(r) }])[`f${FOOD_FORMULA}:a::opus`]
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('does not credit a jump when the formula changes mid-day', () => {
    // The old formula's counter, then the first sample under the new one: the
    // new key is a baseline, not 47M tokens of work.
    const before = { 'claude::opus': 6_403_000 }
    const first = sampleAccounts(before, foodTotals([{ id: 'claude', today: day(478_000_000) }]))
    expect(first.delta).toBe(0)
    const next = sampleAccounts(first.seen, foodTotals([{ id: 'claude', today: day(478_100_000) }]))
    expect(next.delta).toBe(10_000)
  })
})

describe('earn', () => {
  it('counts XP from food tokens and notes when', () => {
    const s = earn(base(), 10 * XP_TOKENS, T0)
    expect(s.xp).toBe(10)
    expect(s.lastFedAt).toBe(T0)
    expect(s.totalTokens).toBe(10 * XP_TOKENS)
  })

  it('records tokens too few for an XP without a gain', () => {
    const s = earn(base(), 400, T0)
    expect(s.xp).toBe(0)
    expect(s.carryTokens).toBe(400)
    expect(s.lastFedAt).toBe(0)
    expect(s.totalTokens).toBe(400)
  })

  it('is a no-op for zero tokens', () => {
    const s = base()
    expect(earn(s, 0, T0)).toBe(s)
  })

  it('levels up as XP comes in, and reports the way to the next level', () => {
    const s = earn(base(), xpForLevel(5) * XP_TOKENS, T0)
    expect(progressOf(s.xp)).toEqual({ level: 5, progress: 0, toNext: xpForLevel(6) - xpForLevel(5) })
    expect(progressOf(0).level).toBe(1)
  })

  it('has no needs: nothing about it runs down with time', () => {
    const s = earn(base(), 50 * XP_TOKENS, T0)
    // The same save, any time later, is the same pet.
    expect(normalize(s, T0 + 1000 * HOUR)).toEqual(s)
    for (const k of ['fullness', 'mood', 'poops', 'sick', 'illHours', 'neglectMs', 'evolutions', 'lastTickAt'])
      expect(k in s).toBe(false)
  })
})

describe('tokenDelta', () => {
  it('returns the increase between samples', () => {
    expect(tokenDelta(1000, 1500)).toBe(500)
  })
  it('treats a drop as a fresh daily total, not a refund', () => {
    expect(tokenDelta(900_000, 300)).toBe(300)
  })
  it('ignores garbage', () => {
    expect(tokenDelta(10, Number.NaN)).toBe(0)
    expect(tokenDelta(Number.NaN, 50)).toBe(50)
  })
})

describe('break time', () => {
  const MIN = 60_000
  // Gaining every few minutes from `from` for `ms`: what an afternoon of agents looks like.
  const workFor = (s: PetSave, from: number, ms: number): PetSave => {
    for (let at = from; at <= from + ms; at += 5 * MIN) s = earn(s, XP_TOKENS, at)
    return s
  }

  it('counts a streak from the first gain, and restarts it after a long enough gap', () => {
    const s = workFor(base(), atHour(10), 65 * MIN)
    expect(workStreakMs(s, atHour(10) + 65 * MIN)).toBe(65 * MIN)
    expect(wantsBreak(s, atHour(10) + 65 * MIN)).toBe(true)
    expect(workStreakMs(s, atHour(10) + 65 * MIN + WORK_IDLE_RESET_MS)).toBe(0)
    const back = earn(s, XP_TOKENS, atHour(12))
    expect(workStreakMs(back, atHour(12) + MIN)).toBe(MIN)
  })

  it('does not ask before the threshold; late at night it asks like any time', () => {
    const s = workFor(base(), atHour(10), BREAK_NAG_MS - 10 * MIN)
    expect(wantsBreak(s, atHour(10) + BREAK_NAG_MS - 10 * MIN)).toBe(false)
    const late = workFor(base(), atHour(1), 65 * MIN)
    expect(wantsBreak(late, atHour(1) + 65 * MIN)).toBe(true)
  })

  it('asks on the interval the user picked, or never when it is off', () => {
    const s = workFor(base(), atHour(10), 35 * MIN)
    const now = atHour(10) + 35 * MIN
    expect(wantsBreak(s, now)).toBe(false)
    expect(wantsBreak(s, now, 30 * MIN)).toBe(true)
    expect(wantsBreak(s, now, 0)).toBe(false)
    expect(rest(base(), 30 * MIN, BREAK_MS, T0, 30 * MIN).wins).toBe(1)
    expect(rest(base(), 30 * MIN, BREAK_MS, T0, 0).wins).toBe(0)
  })

  it('records full breaks and the ones the pet asked for, and ends the streak', () => {
    const s = base({ workFrom: T0 - HOUR, lastFedAt: T0 - MIN })
    const r = rest(s, BREAK_NAG_MS, BREAK_MS, T0)
    expect(r).toMatchObject({ plays: 1, wins: 1, workFrom: 0 })
    expect(rest(s, MIN, BREAK_MS, T0)).toMatchObject({ plays: 1, wins: 0 })
    const short = rest(s, 0, BREAK_MS / 2, T0)
    expect(short.plays).toBe(0)
    expect(short.workFrom).toBe(0)
    expect(rest(s, BREAK_NAG_MS, BREAK_MIN_MS - 1, T0)).toBe(s)
  })
})

describe('XP log', () => {
  it('tallies XP under the day it was gained', () => {
    const a = earn(base(), 4 * XP_TOKENS, T0)
    const b = earn(a, 6 * XP_TOKENS, T0 + HOUR)
    expect(b.history).toEqual([{ day: dayKey(T0), xp: 10 }])
    const nextDay = earn(b, 2 * XP_TOKENS, T0 + 30 * HOUR)
    expect(nextDay.history).toHaveLength(2)
    expect(nextDay.history[1]).toEqual({ day: dayKey(T0 + 30 * HOUR), xp: 2 })
  })

  it('keeps at most a fortnight', () => {
    let s = base()
    for (let d = 0; d < 20; d++) s = earn(s, XP_TOKENS, T0 + d * 24 * HOUR)
    expect(s.history).toHaveLength(14)
    expect(s.history[13].day).toBe(dayKey(T0 + 19 * 24 * HOUR))
  })

  it('counts consecutive days only', () => {
    const day = (n: number): string => dayKey(T0 + n * 24 * HOUR)
    expect(dayStreak([])).toBe(0)
    expect(dayStreak([0, 1, 2, 4, 5].map((n) => ({ day: day(n), xp: 1 })))).toBe(3)
    expect(dayStreak(Array.from({ length: 7 }, (_, i) => ({ day: day(i), xp: 5 })))).toBe(7)
  })
})

describe('album', () => {
  it('keeps a page for a pet that earned something, with its level', () => {
    const s = base({ xp: xpForLevel(12) + 5, name: '첫째', bornAt: T0 - 300 * HOUR, totalTokens: 18_000_000 })
    const [entry] = archive(s, T0)
    expect(entry).toMatchObject({ name: '첫째', level: 12, xp: xpForLevel(12) + 5, tokens: 18_000_000, ageMs: 300 * HOUR })
  })

  it('does not keep a page for a pet that never earned anything', () => {
    expect(archive(base({ xp: 0 }), T0)).toEqual([])
  })

  it('remembers the last eight only', () => {
    let album: ReturnType<typeof archive> = []
    for (let i = 0; i < 12; i++) album = archive(base({ xp: 100, name: `p${i}`, album }), T0)
    expect(album).toHaveLength(8)
    expect(album[7].name).toBe('p11')
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

  it('splits today by model, cache reads at a tenth', () => {
    const today = {
      totalCost: 0,
      totalTokens: 0,
      perModel: [
        { model: 'claude-opus-5', input: 10, output: 90, cacheWrite: 100, cacheRead: 9_000_000, cost: 0 },
        { model: 'claude-haiku-4-5', input: 0, output: 50, cacheWrite: 0, cacheRead: 5000, cost: 0 }
      ]
    }
    expect(foodByFlavor(today)).toEqual({ opus: 900_200, haiku: 550 })
  })

  it('records which model paid for each gain', () => {
    let s = earn(base(), 60 * XP_TOKENS, T0, 'opus')
    s = earn(s, 20 * XP_TOKENS, T0, 'haiku')
    expect(s.diet.opus).toBe(60)
    expect(s.diet.haiku).toBe(20)
    const d = dietOf(s)
    expect(d.top).toBe('opus')
    expect(d.share).toBeCloseTo(0.75)
    expect(d.total).toBe(80)
    expect(dietOf(base()).total).toBe(0)
  })
})

describe('awards', () => {
  const ids = (s: PetSave): string[] => awardsOf(s).filter((a) => a.done).map((a) => a.id)

  it('starts with nothing to show for itself', () => {
    expect(ids(base())).toEqual([])
  })

  it('lights up as the pet earns them', () => {
    const s = base({
      xp: xpForLevel(20),
      totalTokens: 12_000_000,
      plays: 12,
      wins: 6,
      album: [1, 2, 3].map(() => page()),
      history: Array.from({ length: 7 }, (_, i) => ({ day: dayKey(T0 + i * 24 * HOUR), xp: 3 }))
    })
    expect(ids(s).sort()).toEqual(
      ['level5', 'crowned', 'level20', 'keeper', 'lucky', 'million', 'playful', 'streak', 'tenMillion'].sort()
    )
  })

  it('has nothing about care or growing up any more', () => {
    const all = awardsOf(base()).map((a) => a.id)
    for (const gone of ['hatch', 'grown', 'tidy', 'devoted']) expect(all).not.toContain(gone)
  })

  it('gives every keepsake an award that can still be earned', () => {
    const all = new Set(awardsOf(base()).map((a) => a.id))
    for (const p of PRIZES) expect(all.has(p.award), p.id).toBe(true)
    // A level 99 pet with everything else done wins every prize but the seasonal ones.
    const maxed = base({
      xp: xpForLevel(99),
      totalTokens: 200_000_000,
      plays: 10,
      wins: 5,
      battles: 30,
      battleWins: 30,
      upsets: 1,
      album: [page({ species: 'fox' }), page({ species: 'owl' }), page()],
      diet: { opus: 1, sonnet: 1, haiku: 1, codex: 0, other: 0 },
      history: Array.from({ length: 7 }, (_, i) => ({ day: dayKey(T0 + i * 24 * HOUR), xp: 3 })),
      events: ['spring', 'halloween', 'christmas']
    })
    expect(prizesOf(maxed)).toHaveLength(PRIZES.length)
  })

  it('hands out a seasonal prize to any pet that is around', () => {
    const halloween = new Date(2026, 9, 31, 12).getTime()
    expect(claimEvents(base(), halloween).events).toEqual(['halloween'])
  })
})

describe('sampleAccounts', () => {
  it('only baselines an account the first time it is seen', () => {
    const r = sampleAccounts({}, { work: 120_000 })
    expect(r.delta).toBe(0)
    expect(r.seen).toEqual({ work: 120_000 })
  })

  it('credits every known account', () => {
    const r = sampleAccounts({ work: 1000, home: 500 }, { work: 4000, home: 700 })
    expect(r.delta).toBe(3200)
    // Per key too, so each model's tokens can be credited as their own flavour.
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
    const s = normalize({ version: PET_VERSION, xp: -3, carryTokens: 9e9, plays: Number.NaN }, T0)
    expect(s.xp).toBe(0)
    expect(s.plays).toBe(0)
    expect(s.carryTokens).toBe(XP_TOKENS - 1)
  })

  it('never keeps a pet born in the future', () => {
    expect(normalize({ bornAt: T0 + 10 * HOUR }, T0).bornAt).toBe(T0)
  })

  it('keeps a good save intact', () => {
    const saved = base({ xp: 120, name: '리븐이', worn: ['crown'], events: ['spring'] })
    expect(normalize(saved, T0 + HOUR)).toEqual(saved)
  })
})

describe('how it ships', () => {
  // The pet lives on the desk, not in the dock: a first-run riven shows the
  // floating device straight away. It is also NOT always-on-top, so main/pet.ts
  // has to open it BESIDE riven's window: inside those bounds it would be
  // covered the moment riven took focus, i.e. open but invisible.
  it('is out on the desk by default, and not in the way', () => {
    expect(DEFAULT_SETTINGS.petShow).toBe(true)
    expect(DEFAULT_SETTINGS.petDetached).toBe(true)
    // Floating above everything is offered, not assumed.
    expect(DEFAULT_SETTINGS.petOnTop).toBe(false)
  })

  // The handheld look is gone. An older build still writes petChrome ('device',
  // 'full', 'screen') to the synced row and to settings.json: it is dropped, and
  // the rest of the settings still load.
  it('drops the old pet look setting and keeps the rest', () => {
    expect('petChrome' in DEFAULT_SETTINGS).toBe(false)
    for (const old of ['device', 'bare', 'full', 'screen']) {
      const got = migrateLegacy({ ...DEFAULT_SETTINGS, petShow: false, petChrome: old } as unknown as Settings)
      expect('petChrome' in got).toBe(false)
      expect(got.petShow).toBe(false)
    }
    expect(migrateLegacy(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS)
  })
})

describe('feedFrame', () => {
  const DAY = 24 * 3600_000
  const key = (ms: number): string => {
    const d = new Date(ms)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  it('draws seven calendar days even when only one has XP', () => {
    const f = feedFrame([{ day: key(T0), xp: 152 }], T0)
    expect(f).toHaveLength(7)
    expect(f.map((d) => d.xp)).toEqual([0, 0, 0, 0, 0, 0, 152])
    expect(f[6].today).toBe(true)
    expect(f.filter((d) => d.today)).toHaveLength(1)
  })

  it('keeps the gaps between days that are far apart', () => {
    // Worked today and six days ago: the two must NOT end up side by side, which is
    // what plotting the history array directly used to do.
    const f = feedFrame(
      [
        { day: key(T0 - 6 * DAY), xp: 20 },
        { day: key(T0), xp: 40 }
      ],
      T0
    )
    expect(f[0].xp).toBe(20)
    expect(f[6].xp).toBe(40)
    expect(f.slice(1, 6).every((d) => d.xp === 0)).toBe(true)
  })

  it('leaves out days older than the frame', () => {
    const f = feedFrame([{ day: key(T0 - 30 * DAY), xp: 999 }], T0)
    expect(f.every((d) => d.xp === 0)).toBe(true)
  })

  it('is oldest first, and ends on today', () => {
    const f = feedFrame([], T0)
    expect(f[0].day < f[6].day).toBe(true)
    expect(f[6].day).toBe(key(T0))
  })

  it('draws an empty week as an empty week, not as nothing', () => {
    expect(feedFrame([], T0, 3)).toEqual([
      { day: key(T0 - 2 * DAY), xp: 0, today: false },
      { day: key(T0 - DAY), xp: 0, today: false },
      { day: key(T0), xp: 0, today: true }
    ])
  })
})

describe('species', () => {
  it('draws evenly across the animals', () => {
    const n = SPECIES.length * 50
    const drawn = Array.from({ length: n }, (_, i) => drawSpecies(i / n))
    for (const sp of SPECIES) expect(drawn.filter((d) => d === sp)).toHaveLength(n / SPECIES.length)
  })

  it('never falls off either end of the table', () => {
    expect(drawSpecies(0)).toBe(SPECIES[0])
    expect(drawSpecies(1)).toBe(SPECIES[SPECIES.length - 1])
    expect(SPECIES).toContain(drawSpecies(-5))
    expect(SPECIES).toContain(drawSpecies(99))
  })

  it('gives a new pet one of them, and keeps the one a save has', () => {
    expect(SPECIES).toContain(initialState(T0).species)
    expect(normalize({ ...base(), species: 'turtle' }, T0 + HOUR).species).toBe('turtle')
  })

  it('gives a pet from before species existed a stable one', () => {
    const old = { ...base(), species: undefined }
    const first = normalize(old, T0 + HOUR)
    expect(normalize(old, T0 + 5 * HOUR).species).toBe(first.species)
    expect(first.species).toBe(speciesFromBirth(first.bornAt))
  })

  it('refuses one that is not an animal', () => {
    const s = normalize({ ...base(), species: 'unicorn' }, T0)
    expect(SPECIES).toContain(s.species)
  })

  it('spreads birthdays across every animal', () => {
    const seen = new Set(Array.from({ length: 400 }, (_, i) => speciesFromBirth(T0 + i * 60_000)))
    expect(seen.size).toBe(SPECIES.length)
  })

  it('counts the animals a keeper has met, current pet included', () => {
    expect(strainsSeen(base({ species: 'cat', album: [] }))).toBe(1)
    expect(strainsSeen(base({ species: 'cat', album: [page(), page()] }))).toBe(1)
    expect(strainsSeen(base({ species: 'cat', album: [page({ species: 'rabbit' }), page({ species: 'turtle' })] }))).toBe(3)
  })
})

describe('the nest', () => {
  const now = Date.UTC(2026, 9, 1, 12)
  const grown = (): PetSave => ({ ...initialState(now), xp: 500 })

  it('reads a save from before the nest as a nest of one', () => {
    const n = normalizeNest({ ...grown(), name: 'mochi' }, now)
    expect(n.version).toBe(NEST_VERSION)
    expect(n.pets).toHaveLength(1)
    expect(n.active).toBe(0)
    expect(n.pets[0]).toMatchObject({ name: 'mochi', xp: 500 })
  })

  it('reads a nest back, capped and with the shown pet in range', () => {
    const pets = Array.from({ length: MAX_PETS + 2 }, (_, i) => ({ ...grown(), name: `p${i}` }))
    const n = normalizeNest({ version: NEST_VERSION, active: 99, pets }, now)
    expect(n.pets).toHaveLength(MAX_PETS)
    expect(n.active).toBe(MAX_PETS - 1)
    expect(normalizeNest({ version: NEST_VERSION, active: 0, pets: [] }, now).pets).toHaveLength(1)
    expect(normalizeNest(null, now).pets).toHaveLength(1)
  })

  it('switches the pet that is out and leaves the others as they are', () => {
    const first = normalizeNest(grown(), now)
    let n = adopt(first, now)
    expect(n.active).toBe(1)
    expect(n.pets[0]).toBe(first.pets[0])
    n = show(n, 0)
    expect(n.active).toBe(0)
    expect(n.pets[0]).toBe(first.pets[0])
    expect(show(n, 0)).toBe(n)
    expect(show(n, 9)).toBe(n)
  })

  it('takes in new pets at level 1 until it is full, showing the newest', () => {
    let n = normalizeNest(grown(), now)
    for (let i = 1; i < MAX_PETS; i++) {
      n = adopt(n, now)
      expect(n.pets).toHaveLength(i + 1)
      expect(n.active).toBe(i)
      expect(progressOf(n.pets[i].xp).level).toBe(1)
    }
    expect(adopt(n, now)).toBe(n)
  })

  it('lets a pet go into the album, never the last one', () => {
    let n = adopt(normalizeNest(grown(), now), now)
    n = { ...n, active: 0 }
    const after = release(n, now)
    expect(after.pets).toHaveLength(1)
    expect(after.active).toBe(0)
    expect(after.pets[0].album).toHaveLength(1)
    expect(release(after, now)).toBe(after)
  })

  it('keeps one album for every pet in it', () => {
    let n = adopt(adopt(normalizeNest(grown(), now), now), now)
    n = restart({ ...n, active: 0 }, now)
    expect(n.pets[0].xp).toBe(0)
    for (const p of n.pets) expect(p.album).toHaveLength(1)
    const odd = { version: NEST_VERSION, active: 0, pets: [n.pets[0], { ...n.pets[1], album: [] }] }
    for (const p of normalizeNest(odd, now).pets) expect(p.album).toHaveLength(1)
  })
})

describe('looking after the nest (applyCommand)', () => {
  const now = T0 + 48 * HOUR
  const grown = (name: string, bornAt: number): PetSave => ({ ...base({ xp: 900, bornAt }), name })
  const three = (): ReturnType<typeof normalizeNest> =>
    normalizeNest({ version: NEST_VERSION, active: 1, pets: [grown('a', 1), grown('b', 2), grown('c', 3)] }, now)
  const ref = (n: ReturnType<typeof normalizeNest>, i: number): { index: number; bornAt: number } => ({
    index: i,
    bornAt: n.pets[i].bornAt
  })

  it('lets a pet that is not shown go, and keeps the shown one out', () => {
    const n = three()
    const r = applyCommand(n, { op: 'release', ...ref(n, 0) }, now)
    expect(r.result).toBe('ok')
    expect(r.nest.pets.map((p) => p.name)).toEqual(['b', 'c'])
    expect(r.nest.active).toBe(0)
    for (const p of r.nest.pets) expect(p.album.map((a) => a.name)).toEqual(['a'])
    expect(applyCommand(n, { op: 'release', ...ref(n, 2) }, now).nest.active).toBe(1)
  })

  it('never lets the last one go', () => {
    const one = normalizeNest(grown('a', 1), now)
    const r = applyCommand(one, { op: 'release', ...ref(one, 0) }, now)
    expect(r.result).toBe('last')
    expect(r.nest).toBe(one)
  })

  it('starts a pet over at level 1, same animal and name, the old one into the album', () => {
    const n = three()
    const before = n.pets[2]
    const r = applyCommand(n, { op: 'restart', ...ref(n, 2) }, now)
    const after = r.nest.pets[2]
    expect(after.xp).toBe(0)
    expect(progressOf(after.xp).level).toBe(1)
    expect(after.species).toBe(before.species)
    expect(after.name).toBe('c')
    expect(after.bornAt).toBe(now)
    expect(after.battles).toBe(0)
    expect(r.nest.active).toBe(1)
    expect(r.nest.pets[0].album.map((a) => [a.name, a.level])).toEqual([['c', progressOf(900).level]])
  })

  it('renames and switches by place and birthday', () => {
    const n = three()
    expect(applyCommand(n, { op: 'rename', ...ref(n, 0), name: '  mochi  ' }, now).nest.pets[0].name).toBe('mochi')
    expect(applyCommand(n, { op: 'rename', ...ref(n, 0), name: 'x'.repeat(40) }, now).nest.pets[0].name).toHaveLength(24)
    expect(applyCommand(n, { op: 'select', ...ref(n, 2) }, now).nest.active).toBe(2)
  })

  it('refuses a command about a pet that has moved', () => {
    const n = three()
    for (const cmd of [
      { op: 'select', index: 0, bornAt: 2 },
      { op: 'release', index: 5, bornAt: 1 },
      { op: 'restart', index: 1, bornAt: 99 },
      { op: 'rename', index: 0, bornAt: 3, name: 'x' }
    ] as const) {
      const r = applyCommand(n, cmd, now)
      expect(r.result).toBe('stale')
      expect(r.nest).toBe(n)
    }
  })

  it('takes a new pet until the nest is full', () => {
    let n = three()
    const r = applyCommand(n, { op: 'adopt', hatch: null }, now)
    expect(r.result).toBe('ok')
    expect(r.nest.active).toBe(3)
    n = r.nest
    expect(applyCommand(n, { op: 'adopt', hatch: null }, now)).toEqual({ nest: n, result: 'full' })
  })

  it('sums a nest up for a list elsewhere', () => {
    const b = briefOf(three())
    expect(b.active).toBe(1)
    expect(b.pets.map((p) => [p.name, p.bornAt, p.level])).toEqual([
      ['a', 1, progressOf(900).level],
      ['b', 2, progressOf(900).level],
      ['c', 3, progressOf(900).level]
    ])
  })
})
