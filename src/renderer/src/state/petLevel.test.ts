import { describe, it, expect } from 'vitest'
import { SPECIES, foodTokens } from './pet'
import {
  DECORATIONS,
  MAX_LEVEL,
  SPECIES_STATS,
  STATS,
  STAT_BASE,
  XP_TOKENS,
  decorationsOf,
  levelCost,
  levelOf,
  nextDecoration,
  statTotal,
  statsOf,
  topStat,
  xpForLevel
} from './petLevel'

describe('the level curve', () => {
  it('starts at level 1 with nothing earned', () => {
    expect(levelOf(0)).toEqual({ level: 1, from: 0, to: 30 })
    expect(levelOf(-5).level).toBe(1)
    expect(levelOf(Number.NaN).level).toBe(1)
  })

  it('makes each level cost a little more than the last', () => {
    expect([1, 2, 3, 10, 50].map(levelCost)).toEqual([30, 40, 50, 120, 520])
    for (let l = 1; l < MAX_LEVEL; l++) {
      expect(xpForLevel(l + 1) - xpForLevel(l)).toBe(levelCost(l))
      expect(levelCost(l + 1)).toBeGreaterThan(levelCost(l))
    }
  })

  it('has the totals the comment in petLevel.ts promises', () => {
    expect([2, 5, 7, 10, 20, 30, 50, 99].map(xpForLevel)).toEqual([30, 180, 330, 630, 2280, 4930, 13230, 50470])
  })

  it('lands exactly on a level at its threshold, and one short is the level below', () => {
    for (const l of [2, 9, 10, 42, 98, 99]) {
      expect(levelOf(xpForLevel(l)).level).toBe(l)
      expect(levelOf(xpForLevel(l) - 1).level).toBe(l - 1)
    }
  })

  it('stops at the top level with nothing left to earn', () => {
    const top = levelOf(xpForLevel(MAX_LEVEL) * 10)
    expect(top.level).toBe(MAX_LEVEL)
    expect(top.to).toBe(top.from)
  })

  it('gives a few levels on a heavy first day, about one a day by level 30, fewer later', () => {
    // The heavy day observed in usage: ~6.4M fresh tokens and ~478M cache reads.
    const day = Math.floor(
      foodTokens({
        totalCost: 0,
        totalTokens: 0,
        perModel: [{ model: 'opus', input: 1_000_000, output: 1_400_000, cacheWrite: 4_000_000, cacheRead: 478_000_000, cost: 0 }]
      }) / XP_TOKENS
    )
    expect(day).toBeGreaterThan(340)
    expect(day).toBeLessThan(380)
    // Day one: from level 1 to about 7.
    expect(levelOf(day).level).toBeGreaterThanOrEqual(6)
    expect(levelOf(day).level).toBeLessThanOrEqual(8)
    // Levels a heavy day is worth, standing at a given level.
    const gained = (at: number): number => levelOf(xpForLevel(at) + day).level - at
    expect(gained(10)).toBe(2)
    expect(gained(30)).toBe(1)
    expect(gained(50)).toBe(0)
    // Level 50 is weeks of work, level 99 months.
    expect(xpForLevel(50) / day).toBeGreaterThan(30)
    expect(xpForLevel(99) / day).toBeGreaterThan(120)
  })
})

describe('stats', () => {
  it('start at the base and add up to the same total for every pet at a level', () => {
    expect(statsOf(1, 'cat')).toEqual({ power: STAT_BASE, smarts: STAT_BASE, speed: STAT_BASE, stamina: STAT_BASE })
    for (const level of [1, 2, 17, 50, 99])
      for (const sp of SPECIES) {
        const s = statsOf(level, sp, { opus: 3, codex: 1 })
        expect(STATS.reduce((n, k) => n + s[k], 0)).toBe(statTotal(level))
        for (const k of STATS) expect(s[k]).toBeGreaterThanOrEqual(STAT_BASE)
      }
  })

  it('rise with the level and never fall as it levels', () => {
    for (const sp of ['dragon', 'owl', 'hamster'] as const) {
      let prev = statsOf(1, sp, { sonnet: 1 })
      for (let l = 2; l <= MAX_LEVEL; l++) {
        const cur = statsOf(l, sp, { sonnet: 1 })
        for (const k of STATS) expect(cur[k]).toBeGreaterThanOrEqual(prev[k])
        prev = cur
      }
    }
  })

  it('lean the way the species does', () => {
    for (const sp of SPECIES) {
      const [strong, weak] = SPECIES_STATS[sp]
      const s = statsOf(40, sp)
      expect(topStat(s)).toBe(strong)
      expect(s[weak]).toBeLessThan(s[strong])
    }
    // Every stat is some animal's strength.
    expect(new Set(Object.values(SPECIES_STATS).map(([s]) => s))).toEqual(new Set(STATS))
  })

  it('lean the way its work does: Opus is clever, Codex quick, Haiku tireless', () => {
    expect(topStat(statsOf(40, 'slime', { opus: 100 }))).toBe('smarts')
    const cat = statsOf(40, 'cat')
    expect(statsOf(40, 'cat', { opus: 100 }).smarts).toBeGreaterThan(cat.smarts)
    expect(statsOf(40, 'cat', { codex: 100 }).speed).toBeGreaterThan(cat.speed)
    expect(statsOf(40, 'cat', { haiku: 100 }).stamina).toBeGreaterThan(cat.stamina)
    expect(statsOf(40, 'cat', { other: 100 }).power).toBeGreaterThan(cat.power)
    // A mixed diet leans by its shares, and an unknown model pulls nowhere.
    const mixed = statsOf(40, 'cat', { opus: 50, codex: 50 })
    expect(mixed.smarts).toBeGreaterThan(cat.smarts)
    expect(mixed.speed).toBeGreaterThan(statsOf(40, 'cat', { opus: 100 }).speed)
    expect(statsOf(40, 'cat', { mystery: 100 })).toEqual(cat)
  })

  it('make two pets of the same level differ', () => {
    expect(statsOf(30, 'owl', { opus: 10 })).not.toEqual(statsOf(30, 'crab', { codex: 10 }))
  })

  it('are a fun spread, not a cliff: the weakest stat keeps up', () => {
    for (const sp of SPECIES) {
      const s = statsOf(50, sp, { opus: 1 })
      const vals = STATS.map((k) => s[k])
      expect(Math.min(...vals) / Math.max(...vals)).toBeGreaterThan(0.3)
    }
  })
})

describe('decorations', () => {
  it('come every ten levels and add up', () => {
    expect(decorationsOf(1)).toEqual([])
    expect(decorationsOf(9)).toEqual([])
    expect(decorationsOf(10)).toEqual(['badge'])
    expect(decorationsOf(25)).toEqual(['badge', 'ribbon'])
    expect(decorationsOf(30)).toEqual(['badge', 'ribbon', 'sparkle'])
    expect(decorationsOf(40)).toEqual(['badge', 'ribbon', 'sparkle', 'halo'])
    expect(decorationsOf(50)).toEqual(['badge', 'ribbon', 'sparkle', 'halo', 'glow'])
    expect(decorationsOf(99)).toEqual(DECORATIONS.map((d) => d.id))
  })

  it('say which one is next', () => {
    expect(nextDecoration(1)).toEqual({ id: 'badge', level: 10 })
    expect(nextDecoration(10)).toEqual({ id: 'ribbon', level: 20 })
    expect(nextDecoration(50)).toBeNull()
  })
})
