import { PRIZES, isBuiltinSpecies, type BuiltinSpecies, type Accessory, type PetSave, type Species } from './pet'
import { MAX_LEVEL, STATS, STAT_BASE, levelOf, statTotal, statsOf, type Stats } from './petLevel'
import {
  customOf,
  familyOfDesign,
  isCustomId,
  noteDesign,
  packDesign,
  unpackDesign,
  type CustomDesign,
  type Family
} from './petSpecies'

// ---------------------------------------------------------------------------
// Friend battles. There is no server: a pet travels as a short code you paste
// to a friend (a chat message is enough), and the fight is worked out on each
// side from the two codes alone. Everything here is pure and deterministic, so
// the same two codes give the same fight on both machines, blow for blow, and
// pasting the same friend again cannot reroll a loss into a win.
//
// A fight is level and stats (petLevel.ts) and the species' family matchup.
// The checksum catches a typo or a half-copied code. It does not stop someone
// who reads this file from forging a level 99 pet: without a server nothing
// can, so a battle only ever moves the win/loss record, never XP.
// ---------------------------------------------------------------------------

/** What a pet brings to a fight. */
export interface BattleCard {
  name: string
  species: Species
  level: number
  stats: Stats
  /** Its birthday, which is how a keeper's own pets are told apart from a friend's. */
  bornAt: number
  /** Prizes it has on, so a friend sees it dressed up. Looks only, never strength. */
  worn?: Accessory[]
  /**
   * A species made from a photo travels with its design, so a friend who has
   * never seen it can draw it, and both sides read the same family off it.
   */
  custom?: CustomDesign
}

/** Matchups: each family has the edge on the next one round. */
export type { Family }
const FAMILY: Record<BuiltinSpecies, Family> = {
  cat: 'wild',
  rabbit: 'wild',
  dog: 'wild',
  hamster: 'wild',
  fox: 'wild',
  bear: 'wild',
  fish: 'sea',
  turtle: 'sea',
  penguin: 'sea',
  crab: 'sea',
  octopus: 'sea',
  axolotl: 'sea',
  bird: 'spark',
  bug: 'spark',
  owl: 'spark',
  dragon: 'spark',
  frog: 'spark',
  slime: 'spark'
}
// A paw catches a fish, the sea shorts out a spark, a spark zaps a paw.
const BEATS: Record<Family, Family> = { wild: 'sea', sea: 'spark', spark: 'wild' }
/** The design of a custom species, from the card if it carries one. */
const designFor = (s: Species, card?: BattleCard): CustomDesign | null =>
  (card?.species === s ? card.custom : undefined) ?? customOf(s)

/** A species' family. One made from a photo reads it off its colours (see familyOfDesign). */
export const familyOf = (s: Species, card?: BattleCard): Family => {
  if (isBuiltinSpecies(s)) return FAMILY[s]
  const d = designFor(s, card)
  return d ? familyOfDesign(d) : 'wild'
}
export const ADVANTAGE = 1.25
export const DISADVANTAGE = 0.8
export function matchup(a: Species, b: Species, ca?: BattleCard, cb?: BattleCard): number {
  const fa = familyOf(a, ca)
  const fb = familyOf(b, cb)
  if (BEATS[fa] === fb) return ADVANTAGE
  if (BEATS[fb] === fa) return DISADVANTAGE
  return 1
}

/** The pet as it stands, ready to send. */
export function cardOf(s: PetSave): BattleCard {
  // The keeper's current design, or the pet's own snapshot of a deleted one.
  const design = isCustomId(s.species) ? (customOf(s.species) ?? s.custom ?? null) : null
  const level = levelOf(s.xp).level
  return {
    name: s.name.slice(0, 24),
    species: s.species,
    level,
    stats: statsOf(level, s.species, s.diet, design),
    bornAt: Math.floor(s.bornAt),
    ...(s.worn.length ? { worn: [...s.worn] } : {}),
    ...(design ? { custom: design } : {})
  }
}

/** Did the first card beat the odds? A friend's pet ten levels up on it is a giant worth bragging about. */
export const UPSET_LEVELS = 10
export function isUpset(mine: BattleCard, foe: BattleCard): boolean {
  return foe.level >= mine.level + UPSET_LEVELS
}

// ---- the code ----
//
// RP2.<data>.<check>: data is base64url JSON
//   [name, species, level, power, smarts, speed, stamina, bornAt, worn?, design?]
// RP1 (the tamagotchi's, [name, species, stage, form, level, fullness, mood,
// sick, bornAt, worn?, design?]) still reads: its stage and level become the
// level the same XP is now (see legacyLevel) and its stats are its species'
// at that level. A code from a newer riven is refused as such (readCode).

const PREFIX = 'RP2'
export const CODE_VERSION = 2

/** A 32-bit avalanche over a string: the checksum, and the fight's seed. */
export function hashOf(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  }
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return (h ^ (h >>> 16)) >>> 0
}

const toB64url = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64url = (b64: string): string => {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

// The fields that decide a fight. What it wears rides along after them, so
// changing clothes cannot change how a fight goes (see `fight`).
const fieldsOf = (c: BattleCard): unknown[] => [
  c.name,
  c.species,
  c.level,
  ...STATS.map((s) => c.stats[s]),
  c.bornAt
]

/** The code to send a friend: `RP2.<data>.<check>`. */
export function encodeCard(c: BattleCard): string {
  const fields = c.custom
    ? [...fieldsOf(c), c.worn ?? [], packDesign(c.custom)]
    : c.worn?.length
      ? [...fieldsOf(c), c.worn]
      : fieldsOf(c)
  const body = toB64url(JSON.stringify(fields))
  return `${PREFIX}.${body}.${hashOf(body).toString(36)}`
}

const CODE_RE = /RP(\d+)\.([A-Za-z0-9_-]+)\.([0-9a-z]+)/

const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null

/** Unknown prizes (a newer riven's) are dropped rather than failing the code. */
const dressedOf = (worn: unknown): Accessory[] =>
  Array.isArray(worn) ? PRIZES.filter((p) => worn.includes(p.id)).map((p) => p.id) : []

/** The tamagotchi's stage thresholds (kibble) and its grown-up level costs, for RP1 codes. */
const OLD_STAGE_XP = [0, 10, 60, 250, 800]
const OLD_LEVEL_COST = (lvl: number): number => 100 + 50 * (lvl - 1)

/**
 * The level an RP1 pet would be now: the least kibble its stage (index 1..4)
 * and grown-up level (0 before adult) took, read as XP (one for one, as a save
 * is migrated in state/pet.ts).
 */
export function legacyLevel(stage: number, oldLevel: number): number {
  let xp = OLD_STAGE_XP[stage] ?? 0
  for (let l = 1; l < oldLevel; l++) xp += OLD_LEVEL_COST(l)
  return levelOf(xp).level
}

/** Read a body as an RP2 card, or null. */
function readV2(raw: unknown[]): BattleCard | null {
  if (raw.length < 8) return null
  const [name, species, level, power, smarts, speed, stamina, bornAt, worn, packed] = raw
  const custom = isCustomId(species) ? unpackDesign(packed) : null
  const lvl = int(level, 1, MAX_LEVEL)
  const born = int(bornAt, 0, Number.MAX_SAFE_INTEGER)
  if (typeof name !== 'string' || (!isBuiltinSpecies(species) && !custom) || lvl === null || born === null)
    return null
  // Every pet's stats add up to the same total at a level, each at least the base.
  const cap = statTotal(lvl)
  const vals = [power, smarts, speed, stamina].map((v) => int(v, STAT_BASE, cap))
  if (vals.some((v) => v === null)) return null
  const stats = { power: vals[0]!, smarts: vals[1]!, speed: vals[2]!, stamina: vals[3]! }
  if (STATS.reduce((n, s) => n + stats[s], 0) !== cap) return null
  const dressed = dressedOf(worn)
  return {
    name: name.slice(0, 24),
    species: species as Species,
    level: lvl,
    stats,
    bornAt: born,
    ...(dressed.length ? { worn: dressed } : {}),
    ...(custom ? { custom } : {})
  }
}

const OLD_FORMS = ['base', 'radiant', 'sturdy', 'titan', 'wraith']

/** Read a body as an RP1 (tamagotchi) card, as it would stand now, or null. */
function readV1(raw: unknown[]): BattleCard | null {
  if (raw.length < 9) return null
  const [name, species, stageIx, form, level, fullness, mood, sick, bornAt, worn, packed] = raw
  const custom = isCustomId(species) ? unpackDesign(packed) : null
  const stage = int(stageIx, 1, OLD_STAGE_XP.length - 1)
  const old = int(level, 0, MAX_LEVEL)
  const born = int(bornAt, 0, Number.MAX_SAFE_INTEGER)
  if (
    typeof name !== 'string' ||
    (!isBuiltinSpecies(species) && !custom) ||
    stage === null ||
    !OLD_FORMS.includes(form as string) ||
    old === null ||
    int(fullness, 0, 100) === null ||
    int(mood, 0, 100) === null ||
    (sick !== 0 && sick !== 1) ||
    born === null
  )
    return null
  // A grown-up had a level and maybe a form; nothing younger had either.
  const adult = stage === OLD_STAGE_XP.length - 1
  if (adult !== old > 0 || (!adult && form !== 'base')) return null
  const lvl = legacyLevel(stage, old)
  const dressed = dressedOf(worn)
  return {
    name: name.slice(0, 24),
    species: species as Species,
    level: lvl,
    stats: statsOf(lvl, species as string, null, custom),
    bornAt: born,
    ...(dressed.length ? { worn: dressed } : {}),
    ...(custom ? { custom } : {})
  }
}

/**
 * Read a friend's code, from whatever it was pasted along with ("here's mine:
 * RP2...!"). `newer` is a code from a riven newer than this one; `bad` is
 * anything that is not a whole, untouched, sensible pet.
 */
export function readCode(text: string): { card: BattleCard } | { error: 'bad' | 'newer' } {
  const m = CODE_RE.exec(text)
  if (!m) return { error: 'bad' }
  const [, ver, body, check] = m
  const version = Number(ver)
  if (hashOf(body).toString(36) !== check) return { error: 'bad' }
  if (version > CODE_VERSION) return { error: 'newer' }
  let raw: unknown
  try {
    raw = JSON.parse(fromB64url(body))
  } catch {
    return { error: 'bad' }
  }
  if (!Array.isArray(raw)) return { error: 'bad' }
  const card = version === 1 ? readV1(raw) : version === 2 ? readV2(raw) : null
  return card ? { card } : { error: 'bad' }
}

/** A friend's card, or null for anything that is not one this riven can read. */
export function decodeCard(text: string): BattleCard | null {
  const r = readCode(text)
  return 'card' in r ? r.card : null
}

/** Make a friend's animal drawable, when it is one made from a photo. */
export function noteCard(c: BattleCard): void {
  if (c.custom && isCustomId(c.species) && !customOf(c.species)) noteDesign(c.species, c.custom)
}

// ---- the fight ----

export interface Fighter {
  hp: number
  atk: number
  def: number
  spd: number
  /** Chance of a critical hit, 0..1. */
  crit: number
}

/**
 * A card's numbers, from its stats. Square roots, so stats (which grow
 * straight with the level) give diminishing returns: a well-matched level 20
 * can still take a swing at a level 60, and a level 60 has less than twice
 * the HP of a level 5. Power hits, stamina takes it, speed swings first and
 * dodges, smarts finds the weak spot (crits).
 */
export function fighterOf(c: BattleCard): Fighter {
  const r = (n: number): number => Math.sqrt(Math.max(0, n))
  return {
    hp: Math.round(50 + 9 * r(c.stats.stamina)),
    atk: Math.round((5 + 2.2 * r(c.stats.power)) * 10) / 10,
    def: Math.round((1 + 0.9 * r(c.stats.stamina)) * 10) / 10,
    spd: Math.round(r(c.stats.speed) * 10) / 10,
    crit: Math.round((0.04 + (0.16 * c.stats.smarts) / (c.stats.smarts + 100)) * 1000) / 1000
  }
}

export interface Blow {
  /** Who swung: 0 is the first card passed to `fight`, 1 the second. */
  by: 0 | 1
  dmg: number
  crit: boolean
  miss: boolean
  /** Both sides' HP after the blow. */
  hp: [number, number]
}

export interface Bout {
  fighters: [Fighter, Fighter]
  blows: Blow[]
  /** 0 or 1, or null for a draw (both still standing when time ran out). */
  winner: 0 | 1 | null
}

export const MAX_BLOWS = 30
/** The chance a blow lands between equally quick pets; speed moves it up to SPEED_DODGE either way. */
export const HIT_CHANCE = 0.9
export const SPEED_DODGE = 0.08
export const CRIT_MULT = 1.6

/** mulberry32: small, fast, and the same on every machine. */
function rngOf(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The fight between two cards. Whichever way round they are passed, it is the
 * same fight seen from the other side: you and your friend each paste the
 * other's code and watch the same thing happen.
 */
export function fight(a: BattleCard, b: BattleCard): Bout {
  const ca = JSON.stringify(fieldsOf(a))
  const cb = JSON.stringify(fieldsOf(b))
  if (cb < ca) return flip(simulate(b, a, hashOf(`${cb}|${ca}`)))
  return simulate(a, b, hashOf(`${ca}|${cb}`))
}

function flip(o: Bout): Bout {
  return {
    fighters: [o.fighters[1], o.fighters[0]],
    blows: o.blows.map((w) => ({ ...w, by: w.by === 0 ? 1 : 0, hp: [w.hp[1], w.hp[0]] })),
    winner: o.winner === null ? null : o.winner === 0 ? 1 : 0
  }
}

function simulate(a: BattleCard, b: BattleCard, seed: number): Bout {
  const rand = rngOf(seed)
  const cards = [a, b]
  const f: [Fighter, Fighter] = [fighterOf(a), fighterOf(b)]
  const hp: [number, number] = [f[0].hp, f[1].hp]
  // The quicker one swings first; a tie goes to the toss.
  let turn: 0 | 1 = f[0].spd > f[1].spd ? 0 : f[1].spd > f[0].spd ? 1 : rand() < 0.5 ? 0 : 1
  const blows: Blow[] = []
  while (blows.length < MAX_BLOWS && hp[0] > 0 && hp[1] > 0) {
    const me = turn
    const foe: 0 | 1 = me === 0 ? 1 : 0
    const edge = (f[me].spd - f[foe].spd) / Math.max(1, f[me].spd + f[foe].spd)
    const miss = rand() >= HIT_CHANCE + SPEED_DODGE * edge
    const crit = !miss && rand() < f[me].crit
    let dmg = 0
    if (!miss) {
      const swing = f[me].atk * (0.85 + rand() * 0.3) * matchup(cards[me].species, cards[foe].species, cards[me], cards[foe])
      dmg = Math.max(1, Math.round((crit ? swing * CRIT_MULT : swing) - f[foe].def * 0.5))
    }
    hp[foe] = Math.max(0, hp[foe] - dmg)
    blows.push({ by: me, dmg, crit, miss, hp: [hp[0], hp[1]] })
    turn = foe
  }
  // Time ran out: whoever has more of themselves left, as a share of their HP.
  const winner =
    hp[1] <= 0
      ? 0
      : hp[0] <= 0
        ? 1
        : hp[0] / f[0].hp > hp[1] / f[1].hp
          ? 0
          : hp[1] / f[1].hp > hp[0] / f[0].hp
            ? 1
            : null
  return { fighters: f, blows, winner }
}
