import { buildOfDesign, type CustomDesign } from './petSpecies'

// ---------------------------------------------------------------------------
// Levels, stats and the decorations levels bring. Pure, no store, no clock.
//
// A pet earns XP from the tokens riven's agents spend (state/pet.ts feeds it
// through foodOf: input + output + cache writes in full, cache reads at 10%).
// XP_TOKENS food tokens are one XP.
//
// The curve: going from level L to L+1 costs levelCost(L) = 30 + 10 * (L - 1)
// XP, so the total to reach level L is 30 * (L - 1) + 5 * (L - 1) * (L - 2).
//
//   level    2    5    7   10    20    30     50     99
//   total   30  180  330  630  2280  4930  13230  50470   XP
//
// A heavy agent day was observed at ~54M food tokens, ~360 XP. So a new pet
// gets to about level 7 on its first heavy day (six levels), level 10 on the
// second, then roughly one level a heavy day around level 30 (a level costs
// 320) and fewer after that (520 a level at 50). Level 50 is about 37 heavy
// days, the cap at 99 about 140. A light day (~50 XP) still gives level 2
// on day one.
// ---------------------------------------------------------------------------

/** Food tokens (see foodOf in state/pet.ts) per XP point. */
export const XP_TOKENS = 150_000
export const MAX_LEVEL = 99

/** XP from level `lvl` to the next: 30, 40, 50, ... */
export const levelCost = (lvl: number): number => 30 + 10 * (lvl - 1)

/** Total XP a pet needs to stand at `lvl` (level 1 is 0). */
export function xpForLevel(lvl: number): number {
  const n = Math.max(0, Math.min(MAX_LEVEL, Math.floor(lvl)) - 1)
  return 30 * n + 5 * n * (n - 1)
}

/** Where `xp` stands: its level, and the XP that level starts and ends at. */
export function levelOf(xp: number): { level: number; from: number; to: number } {
  const x = Math.max(0, Number.isFinite(xp) ? xp : 0)
  let level = 1
  while (level < MAX_LEVEL && x >= xpForLevel(level + 1)) level++
  const from = xpForLevel(level)
  return { level, from, to: level >= MAX_LEVEL ? from : xpForLevel(level + 1) }
}

// ---- stats ----
// Four numbers for fun and for friend battles; nothing in riven is gated on
// them. They grow with the level, and every pet leans its own way: its species
// tilts one stat up and one down, and what it has been fed (which models did
// the work) tilts it further, so an Opus-fed pet is clever and a Codex-fed one
// quick. The total at a level is the same for every pet (statTotal), so a
// lean is a trade, never a free boost.
//
//   stat = 10 + 2 * (level - 1) * weight,  weights around 1 and summing to 4
//
// A level 1 pet has 10 of each; a level 50 pet ~108 on average (from ~60 in
// its weakest stat to ~176 in its strongest); level 99 ~206 on average.

export type StatId = 'power' | 'smarts' | 'speed' | 'stamina'
export const STATS: StatId[] = ['power', 'smarts', 'speed', 'stamina']
export type Stats = Record<StatId, number>
export const STAT_BASE = 10
export const STAT_PER_LEVEL = 2

/** What every pet's stats add up to at `level`. */
export const statTotal = (level: number): number => STATS.length * (STAT_BASE + STAT_PER_LEVEL * (level - 1))

/** How far a species leans: this much onto one stat, off another. */
export const SPECIES_LEAN = 0.3
/** How far a diet that is all one model leans (a mixed one, by its shares). */
export const DIET_LEAN = 0.4

/** Each built-in species' strong stat and weak stat. */
export const SPECIES_STATS: Record<string, [StatId, StatId]> = {
  cat: ['speed', 'stamina'],
  rabbit: ['speed', 'power'],
  bird: ['speed', 'stamina'],
  fish: ['speed', 'power'],
  hamster: ['speed', 'power'],
  turtle: ['stamina', 'speed'],
  bug: ['stamina', 'smarts'],
  dog: ['stamina', 'smarts'],
  penguin: ['stamina', 'speed'],
  axolotl: ['stamina', 'power'],
  crab: ['power', 'speed'],
  dragon: ['power', 'speed'],
  bear: ['power', 'smarts'],
  frog: ['power', 'smarts'],
  fox: ['smarts', 'stamina'],
  owl: ['smarts', 'power'],
  octopus: ['smarts', 'speed'],
  slime: ['smarts', 'power']
}

/** Which way each model's work pulls a pet. Each sums to zero. */
export const DIET_STATS: Record<string, Partial<Stats>> = {
  opus: { smarts: 1, speed: -0.5, stamina: -0.5 },
  sonnet: { smarts: 0.5, stamina: 0.5, power: -0.5, speed: -0.5 },
  haiku: { stamina: 1, power: -0.5, smarts: -0.5 },
  codex: { speed: 1, smarts: -0.5, stamina: -0.5 },
  other: { power: 1, speed: -0.5, smarts: -0.5 }
}

/** A stat's weight for a pet: 1, give or take its species and its diet. */
export function statWeights(species: string, diet?: Record<string, number> | null, design?: CustomDesign | null): Stats {
  const w: Stats = { power: 1, smarts: 1, speed: 1, stamina: 1 }
  const lean = SPECIES_STATS[species]
  if (lean) {
    w[lean[0]] += SPECIES_LEAN
    w[lean[1]] -= SPECIES_LEAN
  } else if (design) {
    // A species made from a photo leans by its build: a round one is sturdy
    // and slow, a lanky one quick (buildOfDesign, -1..1).
    const t = Math.max(-1, Math.min(1, buildOfDesign(design)))
    w.stamina += SPECIES_LEAN * t
    w.speed -= SPECIES_LEAN * t
  }
  const total = diet ? Object.values(diet).reduce((n, v) => n + (v > 0 ? v : 0), 0) : 0
  if (diet && total > 0)
    for (const [flavor, eaten] of Object.entries(diet)) {
      const pull = DIET_STATS[flavor]
      if (!pull || !(eaten > 0)) continue
      for (const s of STATS) w[s] += DIET_LEAN * (eaten / total) * (pull[s] ?? 0)
    }
  return w
}

/**
 * The stats at `level` for these weights. Rounded so they add up to exactly
 * statTotal(level) (largest remainder), which is what a battle code is
 * checked against.
 */
export function statsAt(level: number, w: Stats): Stats {
  const lvl = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)))
  const sum = STATS.reduce((n, s) => n + w[s], 0) || STATS.length
  const grow = STAT_PER_LEVEL * (lvl - 1) * STATS.length
  const raw = STATS.map((s) => STAT_BASE + (grow * w[s]) / sum)
  const out = raw.map(Math.floor)
  let left = statTotal(lvl) - out.reduce((n, v) => n + v, 0)
  const order = raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i)
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i]++
  return { power: out[0], smarts: out[1], speed: out[2], stamina: out[3] }
}

/** A pet's stats: its level, leaning the way its species and diet pull it. */
export function statsOf(
  level: number,
  species: string,
  diet?: Record<string, number> | null,
  design?: CustomDesign | null
): Stats {
  return statsAt(level, statWeights(species, diet, design))
}

/** The stat it is best at (the first, on a tie). */
export function topStat(s: Stats): StatId {
  return STATS.reduce((best, k) => (s[k] > s[best] ? k : best), STATS[0])
}

// ---- decorations ----
// Every ten levels the pet earns something it shows, drawn by the accessory
// code in petSprites.ts (outfitPixels) next to whatever it wears: a badge at
// 10, a ribbon at 20, sparkles at 30, a halo at 40 and a soft glow from 50 on.
// They add up (a level 40 pet has all four), and nothing is chosen: they are
// what the level looks like.

export type Decoration = 'badge' | 'ribbon' | 'sparkle' | 'halo' | 'glow'
export const DECORATIONS: Array<{ id: Decoration; level: number }> = [
  { id: 'badge', level: 10 },
  { id: 'ribbon', level: 20 },
  { id: 'sparkle', level: 30 },
  { id: 'halo', level: 40 },
  { id: 'glow', level: 50 }
]

/** The decorations a pet at `level` has earned, in the order above. */
export function decorationsOf(level: number): Decoration[] {
  return DECORATIONS.filter((d) => level >= d.level).map((d) => d.id)
}

/** The next decoration and the level it comes at, or null once it has them all. */
export function nextDecoration(level: number): { id: Decoration; level: number } | null {
  return DECORATIONS.find((d) => level < d.level) ?? null
}
