import { create } from 'zustand'
import type { UsageToday } from './usage'

// ---------------------------------------------------------------------------
// 리븐펫: a pet fed by the tokens riven's agents actually spend.
//
// Everything above the store is PURE (no window, no timers, no Date.now) so the
// economy — tokens→food, hunger decay, growth stages — is unit-testable and the
// panel can replay elapsed time in one step after being hidden. The panel never
// runs a timer while it is invisible; it calls decay() with the current clock
// when it comes back, which lands on the same numbers a running timer would.
// ---------------------------------------------------------------------------

// 20k FRESH tokens (see freshTokens) = one kibble. Everything downstream counts
// kibble, not tokens, so the numbers stay human-sized: a heavy agent day of ~6M
// fresh tokens is ~300 kibble, which is a few days of real work to full grown
// rather than the twenty minutes a 1k rate would have made it.
export const KIBBLE_TOKENS = 20_000
// A kibble's worth of fullness: 25 kibble (25k tokens) takes an empty pet to full.
export const FULLNESS_PER_KIBBLE = 4
export const MOOD_PER_KIBBLE = 1.5
// Full → empty in 8 hours of silence.
export const HUNGER_PER_HOUR = 12.5
// Mood drifts up while there is food in the belly, down once it runs out.
export const MOOD_RECOVER_PER_HOUR = 4
export const MOOD_DROP_PER_HOUR = 10
// Petting: a small mood bump, rate-limited so it can't replace feeding.
export const PET_MOOD = 6
export const PET_COOLDOWN_MS = 60_000
// Below this the pet reads as hungry in the UI (it is still eating into food).
export const HUNGRY_AT = 30

// ---- care (the parts that need a hand, not just tokens) ----
// Eating produces what eating produces: one dropping per 30 kibble.
export const KIBBLE_PER_POOP = 30
export const MAX_POOPS = 4
// Each uncleaned dropping costs mood every hour it is left there.
export const MOOD_DROP_PER_POOP_HOUR = 2.5
// Hours of being starved or sitting in a full mess before the pet falls ill.
export const SICK_AFTER_HOURS = 6
// Illness doubles the mood bleed and stops growth from feeling like progress.
export const SICK_MOOD_DROP_PER_HOUR = 8
// Playing: a bigger lift than a pat, and it costs a little appetite.
export const PLAY_WIN_MOOD = 14
export const PLAY_LOSE_MOOD = 4
export const PLAY_FULLNESS_COST = 3
export const PLAY_COOLDOWN_MS = 20_000
// How many days of feeding the device graphs, and how many past pets it keeps.
export const HISTORY_DAYS = 14
/** How many days the feed log draws at a time. */
export const FEED_FRAME_DAYS = 7
export const ALBUM_SIZE = 8

// ---- night ----
// It sleeps through the small hours (local time). Everything slows down then:
// working at 3am should not be punished as neglect, and a pet that starved
// overnight while you were asleep too would just be unfair.
export const NIGHT_START_HOUR = 23
export const NIGHT_END_HOUR = 7
/** How fast the pet's clock runs while it sleeps. */
export const SLEEP_RATE = 0.35

// ---- diet ----
// Which model paid for the meal. The pet is fed by agents, so what it eats is
// literally which model did the work — and it grows a taste for the usual one.
export type Flavor = 'opus' | 'sonnet' | 'haiku' | 'codex' | 'other'
export const FLAVORS: Flavor[] = ['opus', 'sonnet', 'haiku', 'codex', 'other']

// ---- species ----
// The strain a pet is BORN as: drawn when the egg appears and never changes.
// This is the axis that was missing — growth branched only on how a pet was
// raised, so every install hatched the same creature in the same colour and the
// only variety came hours later, at adulthood. A species shows from the egg (its
// shell carries the coat pattern), so the pull is something you see at once.
//
// A strain is a different ANIMAL, not a recolour: it owns the silhouette at every
// stage (see petSprites.ts), because six blobs in six colours are one pet with
// six hats. Care still decides the adult FORM, which is now applied to whichever
// animal you got — six animals × four forms is twenty-four grown-up pets.
export type Species = 'cat' | 'rabbit' | 'bird' | 'fish' | 'turtle' | 'bug'
export const SPECIES: Species[] = ['cat', 'rabbit', 'bird', 'fish', 'turtle', 'bug']

/** An even draw from the six strains. */
export function drawSpecies(rand: number = Math.random()): Species {
  const i = Math.floor(Math.min(0.999999, Math.max(0, rand)) * SPECIES.length)
  return SPECIES[i] ?? SPECIES[0]
}

/**
 * The strain a save from before species existed should have. Derived from the
 * pet's own birth instant so it is stable: a live pet must not change what it is
 * every time the app reloads, and re-drawing at random would do exactly that.
 */
export function speciesFromBirth(bornAt: number): Species {
  // A proper 32-bit avalanche, not one multiply: a single imul leaves the low
  // bits of a seconds-resolution clock correlated, and `% 6` of that only ever
  // produced three of the six strains.
  let h = Math.floor(bornAt / 1000) | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = (h ^ (h >>> 16)) >>> 0
  return SPECIES[h % SPECIES.length]
}

export type Stage = 'egg' | 'hatchling' | 'child' | 'teen' | 'adult'
// Non-adult stages all render 'base'; an adult's shape depends on its upbringing.
export type Form = 'base' | 'radiant' | 'sturdy' | 'titan' | 'wraith'
// 'asleep' is never returned by moodOf — sleep is a property of the CLOCK, not
// of the pet's state, so the device decides it (see isNight) and moodOf stays
// free of the current time.
export type Mood = 'happy' | 'ok' | 'hungry' | 'sad' | 'sick' | 'asleep'

export const STAGES: Stage[] = ['egg', 'hatchling', 'child', 'teen', 'adult']
// Kibble eaten (lifetime) needed to enter each stage.
export const STAGE_XP = [0, 10, 60, 250, 800]

// Adult-form thresholds.
export const WRAITH_NEGLECT_RATIO = 0.4
export const RADIANT_NEGLECT_RATIO = 0.08
// A gorged pet: sustained ~200k fresh tokens an hour over its whole life, which
// is heavier than a heavy day's average.
export const TITAN_KIBBLE_PER_HOUR = 10

export interface PetSave {
  version: 1
  bornAt: number
  /** The strain it hatched as. Drawn once, at birth. */
  species: Species
  // When decay() was last applied. Time between this and "now" is what the next
  // decay() charges for, so a closed app still gets hungry.
  lastTickAt: number
  // Tokens seen but not yet worth a whole kibble; carried into the next feed.
  carryTokens: number
  // Lifetime kibble eaten — the growth clock.
  xp: number
  // Lifetime tokens eaten, for display.
  totalTokens: number
  fullness: number
  mood: number
  // Time spent at zero fullness. Drives which adult it grows into.
  neglectMs: number
  feedCount: number
  lastFedAt: number
  lastPetAt: number
  name: string
  // ---- care ----
  // Droppings on the floor, waiting to be cleaned up.
  poops: number
  // Kibble eaten since the last dropping appeared.
  poopCarry: number
  // Hours of accumulated neglect/filth. Past SICK_AFTER_HOURS the pet is ill;
  // cleaning, feeding and medicine bring it back down.
  illHours: number
  sick: boolean
  // ---- play ----
  plays: number
  wins: number
  lastPlayAt: number
  // Kibble eaten per model — what it has grown up on.
  diet: Record<Flavor, number>
  // Every stage it has reached, in order. A pet's whole life story is four or
  // five entries long.
  evolutions: Evolution[]
  // Has it EVER been ill? An award turns on being able to say "never".
  everSick: boolean
  // ---- keepsakes ----
  // Kibble eaten per day, oldest first, at most HISTORY_DAYS entries.
  history: DayFeed[]
  // Pets raised before this one — kept when you start over, so the record of how
  // each one turned out survives the reset that ended it.
  album: AlbumEntry[]
}

export interface Evolution {
  stage: Stage
  form: Form
  at: number
}

export interface DayFeed {
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  kibble: number
}

export interface AlbumEntry {
  name: string
  species: Species
  stage: Stage
  form: Form
  xp: number
  tokens: number
  ageMs: number
  neglectMs: number
  endedAt: number
}

const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n))
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export function initialState(now: number): PetSave {
  return {
    version: 1,
    bornAt: now,
    species: drawSpecies(),
    lastTickAt: now,
    carryTokens: 0,
    xp: 0,
    totalTokens: 0,
    // An egg starts content — it hasn't been neglected yet.
    fullness: 60,
    mood: 70,
    neglectMs: 0,
    feedCount: 0,
    lastFedAt: 0,
    lastPetAt: 0,
    name: '',
    poops: 0,
    poopCarry: 0,
    illHours: 0,
    sick: false,
    plays: 0,
    wins: 0,
    lastPlayAt: 0,
    diet: { opus: 0, sonnet: 0, haiku: 0, codex: 0, other: 0 },
    // The story starts with the egg it was born as, so a pet that jumps two
    // stages in one big meal still has a beginning.
    evolutions: [{ stage: 'egg', form: 'base', at: now }],
    everSick: false,
    history: [],
    album: []
  }
}

/** The local calendar day a moment belongs to — the unit the feed graph counts in. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Read a persisted blob defensively: a hand-edited or half-written
// pet.json must never produce NaN bars or a pet born in the future.
export function normalize(raw: unknown, now: number): PetSave {
  const base = initialState(now)
  if (!raw || typeof raw !== 'object') return base
  const o = raw as Record<string, unknown>
  const bornAt = Math.min(now, num(o.bornAt, base.bornAt))
  return {
    version: 1,
    bornAt,
    // Saved pets keep their strain; ones from before species existed get the one
    // their own birthday implies, so nobody's pet changes into something else.
    species: SPECIES.includes(o.species as Species)
      ? (o.species as Species)
      : speciesFromBirth(bornAt),
    lastTickAt: Math.min(now, Math.max(bornAt, num(o.lastTickAt, bornAt))),
    carryTokens: Math.max(0, Math.min(KIBBLE_TOKENS - 1, Math.floor(num(o.carryTokens, 0)))),
    xp: Math.max(0, Math.floor(num(o.xp, 0))),
    totalTokens: Math.max(0, Math.floor(num(o.totalTokens, 0))),
    fullness: clamp(num(o.fullness, base.fullness)),
    mood: clamp(num(o.mood, base.mood)),
    neglectMs: Math.max(0, num(o.neglectMs, 0)),
    feedCount: Math.max(0, Math.floor(num(o.feedCount, 0))),
    lastFedAt: Math.max(0, num(o.lastFedAt, 0)),
    lastPetAt: Math.max(0, num(o.lastPetAt, 0)),
    name: typeof o.name === 'string' ? o.name.slice(0, 24) : '',
    poops: Math.max(0, Math.min(MAX_POOPS, Math.floor(num(o.poops, 0)))),
    poopCarry: Math.max(0, Math.min(KIBBLE_PER_POOP, Math.floor(num(o.poopCarry, 0)))),
    illHours: Math.max(0, num(o.illHours, 0)),
    sick: o.sick === true,
    plays: Math.max(0, Math.floor(num(o.plays, 0))),
    wins: Math.max(0, Math.floor(num(o.wins, 0))),
    lastPlayAt: Math.max(0, num(o.lastPlayAt, 0)),
    diet: FLAVORS.reduce(
      (d, f) => ({ ...d, [f]: Math.max(0, Math.floor(num((o.diet as Record<string, unknown>)?.[f], 0))) }),
      {} as Record<Flavor, number>
    ),
    evolutions: Array.isArray(o.evolutions) ? (o.evolutions as Evolution[]).slice(-8) : [],
    everSick: o.everSick === true,
    history: Array.isArray(o.history)
      ? o.history
          .filter((h): h is DayFeed => !!h && typeof (h as DayFeed).day === 'string')
          .map((h) => ({ day: h.day, kibble: Math.max(0, Math.floor(num(h.kibble, 0))) }))
          .slice(-HISTORY_DAYS)
      : [],
    album: Array.isArray(o.album) ? (o.album.slice(-ALBUM_SIZE) as AlbumEntry[]) : []
  }
}

// Today's tally in the feed history, capped to the last HISTORY_DAYS.
function noteFeed(history: DayFeed[], kibble: number, now: number): DayFeed[] {
  if (kibble <= 0) return history
  const day = dayKey(now)
  const last = history[history.length - 1]
  if (last?.day === day)
    return [...history.slice(0, -1), { day, kibble: last.kibble + kibble }]
  return [...history, { day, kibble }].slice(-HISTORY_DAYS)
}

/** Is the pet asleep at this moment? Local hours, so it matches the user's night. */
export function isNight(ms: number): boolean {
  const h = new Date(ms).getHours()
  return NIGHT_START_HOUR > NIGHT_END_HOUR
    ? h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR
    : h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR
}

/**
 * How much of [from, to) the pet slept through. Walks the interval hour by hour
 * from the local clock, which keeps it honest across DST and any night window
 * (the hours are local, not UTC offsets).
 */
export function nightMsBetween(from: number, to: number): number {
  if (to <= from) return 0
  let night = 0
  let cursor = from
  // Step to the next local hour boundary each time; an interval of any length
  // costs at most one iteration per hour, and decay() is called every 15s.
  while (cursor < to) {
    const d = new Date(cursor)
    d.setMinutes(0, 0, 0)
    const nextHour = d.getTime() + 3_600_000
    const end = Math.min(nextHour, to)
    if (isNight(cursor)) night += end - cursor
    cursor = end
  }
  return night
}

/**
 * The elapsed time the pet actually FEELS: night hours pass at SLEEP_RATE, so
 * eight hours of sleep cost about three of hunger instead of starving it.
 */
export function effectiveMs(from: number, to: number): number {
  const total = Math.max(0, to - from)
  const night = nightMsBetween(from, to)
  return total - night + night * SLEEP_RATE
}

/** Which model paid for a meal. Unknown ids are 'other' rather than guessed. */
export function flavorOf(model: string): Flavor {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('gpt') || m.includes('codex')) return 'codex'
  return 'other'
}

/** Today's fresh tokens split by model, for feeding one flavour at a time. */
export function freshByFlavor(today: UsageToday | null | undefined): Record<string, number> {
  if (!today) return {}
  if (!today.perModel?.length) return { other: Math.max(0, Math.floor(today.totalTokens)) }
  const out: Record<string, number> = {}
  for (const m of today.perModel) {
    const fresh = Math.max(0, m.input) + Math.max(0, m.output) + Math.max(0, m.cacheWrite)
    if (fresh <= 0) continue
    const f = flavorOf(m.model)
    out[f] = (out[f] ?? 0) + fresh
  }
  return out
}

/** What it has grown up on: the dominant flavour and how much of its diet that is. */
export function dietOf(s: PetSave): { top: Flavor; share: number; total: number } {
  const total = FLAVORS.reduce((n, f) => n + (s.diet[f] ?? 0), 0)
  if (total <= 0) return { top: 'other', share: 0, total: 0 }
  const top = FLAVORS.reduce((best, f) => ((s.diet[f] ?? 0) > (s.diet[best] ?? 0) ? f : best), FLAVORS[0])
  return { top, share: (s.diet[top] ?? 0) / total, total }
}

// Tokens → whole kibble, keeping the sub-kibble remainder so a long run of small
// turns still adds up to a meal instead of being rounded away every time.
export function tokensToKibble(
  tokens: number,
  carry: number
): { kibble: number; carry: number } {
  const total = Math.max(0, Math.floor(tokens)) + Math.max(0, Math.floor(carry))
  return { kibble: Math.floor(total / KIBBLE_TOKENS), carry: total % KIBBLE_TOKENS }
}

// Feed `tokens` worth of agent spend. Overfeeding is not wasted: fullness caps at
// 100 but every kibble still counts toward growth (and can tip the pet into its
// titan adult form).
export function feed(
  s: PetSave,
  tokens: number,
  now: number,
  flavor: Flavor = 'other'
): PetSave {
  const t = Math.max(0, Math.floor(tokens))
  if (t <= 0) return s
  const { kibble, carry } = tokensToKibble(t, s.carryTokens)
  // What goes in comes out: a dropping every KIBBLE_PER_POOP, floor at the cap so
  // a huge single feed can't bury the screen.
  const carried = s.poopCarry + kibble
  const droppings = Math.floor(carried / KIBBLE_PER_POOP)
  return {
    ...s,
    carryTokens: carry,
    totalTokens: s.totalTokens + t,
    xp: s.xp + kibble,
    fullness: clamp(s.fullness + kibble * FULLNESS_PER_KIBBLE),
    mood: clamp(s.mood + kibble * MOOD_PER_KIBBLE),
    feedCount: kibble > 0 ? s.feedCount + 1 : s.feedCount,
    lastFedAt: kibble > 0 ? now : s.lastFedAt,
    poops: Math.min(MAX_POOPS, s.poops + droppings),
    poopCarry: carried % KIBBLE_PER_POOP,
    diet: { ...s.diet, [flavor]: (s.diet[flavor] ?? 0) + kibble },
    history: noteFeed(s.history, kibble, now)
  }
}

/**
 * The stage list a pet has passed through. Called after anything that can grow
 * it; returns the same array when nothing changed, so "did it just evolve?" is
 * a reference comparison.
 */
export function noteEvolution(prev: PetSave, next: PetSave, now: number): Evolution[] {
  const before = stageIndexOf(prev.xp)
  const after = stageIndexOf(next.xp)
  if (after <= before && next.evolutions.length > 0) return next.evolutions
  const entry: Evolution = { stage: STAGES[after], form: formOf(next, now), at: now }
  // The egg it was born as counts as the first page of the story.
  if (next.evolutions.length === 0 && after === 0) return [entry]
  if (after <= before) return next.evolutions
  return [...next.evolutions, entry].slice(-8)
}

/** Clean up after it. Nothing else changes — a clean floor is its own reward. */
export function clean(s: PetSave): PetSave {
  if (s.poops === 0) return s
  return { ...s, poops: 0 }
}

/** Medicine. Only does anything to a pet that is actually ill. */
export function cure(s: PetSave): PetSave {
  if (!s.sick) return s
  return { ...s, sick: false, illHours: 0, mood: clamp(s.mood + 5) }
}

/**
 * The guessing game: the pet leans left or right, you call it. Winning is a real
 * mood lift, losing is a small one — playing at all is the point. Costs a little
 * appetite, and is rate-limited so it can't replace feeding.
 */
export function play(
  s: PetSave,
  guess: 'left' | 'right',
  petPick: 'left' | 'right',
  now: number
): { state: PetSave; win: boolean; played: boolean } {
  if (now - s.lastPlayAt < PLAY_COOLDOWN_MS) return { state: s, win: false, played: false }
  // Asleep, too hungry, or too ill to play along.
  if (isNight(now) || s.sick || s.fullness < PLAY_FULLNESS_COST)
    return { state: s, win: false, played: false }
  const win = guess === petPick
  return {
    state: {
      ...s,
      mood: clamp(s.mood + (win ? PLAY_WIN_MOOD : PLAY_LOSE_MOOD)),
      fullness: clamp(s.fullness - PLAY_FULLNESS_COST),
      plays: s.plays + 1,
      wins: s.wins + (win ? 1 : 0),
      lastPlayAt: now
    },
    win,
    played: true
  }
}

// Charge for the time since the last tick. The interval is split into the part
// still covered by food and the part spent empty, so one call can replay hours
// offline and land where a per-second timer would have.
export function decay(s: PetSave, now: number): PetSave {
  const realMs = now - s.lastTickAt
  // Clock went backwards (sleep, NTP step): don't refund hunger, just re-anchor.
  if (realMs <= 0) return s.lastTickAt === now ? s : { ...s, lastTickAt: now }
  // Night passes slowly for a sleeping pet — see effectiveMs.
  const dtMs = effectiveMs(s.lastTickAt, now)
  const hours = dtMs / 3_600_000
  const msToEmpty = (s.fullness / HUNGER_PER_HOUR) * 3_600_000
  const fedMs = Math.min(dtMs, msToEmpty)
  const emptyMs = dtMs - fedMs
  let mood =
    s.mood +
    (MOOD_RECOVER_PER_HOUR * fedMs) / 3_600_000 -
    (MOOD_DROP_PER_HOUR * emptyMs) / 3_600_000
  // Living in a mess is its own misery, illness on top of that.
  mood -= MOOD_DROP_PER_POOP_HOUR * s.poops * hours
  if (s.sick) mood -= SICK_MOOD_DROP_PER_HOUR * hours

  // Illness builds while it is starving or the floor is full, and drains away
  // while it is fed and clean. Medicine (cure) resets it outright.
  const neglected = emptyMs / 3_600_000
  const filthy = s.poops >= MAX_POOPS ? hours : 0
  const cared = hours - Math.max(neglected, filthy)
  const illHours = Math.max(0, s.illHours + Math.max(neglected, filthy) - cared)
  return {
    ...s,
    lastTickAt: now,
    fullness: clamp(s.fullness - (HUNGER_PER_HOUR * dtMs) / 3_600_000),
    mood: clamp(mood),
    neglectMs: s.neglectMs + emptyMs,
    illHours,
    sick: s.sick || illHours >= SICK_AFTER_HOURS,
    everSick: s.everSick || s.sick || illHours >= SICK_AFTER_HOURS
  }
}

// A pat. Returns the same object while on cooldown so callers can skip a save.
export function pet(s: PetSave, now: number): PetSave {
  if (now - s.lastPetAt < PET_COOLDOWN_MS) return s
  return { ...s, mood: clamp(s.mood + PET_MOOD), lastPetAt: now }
}

export function stageIndexOf(xp: number): number {
  let i = 0
  for (let k = 0; k < STAGE_XP.length; k++) if (xp >= STAGE_XP[k]) i = k
  return i
}

export function neglectRatio(s: PetSave, now: number): number {
  const age = Math.max(1, now - s.bornAt)
  return Math.min(1, s.neglectMs / age)
}

// How it grew up, not just how much: a well-fed pet that was never left starving
// turns radiant, a gorged one turns titan, a mostly-ignored one turns wraith.
export function formOf(s: PetSave, now: number): Form {
  if (stageIndexOf(s.xp) < STAGES.length - 1) return 'base'
  const ratio = neglectRatio(s, now)
  if (ratio > WRAITH_NEGLECT_RATIO) return 'wraith'
  const hours = Math.max(1 / 60, (now - s.bornAt) / 3_600_000)
  if (s.xp / hours >= TITAN_KIBBLE_PER_HOUR) return 'titan'
  if (ratio < RADIANT_NEGLECT_RATIO) return 'radiant'
  return 'sturdy'
}

export interface Growth {
  index: number
  stage: Stage
  form: Form
  // 0..1 toward the next stage; 1 at the final stage.
  progress: number
  // Kibble still needed for the next stage, or 0 when fully grown.
  toNext: number
}

export function growthOf(s: PetSave, now: number): Growth {
  const index = stageIndexOf(s.xp)
  const stage = STAGES[index]
  const form = formOf(s, now)
  if (index >= STAGES.length - 1) return { index, stage, form, progress: 1, toNext: 0 }
  const from = STAGE_XP[index]
  const to = STAGE_XP[index + 1]
  return {
    index,
    stage,
    form,
    progress: Math.min(1, Math.max(0, (s.xp - from) / (to - from))),
    toNext: Math.max(0, to - s.xp)
  }
}

export function moodOf(s: PetSave): Mood {
  if (s.sick) return 'sick'
  if (s.fullness <= 0 || s.mood < 25) return 'sad'
  if (s.fullness < HUNGRY_AT) return 'hungry'
  if (s.mood >= 70) return 'happy'
  return 'ok'
}

// The monotone token counter. `usage.today.totalTokens` is a per-day total, so it
// climbs through the day and DROPS at midnight. A drop therefore isn't spend to
// un-feed: it means a new day started, and the new total is itself fresh spend.
export function tokenDelta(prev: number, next: number): number {
  if (!Number.isFinite(next) || next < 0) return 0
  if (!Number.isFinite(prev) || prev < 0) return Math.floor(next)
  return next >= prev ? Math.floor(next - prev) : Math.floor(next)
}

// What counts as food in a day's usage. Cache READS are re-reading a context the
// agent already paid for: on a busy day they are ~98% of the raw token total
// (485M of 486M observed), so feeding on the raw number would drown every other
// signal and max the growth curve within an hour. Food is the fresh tokens — what
// the agent actually wrote, plus what it read for the first time. An account that
// reports no per-model breakdown (Codex) can only offer its plain total.
export function freshTokens(today: UsageToday | null | undefined): number {
  if (!today) return 0
  if (!today.perModel?.length) return Math.max(0, Math.floor(today.totalTokens))
  return today.perModel.reduce(
    (sum, m) => sum + Math.max(0, m.input) + Math.max(0, m.output) + Math.max(0, m.cacheWrite),
    0
  )
}

// Per-ACCOUNT baselines, because the account list grows (a Codex install is
// detected, a profile is added) and summing first would read that as a burst of
// spend. An account seen for the first time only sets its baseline — its earlier
// tokens were spent before the pet was watching.
export function sampleAccounts(
  seen: Record<string, number>,
  totals: Record<string, number>
): { delta: number; deltas: Record<string, number>; seen: Record<string, number> } {
  const next = { ...seen }
  const deltas: Record<string, number> = {}
  let delta = 0
  for (const [id, raw] of Object.entries(totals)) {
    const v = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    if (!(id in seen)) {
      next[id] = v
      continue
    }
    const d = tokenDelta(seen[id], v)
    if (d > 0) deltas[id] = d
    delta += d
    next[id] = v
  }
  return { delta, deltas, seen: next }
}

/** The longest run of consecutive days with a meal in it, up to today. */
export function feedStreak(history: DayFeed[]): number {
  let best = 0
  let run = 0
  let prev: number | null = null
  for (const h of history) {
    const [y, m, d] = h.day.split('-').map(Number)
    const t = new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
    run = prev !== null && Math.round((t - prev) / 86_400_000) === 1 ? run + 1 : 1
    best = Math.max(best, run)
    prev = t
  }
  return best
}

/**
 * The last `days` CALENDAR days, oldest first, whether the pet ate on them or
 * not. The history only records days with a meal in them, so drawing it straight
 * gave a chart that lied: one day of feeding was a single bar filling the whole
 * screen, and a gap of a week rendered as two neighbours.
 */
export function feedFrame(
  history: DayFeed[],
  now: number,
  days = FEED_FRAME_DAYS
): Array<{ day: string; kibble: number; today: boolean }> {
  const by = new Map(history.map((h) => [h.day, h.kibble]))
  const today = dayKey(now)
  const out: Array<{ day: string; kibble: number; today: boolean }> = []
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86_400_000)
    out.push({ day, kibble: by.get(day) ?? 0, today: day === today })
  }
  return out
}

export interface Award {
  id: string
  done: boolean
}

/**
 * What this pet has managed. Derived, never stored: an award can't drift out of
 * step with the pet it describes, and adding one lights up retroactively.
 */
/** How many different strains this keeper has had, the current pet included. */
export function strainsSeen(s: PetSave): number {
  return new Set<Species>([s.species, ...s.album.map((a) => a.species)]).size
}

export function awardsOf(s: PetSave, now: number): Award[] {
  const grown = stageIndexOf(s.xp) >= STAGES.length - 1
  return [
    { id: 'hatch', done: s.xp >= STAGE_XP[1] },
    { id: 'grown', done: grown },
    { id: 'million', done: s.totalTokens >= 1_000_000 },
    { id: 'tenMillion', done: s.totalTokens >= 10_000_000 },
    { id: 'tidy', done: grown && !s.everSick },
    { id: 'devoted', done: grown && neglectRatio(s, now) < RADIANT_NEGLECT_RATIO },
    { id: 'streak', done: feedStreak(s.history) >= 7 },
    { id: 'playful', done: s.plays >= 10 },
    { id: 'lucky', done: s.wins >= 5 },
    { id: 'keeper', done: s.album.length >= 3 },
    // Six strains are drawn at random, so meeting three of them is a record of
    // starting over rather than of raising one pet well.
    { id: 'strains', done: strainsSeen(s) >= 3 }
  ]
}

/**
 * The album a finished pet leaves behind. An egg that never hatched is not worth
 * a page, so only a pet that actually ate something is kept.
 */
export function archive(s: PetSave, now: number): AlbumEntry[] {
  if (s.xp <= 0) return s.album
  const g = growthOf(s, now)
  const entry: AlbumEntry = {
    name: s.name,
    species: s.species,
    stage: g.stage,
    form: g.form,
    xp: s.xp,
    tokens: s.totalTokens,
    ageMs: Math.max(0, now - s.bornAt),
    neglectMs: s.neglectMs,
    endedAt: now
  }
  return [...s.album, entry].slice(-ALBUM_SIZE)
}

// ---------------------------------------------------------------------------
// Store — thin wrapper over the pure functions plus persistence.
// ---------------------------------------------------------------------------

const FILE = 'pet.json'

interface PetStore {
  pet: PetSave
  loaded: boolean
  // Per-account daily totals as of the last sample. Deliberately NOT persisted:
  // after a restart every account is "new" again, so the day's already-counted
  // tokens are re-baselined instead of being fed twice.
  seen: Record<string, number>
  load: () => Promise<void>
  /** Apply elapsed-time hunger/mood decay up to `now`. */
  tick: (now?: number) => void
  /**
   * Record a usage sample and feed the growth. Keys are `<account>::<flavor>`,
   * so each model's tokens are tracked (and fed) separately.
   */
  sample: (totals: Record<string, number>, now?: number) => void
  /** The stage it has just reached, for the device to celebrate. Cleared by ack. */
  justEvolved: Evolution | null
  ackEvolution: () => void
  patHead: (now?: number) => void
  cleanUp: () => void
  giveMedicine: () => void
  /** Play a round; returns null when it declined (cooldown, ill, too hungry). */
  playRound: (guess: 'left' | 'right') => { win: boolean; petPick: 'left' | 'right' } | null
  rename: (name: string) => void
  /** Start over, keeping the finished pet in the album. */
  reset: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(state: PetSave): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void window.api.config.save(FILE, state)
  }, 500)
}
/** Persist immediately (panel unmount / window close). */
export function flushPetSave(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  void window.api.config.save(FILE, usePet.getState().pet)
}

export const usePet = create<PetStore>((set, get) => ({
  pet: initialState(Date.now()),
  loaded: false,
  seen: {},
  justEvolved: null,
  ackEvolution: () => set({ justEvolved: null }),
  load: async () => {
    if (get().loaded) return
    const raw = await window.api.config.load(FILE).catch(() => null)
    const now = Date.now()
    // Charge for the time the app was closed right away, so reopening after two
    // days shows a starving pet instead of the one we left.
    set({ pet: decay(normalize(raw, now), now), loaded: true })
  },
  tick: (now = Date.now()) => {
    const next = decay(get().pet, now)
    if (next === get().pet) return
    set({ pet: next })
    scheduleSave(next)
  },
  sample: (totals, now = Date.now()) => {
    const before = get().pet
    const { deltas, seen } = sampleAccounts(get().seen, totals)
    set({ seen })
    // One feed per flavour, so the diet records which model actually paid.
    let next = before
    for (const [key, delta] of Object.entries(deltas)) {
      if (delta <= 0) continue
      next = feed(next, delta, now, flavorOf(key.split('::')[1] ?? ''))
    }
    if (next === before) return
    const evolutions = noteEvolution(before, next, now)
    if (evolutions !== next.evolutions) {
      next = { ...next, evolutions }
      set({ justEvolved: evolutions[evolutions.length - 1] })
    }
    set({ pet: next })
    scheduleSave(next)
  },
  patHead: (now = Date.now()) => {
    const next = pet(get().pet, now)
    if (next === get().pet) return
    set({ pet: next })
    scheduleSave(next)
  },
  cleanUp: () => {
    const next = clean(get().pet)
    if (next === get().pet) return
    set({ pet: next })
    scheduleSave(next)
  },
  giveMedicine: () => {
    const next = cure(get().pet)
    if (next === get().pet) return
    set({ pet: next })
    scheduleSave(next)
  },
  playRound: (guess) => {
    // The pet's pick is drawn here, not in the pure function, so the game stays
    // testable with a fixed opponent.
    const petPick = Math.random() < 0.5 ? 'left' : 'right'
    const { state, win, played } = play(get().pet, guess, petPick, Date.now())
    if (!played) return null
    set({ pet: state })
    scheduleSave(state)
    return { win, petPick }
  },
  rename: (name) => {
    const next = { ...get().pet, name: name.slice(0, 24) }
    set({ pet: next })
    scheduleSave(next)
  },
  reset: () => {
    const now = Date.now()
    const next = { ...initialState(now), album: archive(get().pet, now) }
    set({ pet: next, seen: {} })
    scheduleSave(next)
  }
}))
