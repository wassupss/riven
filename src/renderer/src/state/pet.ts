import { create } from 'zustand'
import type { ModelUsage, UsageToday } from './usage'
import {
  designOf,
  isCustomId,
  noteDesign,
  sameDesign,
  sanitizeDesign,
  type CustomDesign,
  type CustomSpeciesId
} from './petSpecies'
import { MAX_LEVEL, XP_TOKENS, levelOf } from './petLevel'
import { sanitizeLayout, type DecorLayout } from './petLayout'
import { sanitizeMotionSet, type MotionSet } from '../lib/petMotion'
import { sanitizeAssistant, type AssistantConfig } from '../lib/petAssistant'

// ---------------------------------------------------------------------------
// 리븐펫: a pet that levels up on the tokens riven's agents actually spend.
//
// It is on its way to being an assistant, so there is no keeping it alive:
// it never gets hungry, ill or dirty, it does not sleep and it cannot die.
// Work earns it XP (petLevel.ts has the curve, the stats and what each tenth
// level brings), and it shows them.
//
// Everything above the store is PURE (no window, no timers, no Date.now) so
// it is unit-testable.
// ---------------------------------------------------------------------------

// ---- break time ----
// Not the pet's need, the keeper's: it keeps an eye on how long the agents
// have been at it (tokens being spent is the signal) and suggests a break.
// A gap this long between gains means you already stepped away: the streak restarts.
export const WORK_IDLE_RESET_MS = 15 * 60_000
// How long a streak runs before the pet starts asking (the default; the user picks
// it in settings, 0 = never), and how often it asks again.
export const BREAK_NAG_MS = 60 * 60_000
export const BREAK_NAG_EVERY_MS = 10 * 60_000
// A proper break, and the shortest one that counts as stepping away at all.
export const BREAK_MS = 5 * 60_000
export const BREAK_MIN_MS = 60_000
// How many days of XP the log keeps, how many it draws, and how many past pets it keeps.
export const HISTORY_DAYS = 14
export const FEED_FRAME_DAYS = 7
export const ALBUM_SIZE = 8

// ---- diet ----
// Which model paid for the work. What a pet is "fed" is literally which model
// did it, and that is what tilts its stats (see statWeights in petLevel.ts).
export type Flavor = 'opus' | 'sonnet' | 'haiku' | 'codex' | 'other'
export const FLAVORS: Flavor[] = ['opus', 'sonnet', 'haiku', 'codex', 'other']

// ---- species ----
// The animal a pet is: picked when it arrives and never changes. A built-in
// one is drawn at random; a homemade one (`u-...`, see petSpecies.ts) is made
// from a photo and is drawn, fights and talks like any other.
export type BuiltinSpecies =
  | 'cat'
  | 'rabbit'
  | 'bird'
  | 'fish'
  | 'turtle'
  | 'bug'
  | 'dog'
  | 'hamster'
  | 'penguin'
  | 'frog'
  | 'crab'
  | 'dragon'
  | 'fox'
  | 'owl'
  | 'bear'
  | 'octopus'
  | 'axolotl'
  | 'slime'
export type Species = BuiltinSpecies | CustomSpeciesId
/** The built-in animals: what a new pet is drawn from at random. */
export const SPECIES: BuiltinSpecies[] = [
  'cat',
  'rabbit',
  'bird',
  'fish',
  'turtle',
  'bug',
  'dog',
  'hamster',
  'penguin',
  'frog',
  'crab',
  'dragon',
  'fox',
  'owl',
  'bear',
  'octopus',
  'axolotl',
  'slime'
]

/** True for the built-in animals, false for one made from a photo. */
export const isBuiltinSpecies = (s: unknown): s is BuiltinSpecies => SPECIES.includes(s as BuiltinSpecies)

/** What a new pet will be: a homemade species (null for a random draw). */
export interface Hatch {
  id: CustomSpeciesId
  design: CustomDesign
}

/** An even draw from the animals. */
export function drawSpecies(rand: number = Math.random()): BuiltinSpecies {
  const i = Math.floor(Math.min(0.999999, Math.max(0, rand)) * SPECIES.length)
  return SPECIES[i] ?? SPECIES[0]
}

/**
 * The animal a save from before species existed should have. Derived from the
 * pet's own birth instant so it is stable across reloads.
 */
export function speciesFromBirth(bornAt: number): BuiltinSpecies {
  // A proper 32-bit avalanche, not one multiply: a single imul leaves the low
  // bits of a seconds-resolution clock correlated.
  let h = Math.floor(bornAt / 1000) | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = (h ^ (h >>> 16)) >>> 0
  return SPECIES[h % SPECIES.length]
}

/**
 * The face it wears. Nothing it lives through changes it any more: it is
 * content, happy for a moment when patted or when it levels up, and the loser
 * of a friend battle sulks until the fight is closed.
 */
export type Mood = 'happy' | 'ok' | 'sad'

/**
 * The save format of one pet. 1 was the tamagotchi (stages, hunger, care), 2
 * the levelling pet; 3 adds `layout` (where the keeper put its decorations);
 * 4 adds `motion` (how this pet moves, over its species'). A version 2 pet
 * reads as it was, with the automatic placement; a version 3 one moves as
 * its species does.
 */
export const PET_VERSION = 4

export interface PetSave {
  version: typeof PET_VERSION
  bornAt: number
  species: Species
  /**
   * For a species made from a photo: its design as of the last time this pet
   * saw it. The species can be edited or deleted later; a pet of one that was
   * deleted goes on looking like itself from this.
   */
  custom?: CustomDesign
  /** Food tokens seen but not yet worth a whole XP; carried into the next gain. */
  carryTokens: number
  /** Lifetime XP: what the level is read from (levelOf). */
  xp: number
  /** Lifetime food tokens, for display. */
  totalTokens: number
  /** When it last gained XP (0 = never). */
  lastFedAt: number
  name: string
  // ---- breaks ----
  // When the current work streak began (0 = none running). `plays` counts full
  // breaks and `wins` the ones taken when the pet asked; the names are from the
  // game this replaced, kept so old saves carry their counts over.
  workFrom: number
  plays: number
  wins: number
  lastPlayAt: number
  // ---- friend battles (see petBattle.ts) ----
  battles: number
  battleWins: number
  /** Which friends' pets it has fought today, as `<their bornAt>@<day>`. */
  fought: string[]
  /** Wins over a friend's pet ten or more levels above it. */
  upsets: number
  // ---- rewards ----
  /** Seasonal events it was around for (see EVENTS); each one leaves a prize. */
  events: string[]
  /** Prizes it has chosen to wear, at most one per slot. */
  worn: Accessory[]
  /**
   * Where the keeper moved its decorations (장식 배치), only what differs from
   * the automatic placement; absent when nothing does. See state/petLayout.ts.
   */
  layout?: DecorLayout
  /**
   * How this pet moves where it differs from its species (the pet's
   * "움직임"): motion specs per situation, never frames. Absent when none.
   * Not in a battle code (cardOf reads the design and the numbers only).
   */
  motion?: MotionSet
  /**
   * 펫 비서: this pet as a real Claude assistant (lib/petAssistant.ts). Absent
   * when it never was one; `on: false` keeps the settings while it is off.
   */
  assistant?: AssistantConfig
  /** XP gained per model: what tilts its stats. */
  diet: Record<Flavor, number>
  /** XP gained per day, oldest first, at most HISTORY_DAYS entries. */
  history: DayXp[]
  /** Pets the keeper had before, shared by every pet in the nest. */
  album: AlbumEntry[]
}

export interface DayXp {
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  xp: number
}

export interface AlbumEntry {
  name: string
  species: Species
  /** A species made from a photo has no translation: its name, as it was. */
  speciesName?: string
  level: number
  xp: number
  tokens: number
  ageMs: number
  endedAt: number
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const count = (v: unknown): number => Math.max(0, Math.floor(num(v, 0)))

export function initialState(now: number, hatch?: Hatch | null): PetSave {
  return {
    version: PET_VERSION,
    bornAt: now,
    species: hatch ? hatch.id : drawSpecies(),
    ...(hatch ? { custom: hatch.design } : {}),
    carryTokens: 0,
    xp: 0,
    totalTokens: 0,
    lastFedAt: 0,
    name: '',
    workFrom: 0,
    plays: 0,
    wins: 0,
    lastPlayAt: 0,
    battles: 0,
    battleWins: 0,
    fought: [],
    upsets: 0,
    events: [],
    worn: [],
    diet: { opus: 0, sonnet: 0, haiku: 0, codex: 0, other: 0 },
    history: [],
    album: []
  }
}

/** The local calendar day a moment belongs to, the unit the XP log counts in. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * One album page, read defensively. A version 1 page (stage, form, kibble,
 * branches) keeps its name, animal and numbers; its kibble is its XP, as
 * with a live pet (see normalize), and its level is read off that.
 */
function albumEntryOf(raw: unknown): AlbumEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.species !== 'string' || !(isBuiltinSpecies(o.species) || isCustomId(o.species))) return null
  const xp = count(o.xp)
  return {
    name: typeof o.name === 'string' ? o.name.slice(0, PET_NAME_MAX) : '',
    species: o.species,
    ...(typeof o.speciesName === 'string' && o.speciesName ? { speciesName: o.speciesName.slice(0, 40) } : {}),
    level: levelOf(xp).level,
    xp,
    tokens: count(o.tokens),
    ageMs: count(o.ageMs),
    endedAt: count(o.endedAt)
  }
}

/**
 * Read a saved pet, whichever version it is, defensively: a hand-edited or
 * half-written pet.json must never produce NaN or a pet born in the future.
 *
 * From version 1 (the tamagotchi): its kibble becomes its XP one for one. A
 * kibble was 150k food tokens (20k fresh tokens before cache reads counted,
 * which fed a day about as much), and so is an XP, so a long-raised pet comes
 * in at the level that much work earns now (800 kibble, a v1 adult, is level
 * 11; ~3500, a v1 level 10, is level 25). Stages, forms, branches, hunger,
 * mood, droppings, illness and sleep are dropped. Its name, animal, homemade
 * design, worn prizes, events, battle record, breaks, diet, daily log and
 * the album all stay.
 */
export function normalize(raw: unknown, now: number): PetSave {
  const base = initialState(now)
  if (!raw || typeof raw !== 'object') return base
  const o = raw as Record<string, unknown>
  const bornAt = Math.min(now, num(o.bornAt, base.bornAt))
  // A species made from a photo comes with its own snapshot of the design; one
  // without (hand-edited) cannot be drawn, so it falls back like an old save.
  const custom = isCustomId(o.species) ? sanitizeDesign(o.custom) : null
  const layout = sanitizeLayout(o.layout)
  const motion = sanitizeMotionSet(o.motion)
  const assistant = sanitizeAssistant(o.assistant)
  return {
    version: PET_VERSION,
    bornAt,
    species: isBuiltinSpecies(o.species)
      ? o.species
      : custom && isCustomId(o.species)
        ? o.species
        : speciesFromBirth(bornAt),
    ...(custom ? { custom } : {}),
    carryTokens: Math.min(XP_TOKENS - 1, count(o.carryTokens)),
    xp: count(o.xp),
    totalTokens: count(o.totalTokens),
    lastFedAt: Math.min(now, Math.max(0, num(o.lastFedAt, 0))),
    name: typeof o.name === 'string' ? o.name.slice(0, PET_NAME_MAX) : '',
    workFrom: Math.max(0, num(o.workFrom, 0)),
    plays: count(o.plays),
    wins: count(o.wins),
    lastPlayAt: Math.max(0, num(o.lastPlayAt, 0)),
    battles: count(o.battles),
    battleWins: count(o.battleWins),
    fought: Array.isArray(o.fought)
      ? o.fought.filter((k): k is string => typeof k === 'string').slice(-FOUGHT_KEEP)
      : [],
    upsets: count(o.upsets),
    events: Array.isArray(o.events)
      ? [...new Set(o.events.filter((e): e is string => EVENTS.some((x) => x.id === e)))]
      : [],
    worn: Array.isArray(o.worn) ? wornOf(o.worn) : [],
    ...(layout ? { layout } : {}),
    ...(motion ? { motion } : {}),
    ...(assistant ? { assistant } : {}),
    diet: FLAVORS.reduce(
      (d, f) => ({ ...d, [f]: count((o.diet as Record<string, unknown> | undefined)?.[f]) }),
      {} as Record<Flavor, number>
    ),
    history: Array.isArray(o.history)
      ? o.history
          .filter((h): h is Record<string, unknown> => !!h && typeof (h as DayXp).day === 'string')
          // Version 1 logged kibble, which is XP one for one.
          .map((h) => ({ day: h.day as string, xp: count(h.xp ?? h.kibble) }))
          .slice(-HISTORY_DAYS)
      : [],
    album: Array.isArray(o.album)
      ? o.album
          .map(albumEntryOf)
          .filter((a): a is AlbumEntry => !!a)
          .slice(-ALBUM_SIZE)
      : []
  }
}

/**
 * Bring each pet's snapshot of a custom species up to date with the keeper's
 * own list. A species that is no longer on it is left as the pet last saw it.
 * Returns the same array when nothing changed.
 */
export function refreshCustom(pets: PetSave[], own: Array<{ id: string } & CustomDesign>): PetSave[] {
  let changed = false
  const next = pets.map((p) => {
    if (!isCustomId(p.species)) return p
    const cur = own.find((o) => o.id === p.species)
    if (!cur || (p.custom && sameDesign(p.custom, cur))) return p
    changed = true
    return { ...p, custom: designOf(cur) }
  })
  return changed ? next : pets
}

/** Make every pet's snapshot drawable, for species the keeper's list does not have. */
export function noteSnapshots(pets: PetSave[]): void {
  for (const p of pets) if (p.custom && isCustomId(p.species)) noteDesign(p.species, p.custom)
}

// Today's tally in the XP log, capped to the last HISTORY_DAYS.
function noteDay(history: DayXp[], xp: number, now: number): DayXp[] {
  if (xp <= 0) return history
  const day = dayKey(now)
  const last = history[history.length - 1]
  if (last?.day === day) return [...history.slice(0, -1), { day, xp: last.xp + xp }]
  return [...history, { day, xp }].slice(-HISTORY_DAYS)
}

/** Which model paid for the work. Unknown ids are 'other' rather than guessed. */
export function flavorOf(model: string): Flavor {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('gpt') || m.includes('codex')) return 'codex'
  return 'other'
}

/**
 * What a cache READ is worth, against a fresh token. It is the price ratio: a
 * cache read is billed at a tenth of the model's input price. Ignoring reads
 * starved lean CLI work, which is nearly all cache reads, and rewarded
 * re-caching; counting them in full would drown everything else (they are
 * ~98% of a busy day's raw total).
 */
export const CACHE_READ_WEIGHT = 0.1
/**
 * Which formula the sample keys belong to (see foodTotals). Bumped when the
 * formula changes, so the first sample under a new one only sets a baseline
 * instead of crediting the difference between two formulas as a burst of spend.
 */
export const FOOD_FORMULA = 2

/** One model's day in food tokens: fresh tokens in full, cache reads at CACHE_READ_WEIGHT. */
export function foodOf(m: Pick<ModelUsage, 'input' | 'output' | 'cacheWrite' | 'cacheRead'>): number {
  const n = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)
  return n(m.input) + n(m.output) + n(m.cacheWrite) + n(m.cacheRead) * CACHE_READ_WEIGHT
}

/**
 * A day with no per-model breakdown (Codex): its plain total, with the part of it
 * that was cache reads (`cacheRead`, when the source says) weighed the same way.
 */
function plainFood(today: UsageToday): number {
  const total = Number.isFinite(today.totalTokens) && today.totalTokens > 0 ? today.totalTokens : 0
  const cached = Math.min(total, Math.max(0, today.cacheRead ?? 0))
  return Math.floor(total - cached + cached * CACHE_READ_WEIGHT)
}

/** Today's food tokens split by model, for crediting one flavour at a time. */
export function foodByFlavor(today: UsageToday | null | undefined): Record<string, number> {
  if (!today) return {}
  if (!today.perModel?.length) {
    const food = plainFood(today)
    return food > 0 ? { other: food } : {}
  }
  const out: Record<string, number> = {}
  for (const m of today.perModel) {
    const food = foodOf(m)
    if (food <= 0) continue
    const f = flavorOf(m.model)
    out[f] = (out[f] ?? 0) + food
  }
  for (const f of Object.keys(out)) out[f] = Math.floor(out[f])
  return out
}

/**
 * The counters one usage poll credits the pet with: one per account AND model
 * (so its diet records which model paid), keyed `f<formula>:<account>::<flavor>`.
 */
export function foodTotals(accounts: Array<{ id: string; today: UsageToday | null | undefined }>): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const a of accounts) {
    if (!a.today) continue
    for (const [flavor, food] of Object.entries(foodByFlavor(a.today)))
      totals[`f${FOOD_FORMULA}:${a.id}::${flavor}`] = food
  }
  return totals
}

/** What it has worked on: the dominant flavour and how much of its XP that is. */
export function dietOf(s: PetSave): { top: Flavor; share: number; total: number } {
  const total = FLAVORS.reduce((n, f) => n + (s.diet[f] ?? 0), 0)
  if (total <= 0) return { top: 'other', share: 0, total: 0 }
  const top = FLAVORS.reduce((best, f) => ((s.diet[f] ?? 0) > (s.diet[best] ?? 0) ? f : best), FLAVORS[0])
  return { top, share: (s.diet[top] ?? 0) / total, total }
}

/**
 * Food tokens to whole XP, keeping the remainder so a long run of small turns
 * still adds up instead of being rounded away every time.
 */
export function tokensToXp(tokens: number, carry: number): { xp: number; carry: number } {
  const total = Math.max(0, Math.floor(tokens)) + Math.max(0, Math.floor(carry))
  return { xp: Math.floor(total / XP_TOKENS), carry: total % XP_TOKENS }
}

/** Credit `tokens` food tokens of agent work, paid for by `flavor`. */
export function earn(s: PetSave, tokens: number, now: number, flavor: Flavor = 'other'): PetSave {
  const t = Math.max(0, Math.floor(tokens))
  if (t <= 0) return s
  const { xp, carry } = tokensToXp(t, s.carryTokens)
  return {
    ...s,
    carryTokens: carry,
    totalTokens: s.totalTokens + t,
    xp: Math.min(XP_CAP, s.xp + xp),
    lastFedAt: xp > 0 ? now : s.lastFedAt,
    workFrom: xp > 0 ? nextWorkFrom(s, now) : s.workFrom,
    diet: { ...s.diet, [flavor]: (s.diet[flavor] ?? 0) + xp },
    history: noteDay(s.history, xp, now)
  }
}
/** Far past the top level, so a counter never runs away. */
const XP_CAP = 1e9

/** Gaining keeps the streak going, unless the last gain was long enough ago to count as a break. */
function nextWorkFrom(s: PetSave, now: number): number {
  if (!s.workFrom || now - s.lastFedAt >= WORK_IDLE_RESET_MS) return now
  return s.workFrom
}

/** How long you have been at it without a break; 0 once the work has gone quiet. */
export function workStreakMs(s: PetSave, now: number): number {
  if (!s.workFrom || now - s.lastFedAt >= WORK_IDLE_RESET_MS) return 0
  return Math.max(0, now - s.workFrom)
}

/** Whether the pet should be suggesting a break. Told never to, it does not. */
export function wantsBreak(s: PetSave, now: number, nagMs = BREAK_NAG_MS): boolean {
  return nagMs > 0 && workStreakMs(s, now) >= nagMs
}

/**
 * Back from a break. `worked` is the streak it interrupted, `rested` how long it
 * lasted. Anything under BREAK_MIN_MS was not a break; a short one ends the
 * streak, and only a full one goes on the record (and on the "you listened"
 * record when the pet had asked for it).
 */
export function rest(s: PetSave, worked: number, rested: number, now: number, nagMs = BREAK_NAG_MS): PetSave {
  if (rested < BREAK_MIN_MS) return s
  const full = rested >= BREAK_MS
  const asked = nagMs > 0 && worked >= nagMs
  return {
    ...s,
    workFrom: 0,
    plays: full ? s.plays + 1 : s.plays,
    wins: full && asked ? s.wins + 1 : s.wins,
    lastPlayAt: now
  }
}

/** How many of the day's fights the record remembers. */
export const FOUGHT_KEEP = 40

/**
 * Put a friend battle on the record. Each friend's pet counts once a day: the
 * fight is fixed by the two codes, so pasting a beaten friend again would just
 * be the same win twice. Returns the same object when it does not count.
 */
export function recordBattle(
  s: PetSave,
  foeBornAt: number,
  result: 'win' | 'loss' | 'draw',
  now: number,
  upset = false
): PetSave {
  const key = `${foeBornAt}@${dayKey(now)}`
  if (s.fought.includes(key)) return s
  return {
    ...s,
    battles: s.battles + 1,
    battleWins: s.battleWins + (result === 'win' ? 1 : 0),
    upsets: s.upsets + (result === 'win' && upset ? 1 : 0),
    fought: [...s.fought, key].slice(-FOUGHT_KEEP)
  }
}

// ---- seasonal events ----
// A few weeks of the year leave a keepsake behind: any pet that is around (out
// of the bag, the app open) during one gets that season's prize for good.
// Local calendar dates, inclusive, [month, day] with January = 1.
export const EVENTS: Array<{ id: string; from: [number, number]; to: [number, number] }> = [
  { id: 'spring', from: [4, 1], to: [4, 14] },
  { id: 'halloween', from: [10, 17], to: [11, 2] },
  { id: 'christmas', from: [12, 18], to: [12, 31] }
]

/** The events running on this day. */
export function eventsOn(now: number): string[] {
  const d = new Date(now)
  const md = (d.getMonth() + 1) * 100 + d.getDate()
  return EVENTS.filter((e) => {
    const from = e.from[0] * 100 + e.from[1]
    const to = e.to[0] * 100 + e.to[1]
    return from <= to ? md >= from && md <= to : md >= from || md <= to
  }).map((e) => e.id)
}

/** Hand out the running events' prizes. Same object when nothing new was claimed. */
export function claimEvents(s: PetSave, now: number): PetSave {
  const fresh = eventsOn(now).filter((id) => !s.events.includes(id))
  if (fresh.length === 0) return s
  return { ...s, events: [...s.events, ...fresh] }
}

// ---- prizes ----
export type Accessory =
  | 'sprout'
  | 'bow'
  | 'crown'
  | 'scarf'
  | 'bell'
  | 'medal'
  | 'heart'
  | 'star'
  | 'moon'
  | 'flowers'
  | 'mushrooms'
  | 'sparkle'
  | 'glitter'
  | 'legend'
  | 'bandana'
  | 'laurel'
  | 'sword'
  | 'trophy'
  | 'coin'
  | 'gem'
  | 'pumpkin'
  | 'santa'
  | 'blossom'
/**
 * Where a keepsake goes. One of each can be worn at once: a hat, something round
 * its neck, a little friend floating by, things growing at its feet, and a shine
 * all round it.
 */
export type AccessorySlot = 'head' | 'neck' | 'float' | 'ground' | 'aura'
export const ACCESSORY_SLOTS: AccessorySlot[] = ['aura', 'ground', 'float', 'neck', 'head']

export const slotOf = (a: Accessory): AccessorySlot => PRIZES.find((x) => x.id === a)?.slot ?? 'head'

/**
 * Every keepsake is won: each one comes with an award (and the seasonal ones
 * with an event), and the keeper puts it on by hand, one per slot. The ones
 * that came with care awards (hatching, never ill, never hungry) come with
 * levels now, so every keepsake can still be had.
 */
export const PRIZES: Array<{ id: Accessory; slot: AccessorySlot; award: string }> = [
  { id: 'sprout', slot: 'head', award: 'level5' },
  { id: 'bow', slot: 'head', award: 'playful' },
  { id: 'scarf', slot: 'neck', award: 'streak' },
  { id: 'heart', slot: 'float', award: 'level20' },
  { id: 'crown', slot: 'head', award: 'crowned' },
  { id: 'flowers', slot: 'ground', award: 'keeper' },
  { id: 'bell', slot: 'neck', award: 'lucky' },
  { id: 'star', slot: 'float', award: 'strains' },
  { id: 'sparkle', slot: 'aura', award: 'level40' },
  { id: 'medal', slot: 'neck', award: 'gourmet' },
  { id: 'moon', slot: 'float', award: 'level30' },
  { id: 'mushrooms', slot: 'ground', award: 'level50' },
  { id: 'glitter', slot: 'aura', award: 'hundredMillion' },
  { id: 'legend', slot: 'aura', award: 'legend' },
  { id: 'bandana', slot: 'head', award: 'challenger' },
  { id: 'laurel', slot: 'head', award: 'champion' },
  { id: 'sword', slot: 'float', award: 'gladiator' },
  { id: 'trophy', slot: 'float', award: 'giantSlayer' },
  { id: 'coin', slot: 'float', award: 'million' },
  { id: 'gem', slot: 'neck', award: 'tenMillion' },
  { id: 'pumpkin', slot: 'head', award: 'halloween' },
  { id: 'santa', slot: 'head', award: 'christmas' },
  { id: 'blossom', slot: 'float', award: 'spring' }
]

/** A worn list read defensively: known prizes only, one per slot. */
function wornOf(raw: unknown[]): Accessory[] {
  const out: Accessory[] = []
  for (const a of raw) {
    const p = PRIZES.find((x) => x.id === a)
    if (p && !out.some((w) => slotOf(w) === p.slot)) out.push(p.id)
  }
  return out
}

/** The prizes this pet has won so far, in PRIZES order. */
export function prizesOf(s: PetSave): Accessory[] {
  const done = new Set(awardsOf(s).filter((a) => a.done).map((a) => a.id))
  return PRIZES.filter((p) => done.has(p.award)).map((p) => p.id)
}

/**
 * Put a won prize on, or take it off. Putting one on takes off whatever other
 * prize was in that slot. A prize not yet won does nothing. (A prize a save
 * already wears stays on, won or not: nobody loses what they had on.)
 */
export function toggleWear(s: PetSave, id: Accessory): PetSave {
  if (s.worn.includes(id)) return { ...s, worn: s.worn.filter((w) => w !== id) }
  if (!prizesOf(s).includes(id)) return s
  const slot = slotOf(id)
  return { ...s, worn: [...s.worn.filter((w) => slotOf(w) !== slot), id] }
}

/**
 * A pet wearing `worn` with its decorations laid out as `layout`: only won
 * prizes go on (one already worn may stay), one per slot; a layout is read
 * defensively and an empty one is no layout. The same pet when nothing changed.
 */
export function withDecor(s: PetSave, worn: readonly unknown[], layout: unknown): PetSave {
  const won = prizesOf(s)
  const ok = wornOf(worn.filter((a) => won.includes(a as Accessory) || s.worn.includes(a as Accessory)))
  const lay = sanitizeLayout(layout)
  const same = ok.length === s.worn.length && ok.every((a, i) => a === s.worn[i])
  if (same && JSON.stringify(lay ?? null) === JSON.stringify(s.layout ?? null)) return s
  const { layout: _old, ...rest } = s
  void _old
  return { ...rest, worn: same ? s.worn : ok, ...(lay ? { layout: lay } : {}) }
}

/** What it has on, back to front (the shine behind it first, its hat last), so it can be drawn in order. */
export function outfitOf(worn: readonly Accessory[]): Accessory[] {
  const bySlot = new Map<AccessorySlot, Accessory>()
  for (const a of worn) bySlot.set(slotOf(a), a)
  return ACCESSORY_SLOTS.flatMap((slot) => {
    const a = bySlot.get(slot)
    return a ? [a] : []
  })
}

/** Where a pet stands: its level and how far it is toward the next. */
export interface Progress {
  level: number
  /** 0..1 toward the next level; 1 at MAX_LEVEL. */
  progress: number
  /** XP still needed for the next level; 0 only at MAX_LEVEL. */
  toNext: number
}

export function progressOf(xp: number): Progress {
  const { level, from, to } = levelOf(xp)
  if (to <= from) return { level, progress: 1, toNext: 0 }
  return { level, progress: Math.min(1, Math.max(0, (xp - from) / (to - from))), toNext: Math.max(0, to - xp) }
}

// The monotone token counter. `usage.today.totalTokens` is a per-day total, so it
// climbs through the day and DROPS at midnight. A drop therefore isn't spend to
// take back: it means a new day started, and the new total is itself fresh spend.
export function tokenDelta(prev: number, next: number): number {
  if (!Number.isFinite(next) || next < 0) return 0
  if (!Number.isFinite(prev) || prev < 0) return Math.floor(next)
  return next >= prev ? Math.floor(next - prev) : Math.floor(next)
}

// A day's usage in food tokens (see foodOf and CACHE_READ_WEIGHT). An account that
// reports no per-model breakdown (Codex) offers its plain total, with its cached
// input weighed like any cache read when it says how much that was.
export function foodTokens(today: UsageToday | null | undefined): number {
  if (!today) return 0
  if (!today.perModel?.length) return plainFood(today)
  return Math.floor(today.perModel.reduce((sum, m) => sum + foodOf(m), 0))
}

// Per-ACCOUNT baselines, because the account list grows (a Codex install is
// detected, a profile is added) and summing first would read that as a burst of
// spend. An account seen for the first time only sets its baseline: its earlier
// tokens were spent before the pet was watching. The same goes for a key of a
// new formula (FOOD_FORMULA), so a formula change never credits a jump.
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

/** The longest run of consecutive days with XP gained in it. */
export function dayStreak(history: DayXp[]): number {
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
 * The last `days` CALENDAR days, oldest first, whether the pet gained on them
 * or not: drawing only the days with XP in them gave a chart that lied.
 */
export function feedFrame(
  history: DayXp[],
  now: number,
  days = FEED_FRAME_DAYS
): Array<{ day: string; xp: number; today: boolean }> {
  const by = new Map(history.map((h) => [h.day, h.xp]))
  const today = dayKey(now)
  const out: Array<{ day: string; xp: number; today: boolean }> = []
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86_400_000)
    out.push({ day, xp: by.get(day) ?? 0, today: day === today })
  }
  return out
}

export interface Award {
  id: string
  done: boolean
  /** A seasonal one: only to be had while its event is on. */
  event?: boolean
}

/** How many different animals this keeper has had, the current pet included. */
export function strainsSeen(s: PetSave): number {
  return new Set<Species>([s.species, ...s.album.map((a) => a.species)]).size
}

/** What an animal is called: the dictionary's name, or the one its maker gave it. */
export function speciesName(
  species: Species,
  t: (key: string) => string,
  design?: { name: string } | null
): string {
  if (isBuiltinSpecies(species)) return t(`pet.species.${species}`)
  return design?.name || t('pet.species.custom')
}

/**
 * What this pet has managed. Derived, never stored: an award can't drift out of
 * step with the pet it describes, and adding one lights up retroactively.
 */
export function awardsOf(s: PetSave): Award[] {
  const level = levelOf(s.xp).level
  return [
    { id: 'level5', done: level >= 5 },
    { id: 'crowned', done: level >= 10 },
    { id: 'level20', done: level >= 20 },
    { id: 'level30', done: level >= 30 },
    { id: 'level40', done: level >= 40 },
    { id: 'level50', done: level >= 50 },
    { id: 'legend', done: level >= MAX_LEVEL },
    { id: 'million', done: s.totalTokens >= 1_000_000 },
    { id: 'tenMillion', done: s.totalTokens >= 10_000_000 },
    { id: 'hundredMillion', done: s.totalTokens >= 100_000_000 },
    { id: 'streak', done: dayStreak(s.history) >= 7 },
    { id: 'gourmet', done: FLAVORS.filter((f) => (s.diet[f] ?? 0) > 0).length >= 3 },
    { id: 'playful', done: s.plays >= 10 },
    { id: 'lucky', done: s.wins >= 5 },
    { id: 'keeper', done: s.album.length >= 3 },
    { id: 'strains', done: strainsSeen(s) >= 3 },
    { id: 'challenger', done: s.battles >= 1 },
    { id: 'champion', done: s.battleWins >= 5 },
    { id: 'gladiator', done: s.battleWins >= 20 },
    { id: 'giantSlayer', done: s.upsets >= 1 },
    ...EVENTS.map((e) => ({ id: e.id, done: s.events.includes(e.id), event: true }))
  ]
}

/** The album a pet leaves behind. One that never earned anything is not worth a page. */
export function archive(s: PetSave, now: number): AlbumEntry[] {
  if (s.xp <= 0) return s.album
  const entry: AlbumEntry = {
    name: s.name,
    species: s.species,
    ...(s.custom ? { speciesName: s.custom.name } : {}),
    level: levelOf(s.xp).level,
    xp: s.xp,
    tokens: s.totalTokens,
    ageMs: Math.max(0, now - s.bornAt),
    endedAt: now
  }
  return [...s.album, entry].slice(-ALBUM_SIZE)
}

// ---------------------------------------------------------------------------
// The nest: more than one pet at a time. Several can be out on screen at once
// (`shown`, by birthday); the work is shared among them as food (splitFood),
// and the ones put away wait where they were. One of those out is the focused
// pet (`active`, 주인공): the one that speaks, whose panel, decorations and
// motions the buttons act on, and it is always out. Each keeps its own save;
// the album is the keeper's, so it is shared and kept in step.
// ---------------------------------------------------------------------------

/** How many pets can be kept at once. */
export const MAX_PETS = 4
/**
 * The save format of pet.json. 2 was the tamagotchi nest, a bare pet before
 * that; 4 adds `shown` (a version 3 nest showed its active pet only, and so
 * reads as showing that one).
 */
export const NEST_VERSION = 4

export interface Nest {
  version: typeof NEST_VERSION
  /** The focused pet (주인공): the one that speaks and the buttons act on. Always shown. */
  active: number
  /**
   * The birthdays of the pets out on screen, in nest order, the focused one
   * among them. Birthdays, not places: a place shifts when a pet is let go.
   */
  shown: number[]
  pets: PetSave[]
}

/**
 * The pets out on screen, read defensively: birthdays of pets in the nest
 * only, once each, in nest order, and always the focused one. A nest from
 * before `shown` (or a broken one) shows its focused pet alone.
 */
export function shownOf(n: { pets: PetSave[]; active: number; shown?: unknown }): number[] {
  const want = new Set(
    Array.isArray(n.shown) ? n.shown.filter((b): b is number => typeof b === 'number' && Number.isFinite(b)) : []
  )
  const focus = n.pets[n.active]?.bornAt
  const out: number[] = []
  for (const p of n.pets) if ((want.has(p.bornAt) || p.bornAt === focus) && !out.includes(p.bornAt)) out.push(p.bornAt)
  return out
}

/** Whether pet `i` is out on screen. */
export function isShown(n: { pets: PetSave[]; active: number; shown?: unknown }, i: number): boolean {
  const p = n.pets[i]
  return !!p && shownOf(n).includes(p.bornAt)
}

const sameList = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Share one sample's food among the `k` pets out: each key's tokens split
 * evenly, the remainder (fewer than k tokens) one each to the first ones, so
 * the total is kept to the token and the same sample always splits the same
 * way. Every pet's token carry (tokensToXp) keeps the small shares from being
 * rounded away.
 *
 * Even shares for general usage. An assistant pet's own turns are not in
 * here: they feed that pet directly (feedOwn), and deductOwed keeps them out
 * of the shared samples.
 */
export function splitFood(deltas: Record<string, number>, k: number): Array<Record<string, number>> {
  const n = Math.max(1, Math.floor(k))
  const out: Array<Record<string, number>> = Array.from({ length: n }, () => ({}))
  for (const [key, raw] of Object.entries(deltas)) {
    const d = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    if (d <= 0) continue
    const each = Math.floor(d / n)
    const extra = d % n
    for (let i = 0; i < n; i++) {
      const v = each + (i < extra ? 1 : 0)
      if (v > 0) out[i][key] = v
    }
  }
  return out
}

// ---- an assistant pet's own food ----
// The first step toward "each pet eats from its own work": the tokens of a
// pet assistant's own turns (펫 비서, lib/petAssistant.ts) go to THAT pet,
// whole, not shared. The same tokens also show up in the account's daily
// usage, which the pets out share (splitFood); so what an assistant was fed
// directly is remembered as owed and taken out of the next shared samples of
// the same model, to count every token once. General usage keeps the even
// split among the pets out.

/** One usage record of a CLI transcript (lib/cliChat's 'usage' item). */
export interface UsageRecord {
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** A turn's usage records as food tokens per flavour (foodOf), whole tokens. */
export function turnFood(records: readonly UsageRecord[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of records) {
    const food = foodOf(r)
    if (food <= 0) continue
    const f = flavorOf(r.model || '')
    out[f] = (out[f] ?? 0) + food
  }
  for (const f of Object.keys(out)) {
    out[f] = Math.floor(out[f])
    if (out[f] <= 0) delete out[f]
  }
  return out
}

/**
 * Take what was already fed to assistant pets directly (`owed`, per flavour)
 * out of a shared sample's deltas (keys `…::<flavor>`), so those tokens are
 * not eaten twice. Returns the deltas left to share and what is still owed.
 */
export function deductOwed(
  deltas: Record<string, number>,
  owed: Record<string, number>
): { deltas: Record<string, number>; owed: Record<string, number> } {
  const left = { ...owed }
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(deltas)) {
    let d = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    const flavor = key.split('::')[1] ?? 'other'
    const due = Math.max(0, Math.floor(left[flavor] ?? 0))
    if (due > 0 && d > 0) {
      const take = Math.min(due, d)
      d -= take
      left[flavor] = due - take
    }
    if (d > 0) out[key] = d
  }
  for (const f of Object.keys(left)) if (!(left[f] > 0)) delete left[f]
  return { deltas: out, owed: left }
}

/**
 * Feed one pet (by birthday) its own food, per flavour, whether or not it is
 * out on screen: it did the work. The same array when nothing changed.
 */
export function feedOwn(
  n: { pets: PetSave[]; active: number },
  bornAt: number,
  food: Record<string, number>,
  now: number
): { pets: PetSave[]; leveled: LevelUp[] } {
  const i = n.pets.findIndex((p) => Math.floor(p.bornAt) === Math.floor(bornAt))
  if (i < 0) return { pets: n.pets, leveled: [] }
  const before = n.pets[i]
  let p = before
  for (const [f, raw] of Object.entries(food)) {
    const v = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    if (v > 0) p = earn(p, v, now, FLAVORS.includes(f as Flavor) ? (f as Flavor) : 'other')
  }
  if (p === before) return { pets: n.pets, leveled: [] }
  const lvl = levelOf(p.xp).level
  const leveled = lvl > levelOf(before.xp).level ? [{ bornAt: p.bornAt, level: lvl }] : []
  return { pets: n.pets.map((q, k) => (k === i ? p : q)), leveled }
}

/** Give every pet the same album, the longest one any of them carries. */
function shareAlbum(pets: PetSave[], album?: AlbumEntry[]): PetSave[] {
  const keep =
    album ?? pets.reduce<AlbumEntry[]>((a, p) => (p.album.length > a.length ? p.album : a), [])
  return pets.map((p) => (p.album === keep ? p : { ...p, album: keep }))
}

/**
 * Read pet.json, whichever version it is in: a bare pet from before the nest
 * becomes the first and only one, and every pet is read by normalize (which
 * migrates a version 1 one).
 */
export function normalizeNest(raw: unknown, now: number): Nest {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const list = o && Array.isArray(o.pets) ? o.pets.slice(0, MAX_PETS) : [raw]
  // An empty nest is a broken save; it still gets someone.
  if (!list.length) list.push(null)
  const pets = shareAlbum(list.map((p) => normalize(p, now)))
  // A pet is known by its birthday (what is out, a friend's battle record),
  // so no two in a nest share one: a later twin is made a millisecond younger.
  for (let i = 1; i < pets.length; i++) {
    let b = pets[i].bornAt
    while (pets.slice(0, i).some((p) => p.bornAt === b)) b += 1
    if (b !== pets[i].bornAt) pets[i] = { ...pets[i], bornAt: b }
  }
  const active = Math.min(pets.length - 1, Math.max(0, Math.floor(num(o?.active, 0))))
  // A version 3 nest has no list, and showed its active pet alone (shownOf).
  return { version: NEST_VERSION, active, shown: shownOf({ pets, active, shown: o?.shown }), pets }
}

/** Make pet `i` the focused one (주인공), bringing it out if it was put away. */
export function show(n: Nest, i: number): Nest {
  if (i < 0 || i >= n.pets.length) return n
  const shown = shownOf({ pets: n.pets, active: i, shown: shownOf(n) })
  if (i === n.active && sameList(shown, n.shown ?? [])) return n
  return { ...n, active: i, shown }
}

/**
 * Bring pet `i` out beside the others, or put it away. One pet is always out:
 * the last one out stays. Putting the focused one away hands the focus to the
 * first other one out.
 */
export function setShown(n: Nest, i: number, on: boolean): Nest {
  const p = n.pets[i]
  if (!p) return n
  const cur = shownOf(n)
  if (on) {
    if (cur.includes(p.bornAt)) return n
    return { ...n, shown: shownOf({ ...n, shown: [...cur, p.bornAt] }) }
  }
  if (!cur.includes(p.bornAt) || cur.length <= 1) return n
  const rest = cur.filter((b) => b !== p.bornAt)
  const active = i === n.active ? n.pets.findIndex((q) => q.bornAt === rest[0]) : n.active
  return { ...n, active, shown: shownOf({ pets: n.pets, active, shown: rest }) }
}

/** A new pet at level 1, out at once as the focused one. Nothing happens when the nest is full. */
export function adopt(n: Nest, now: number, hatch?: Hatch | null): Nest {
  if (n.pets.length >= MAX_PETS) return n
  // Its own birthday, even when two arrive in the same millisecond.
  const bornAt = Math.max(now, ...n.pets.map((p) => p.bornAt + 1))
  const fresh = { ...initialState(now, hatch), bornAt, album: n.pets[0]?.album ?? [] }
  const pets = [...n.pets, fresh]
  const active = n.pets.length
  return { ...n, pets, active, shown: shownOf({ pets, active, shown: shownOf(n) }) }
}

/**
 * Let pet `i` (the focused one by default) go, into the album. Never the last
 * one. When it was the focused one, the focus goes to another one out, or,
 * with none other out, to the next one, which comes out.
 */
export function release(n: Nest, now: number, i: number = n.active): Nest {
  if (n.pets.length <= 1 || i < 0 || i >= n.pets.length) return n
  const album = archive(n.pets[i], now)
  const pets = shareAlbum(
    n.pets.filter((_, k) => k !== i),
    album
  )
  const gone = n.pets[i].bornAt
  const rest = shownOf(n).filter((b) => b !== gone)
  let active: number
  if (i !== n.active) active = i < n.active ? n.active - 1 : n.active
  else {
    const other = pets.findIndex((p) => rest.includes(p.bornAt))
    active = other >= 0 ? other : Math.min(n.active, pets.length - 1)
  }
  return { ...n, pets, active, shown: shownOf({ pets, active, shown: rest }) }
}

/**
 * Start pet `i` (the shown one by default) over at level 1: the same animal
 * and name, everything else fresh, and the one it was kept in the album.
 */
export function restart(n: Nest, now: number, i: number = n.active): Nest {
  if (i < 0 || i >= n.pets.length) return n
  const old = n.pets[i]
  const album = archive(old, now)
  const hatch = isCustomId(old.species) && old.custom ? { id: old.species, design: old.custom } : null
  const fresh: PetSave = {
    ...initialState(now, hatch),
    species: old.species,
    name: old.name,
    // Its assistant settings are the keeper's, like its name (its conversation
    // is not: a new birthday is a new session).
    ...(old.assistant ? { assistant: old.assistant } : {}),
    // A new birthday is a new pet to friends' battle records; never the same
    // one twice, and never one another pet in the nest has.
    bornAt: Math.max(now, ...n.pets.map((p) => p.bornAt + 1))
  }
  const pets = shareAlbum(
    n.pets.map((p, k) => (k === i ? fresh : p)),
    album
  )
  // Out on screen before, out on screen still, under its new birthday.
  const shown = shownOf(n).map((b) => (b === old.bornAt ? fresh.bornAt : b))
  return { ...n, pets, shown: shownOf({ pets, active: n.active, shown }) }
}

// ---------------------------------------------------------------------------
// Looking after the nest from anywhere. The pet's own panel and Settings >
// 리븐펫 offer the same actions; both go through applyCommand, so they behave
// the same. A command names its pet by index AND birthday, so one that was
// sent about a list that has since changed is refused rather than applied to
// whoever now sits at that index.
// ---------------------------------------------------------------------------

/** What one pet looks like from outside: enough to list it and draw it. */
export interface PetBrief {
  bornAt: number
  name: string
  species: Species
  /** A homemade species' design, so it can be drawn where the list is shown. */
  custom?: CustomDesign
  level: number
  /** What it has on, and every prize it has won (the decoration layout lists them). */
  worn: Accessory[]
  prizes: Accessory[]
  layout?: DecorLayout
  /** Its own motion specs (the pet's 움직임). */
  motion?: MotionSet
  /** Its assistant settings (펫 비서), when it has any. */
  assistant?: AssistantConfig
}
export interface NestBrief {
  /** The focused pet (주인공). */
  active: number
  /** The birthdays of the pets out on screen (shownOf). */
  shown: number[]
  pets: PetBrief[]
}

export function briefOf(n: { pets: PetSave[]; active: number; shown?: unknown }): NestBrief {
  return {
    active: n.active,
    shown: shownOf(n),
    pets: n.pets.map((p) => ({
      bornAt: p.bornAt,
      name: p.name,
      species: p.species,
      ...(p.custom ? { custom: p.custom } : {}),
      level: levelOf(p.xp).level,
      worn: p.worn,
      prizes: prizesOf(p),
      ...(p.layout ? { layout: p.layout } : {}),
      ...(p.motion ? { motion: p.motion } : {}),
      ...(p.assistant ? { assistant: p.assistant } : {})
    }))
  }
}

/** What a pet in a list is called: its name, or its species when it has none. */
export function petTitle(b: Pick<PetBrief, 'name' | 'species' | 'custom'>, t: (key: string) => string): string {
  return b.name || speciesName(b.species, t, b.custom)
}

/** The line under it: its species (when it has a name) and level. */
export function petSubtitle(b: PetBrief, t: (key: string, vars?: Record<string, string | number>) => string): string {
  return [b.name ? speciesName(b.species, t, b.custom) : null, t('pet.level', { n: b.level })]
    .filter(Boolean)
    .join(' · ')
}

/** Which pet a command is about: its place in the nest, and its birthday. */
export interface PetRef {
  index: number
  bornAt: number
}
export type PetCommand =
  | { op: 'adopt'; hatch: Hatch | null }
  /** Make it the focused one (주인공), bringing it out if it was put away. */
  | ({ op: 'select' } & PetRef)
  /** Bring it out beside the others (on), or put it away; one always stays out. */
  | ({ op: 'setShown'; on: boolean } & PetRef)
  | ({ op: 'rename'; name: string } & PetRef)
  | ({ op: 'restart' } & PetRef)
  | ({ op: 'release' } & PetRef)
  /** The decoration layout's save: what it wears and where its decorations go (null: all automatic). */
  | ({ op: 'decor'; worn: Accessory[]; layout: DecorLayout | null } & PetRef)
  /** The pet's own motion specs (null: as its species moves). */
  | ({ op: 'motion'; motion: MotionSet | null } & PetRef)
  /** Its assistant settings (펫 비서); null forgets them. */
  | ({ op: 'assistant'; assistant: AssistantConfig | null } & PetRef)
/**
 * ok: done. full: no room for another pet. last: the only pet is never let go.
 * stale: that pet is not where the command thought it was. none: no one
 * answered (nothing is showing the pet).
 */
export type PetResult = 'ok' | 'full' | 'last' | 'stale' | 'none'

/** The longest name a pet takes. */
export const PET_NAME_MAX = 24

export function applyCommand(n: Nest, cmd: PetCommand, now: number): { nest: Nest; result: PetResult } {
  if (cmd.op === 'adopt') {
    if (n.pets.length >= MAX_PETS) return { nest: n, result: 'full' }
    return { nest: adopt(n, now, cmd.hatch), result: 'ok' }
  }
  const p = n.pets[cmd.index]
  if (!p || Math.floor(p.bornAt) !== Math.floor(cmd.bornAt)) return { nest: n, result: 'stale' }
  switch (cmd.op) {
    case 'select':
      return { nest: show(n, cmd.index), result: 'ok' }
    case 'setShown':
      return { nest: setShown(n, cmd.index, cmd.on === true), result: 'ok' }
    case 'rename': {
      const name = String(cmd.name ?? '').trim().slice(0, PET_NAME_MAX)
      if (name === p.name) return { nest: n, result: 'ok' }
      return { nest: { ...n, pets: n.pets.map((q, i) => (i === cmd.index ? { ...q, name } : q)) }, result: 'ok' }
    }
    case 'restart':
      return { nest: restart(n, now, cmd.index), result: 'ok' }
    case 'release':
      if (n.pets.length <= 1) return { nest: n, result: 'last' }
      return { nest: release(n, now, cmd.index), result: 'ok' }
    case 'decor': {
      const next = withDecor(p, Array.isArray(cmd.worn) ? cmd.worn : p.worn, cmd.layout)
      if (next === p) return { nest: n, result: 'ok' }
      return { nest: { ...n, pets: n.pets.map((q, i) => (i === cmd.index ? next : q)) }, result: 'ok' }
    }
    case 'motion': {
      const next = withPetMotion(p, cmd.motion)
      if (next === p) return { nest: n, result: 'ok' }
      return { nest: { ...n, pets: n.pets.map((q, i) => (i === cmd.index ? next : q)) }, result: 'ok' }
    }
    case 'assistant': {
      const next = withAssistant(p, cmd.assistant)
      if (next === p) return { nest: n, result: 'ok' }
      return { nest: { ...n, pets: n.pets.map((q, i) => (i === cmd.index ? next : q)) }, result: 'ok' }
    }
  }
}

/** A pet with these assistant settings, read defensively (null: none). The same pet when nothing changed. */
export function withAssistant(s: PetSave, assistant: unknown): PetSave {
  const a = sanitizeAssistant(assistant)
  if (JSON.stringify(a ?? null) === JSON.stringify(s.assistant ?? null)) return s
  const { assistant: _old, ...rest } = s
  void _old
  return { ...rest, ...(a ? { assistant: a } : {}) }
}

/** A pet with its own motion specs, read defensively (null or nothing valid: as its species). The same pet when nothing changed. */
export function withPetMotion(s: PetSave, motion: unknown): PetSave {
  const m = sanitizeMotionSet(motion)
  if (JSON.stringify(m ?? null) === JSON.stringify(s.motion ?? null)) return s
  const { motion: _old, ...rest } = s
  void _old
  return { ...rest, ...(m ? { motion: m } : {}) }
}

// ---------------------------------------------------------------------------
// Store: a thin wrapper over the pure functions plus persistence.
// ---------------------------------------------------------------------------

const FILE = 'pet.json'

/** A level just reached, by which pet, for it to celebrate. */
export interface LevelUp {
  bornAt: number
  level: number
}

interface PetStore {
  /** The focused pet: always `pets[active]`, kept so readers need not index. */
  pet: PetSave
  pets: PetSave[]
  active: number
  /** The birthdays of the pets out on screen (shownOf), the focused one among them. */
  shown: number[]
  loaded: boolean
  // Per-account daily totals as of the last sample. Deliberately NOT persisted:
  // after a restart every account is "new" again, so the day's already-counted
  // tokens are re-baselined instead of being credited twice.
  seen: Record<string, number>
  /**
   * Food fed to assistant pets directly (feedOwn) that the shared samples have
   * not caught up with yet, per flavour (deductOwed). Not persisted, like `seen`.
   */
  owed: Record<string, number>
  /** An assistant pet's own turn: its tokens go to it alone (feedOwn). */
  feedOwn: (bornAt: number, food: Record<string, number>, now?: number) => void
  load: () => Promise<void>
  /** Hand out a running seasonal event to the focused pet. */
  tick: (now?: number) => void
  /**
   * Record a usage sample and credit the XP. Keys are foodTotals'
   * `<formula>:<account>::<flavor>`, so each model's tokens are tracked (and
   * credited) separately. The pets out share it (splitFood); the ones put
   * away earn nothing.
   */
  sample: (totals: Record<string, number>, now?: number) => void
  /**
   * The level a pet has just reached, for it to celebrate: the focused one's
   * when it was among them, else the first one out that did. Cleared by ack.
   */
  justLeveled: LevelUp | null
  ackLevel: () => void
  /** Back from a break of `rested` ms that interrupted a `worked` ms streak. */
  takeBreak: (worked: number, rested: number, nagMs?: number) => void
  /** Put a friend battle on the focused pet's record; false when it already counted today. */
  recordBattle: (foeBornAt: number, result: 'win' | 'loss' | 'draw', upset?: boolean) => boolean
  /** Put a won prize on the focused pet, or take it off. */
  wear: (id: Accessory) => void
  /** Bring the pets' snapshots of custom species up to date with the keeper's list. */
  syncCustom: (own: Array<{ id: string } & CustomDesign>) => void
  /** Look after the nest: a new pet, focus, show, rename, start over, let go (see applyCommand). */
  apply: (cmd: PetCommand) => PetResult
  /**
   * Forget the loaded nest, so the next load() reads pet.json again. Called when
   * this window stops showing the pet: another window (the pet's own, or
   * Settings with the pet put away) may change the save meanwhile.
   */
  unload: () => void
}

const nestOf = (s: { pets: PetSave[]; active: number; shown: number[] }): Nest => ({
  version: NEST_VERSION,
  active: s.active,
  shown: s.shown,
  pets: s.pets
})

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(state: Nest): void {
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
  void window.api.config.save(FILE, nestOf(usePet.getState()))
}

/**
 * Feed the pets out one sample's food, shared among them (splitFood). The
 * nest's pets as they are now, and the level ups it brought, the focused
 * one's first. The same array when nobody gained.
 */
export function feedShown(
  n: { pets: PetSave[]; active: number; shown?: unknown },
  deltas: Record<string, number>,
  now: number
): { pets: PetSave[]; leveled: LevelUp[] } {
  const out = shownOf(n)
  const shares = splitFood(deltas, out.length)
  let changed = false
  const leveled: LevelUp[] = []
  const pets = n.pets.map((before, i) => {
    const k = out.indexOf(before.bornAt)
    if (k < 0) return before
    // One gain per flavour, so the diet records which model actually paid.
    let p = before
    for (const [key, d] of Object.entries(shares[k])) p = earn(p, d, now, flavorOf(key.split('::')[1] ?? ''))
    if (p === before) return before
    changed = true
    const lvl = levelOf(p.xp).level
    if (lvl > levelOf(before.xp).level) {
      const up = { bornAt: p.bornAt, level: lvl }
      if (i === n.active) leveled.unshift(up)
      else leveled.push(up)
    }
    return p
  })
  return { pets: changed ? pets : n.pets, leveled }
}

export const usePet = create<PetStore>((set, get) => {
  /** Swap in a new nest and persist it. */
  const commit = (n: { pets: PetSave[]; active: number; shown?: unknown }): void => {
    noteSnapshots(n.pets)
    const shown = shownOf(n)
    set({ pets: n.pets, active: n.active, shown, pet: n.pets[n.active] })
    scheduleSave(nestOf({ pets: n.pets, active: n.active, shown }))
  }
  /** Replace the focused pet with what `fn` makes of it; nothing if unchanged. */
  const onActive = (fn: (p: PetSave) => PetSave): void => {
    const { pets, active, shown } = get()
    const next = fn(pets[active])
    if (next === pets[active]) return
    commit({ pets: pets.map((p, i) => (i === active ? next : p)), active, shown })
  }
  const first = initialState(Date.now())
  return {
    pet: first,
    pets: [first],
    active: 0,
    shown: [first.bornAt],
    loaded: false,
    seen: {},
    owed: {},
    justLeveled: null,
    ackLevel: () => set({ justLeveled: null }),
    load: async () => {
      if (get().loaded) return
      const raw = await window.api.config.load(FILE).catch(() => null)
      const n = normalizeNest(raw, Date.now())
      noteSnapshots(n.pets)
      set({ pets: n.pets, active: n.active, shown: n.shown, pet: n.pets[n.active], loaded: true })
      // A save in an older format is written back in this one at once, so
      // Settings (which reads the file) sees the same pets.
      const old = raw as { version?: unknown } | null
      if (raw && old?.version !== NEST_VERSION) scheduleSave(n)
    },
    // Seasonal prizes are handed out here, so a pet that is only being looked at
    // (no agent working) still gets its event.
    tick: (now = Date.now()) => onActive((p) => claimEvents(p, now)),
    sample: (totals, now = Date.now()) => {
      const sampled = sampleAccounts(get().seen, totals)
      // What assistant pets already ate of these tokens is not shared again.
      const { deltas, owed } = deductOwed(sampled.deltas, get().owed)
      set({ seen: sampled.seen, owed })
      const s = get()
      const { pets, leveled } = feedShown(s, deltas, now)
      if (pets === s.pets) return
      if (leveled.length) set({ justLeveled: leveled[0] })
      commit({ pets, active: s.active, shown: s.shown })
    },
    feedOwn: (bornAt, food, now = Date.now()) => {
      const s = get()
      if (!s.loaded) return
      const { pets, leveled } = feedOwn(s, bornAt, food, now)
      if (pets === s.pets) return
      const owed = { ...s.owed }
      for (const [f, v] of Object.entries(food)) if (v > 0) owed[f] = (owed[f] ?? 0) + Math.floor(v)
      set({ owed })
      if (leveled.length) set({ justLeveled: leveled[0] })
      commit({ pets, active: s.active, shown: s.shown })
    },
    takeBreak: (worked, rested, nagMs) => onActive((p) => rest(p, worked, rested, Date.now(), nagMs)),
    recordBattle: (foeBornAt, result, upset) => {
      const before = get().pet
      onActive((p) => recordBattle(p, foeBornAt, result, Date.now(), upset))
      return get().pet !== before
    },
    wear: (id) => onActive((p) => toggleWear(p, id)),
    syncCustom: (own) => {
      if (!get().loaded) return
      const pets = refreshCustom(get().pets, own)
      if (pets !== get().pets) commit({ pets, active: get().active, shown: get().shown })
    },
    apply: (cmd) => {
      const before = nestOf(get())
      const { nest, result } = applyCommand(before, cmd, Date.now())
      if (nest.pets === before.pets && nest.active === before.active && sameList(shownOf(nest), before.shown))
        return result
      // A different pet in focus (or a new one where it was): nothing to
      // celebrate from the one before.
      if (nest.active !== before.active || nest.pets[nest.active] !== before.pets[before.active])
        set({ justLeveled: null })
      // A restarted pet that is out must not earn today's earlier tokens, so
      // the counters start again from here.
      if (cmd.op === 'restart' && before.shown.includes(before.pets[cmd.index]?.bornAt ?? NaN)) set({ seen: {} })
      commit(nest)
      return result
    },
    unload: () => {
      if (saveTimer) flushPetSave()
      set({ loaded: false })
    }
  }
})
