import {
  FORMS,
  HUNGRY_AT,
  MAX_LEVEL,
  SPECIES,
  STAGES,
  growthOf,
  type Form,
  type Mood,
  type PetSave,
  type Species,
  type Stage
} from './pet'

// ---------------------------------------------------------------------------
// Friend battles. There is no server: a pet travels as a short code you paste
// to a friend (a chat message is enough), and the fight is worked out on each
// side from the two codes alone. Everything here is pure and deterministic, so
// the same two codes give the same fight on both machines, frame for frame, and
// pasting the same friend again cannot reroll a loss into a win.
//
// The checksum catches a typo or a half-copied code. It does not stop someone
// who reads this file from forging a level 99 pet: without a server nothing
// can, so a battle only ever moves the win/loss record, never growth.
// ---------------------------------------------------------------------------

/** What a pet brings to a fight: who it is and how it is doing right now. */
export interface BattleCard {
  name: string
  species: Species
  stage: Stage
  form: Form
  level: number
  /** 0..100 snapshots: a hungry, gloomy or ill pet fights worse. */
  fullness: number
  mood: number
  sick: boolean
  /** Its birthday, which is how a keeper's own pets are told apart from a friend's. */
  bornAt: number
}

/** Matchups: each family has the edge on the next one round. */
export type Family = 'wild' | 'sea' | 'spark'
const FAMILY: Record<Species, Family> = {
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
export const familyOf = (s: Species): Family => FAMILY[s]
export const ADVANTAGE = 1.25
export const DISADVANTAGE = 0.8
export function matchup(a: Species, b: Species): number {
  const fa = familyOf(a)
  const fb = familyOf(b)
  if (BEATS[fa] === fb) return ADVANTAGE
  if (BEATS[fb] === fa) return DISADVANTAGE
  return 1
}

/** The pet as it stands, ready to send. Eggs cannot fight and get null. */
export function cardOf(s: PetSave, now: number): BattleCard | null {
  const g = growthOf(s, now)
  if (g.stage === 'egg') return null
  return {
    name: s.name.slice(0, 24),
    species: s.species,
    stage: g.stage,
    form: g.form,
    level: g.level,
    fullness: Math.round(s.fullness),
    mood: Math.round(s.mood),
    sick: s.sick,
    bornAt: Math.floor(s.bornAt)
  }
}

/** The face a friend's pet wears, read off its card the way moodOf reads a save. */
export function moodOfCard(c: BattleCard): Mood {
  if (c.sick) return 'sick'
  if (c.fullness <= 0 || c.mood < 25) return 'sad'
  if (c.fullness < HUNGRY_AT) return 'hungry'
  if (c.mood >= 70) return 'happy'
  return 'ok'
}

// ---- the code ----

const PREFIX = 'RP1'

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

/** The code to send a friend: `RP1.<data>.<check>`. */
export function encodeCard(c: BattleCard): string {
  const body = toB64url(
    JSON.stringify([
      c.name,
      c.species,
      STAGES.indexOf(c.stage),
      c.form,
      c.level,
      c.fullness,
      c.mood,
      c.sick ? 1 : 0,
      c.bornAt
    ])
  )
  return `${PREFIX}.${body}.${hashOf(body).toString(36)}`
}

const CODE_RE = /RP1\.([A-Za-z0-9_-]+)\.([0-9a-z]+)/

/**
 * Read a friend's code, from whatever it was pasted along with ("here's mine:
 * RP1...!"). Null for anything that is not a whole, untouched, sensible pet.
 */
export function decodeCard(text: string): BattleCard | null {
  const m = CODE_RE.exec(text)
  if (!m) return null
  const [, body, check] = m
  if (hashOf(body).toString(36) !== check) return null
  let raw: unknown
  try {
    raw = JSON.parse(fromB64url(body))
  } catch {
    return null
  }
  if (!Array.isArray(raw) || raw.length < 9) return null
  const [name, species, stageIx, form, level, fullness, mood, sick, bornAt] = raw
  const int = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null
  const stage = STAGES[int(stageIx, 1, STAGES.length - 1) ?? -1]
  const lvl = int(level, 0, MAX_LEVEL)
  const full = int(fullness, 0, 100)
  const md = int(mood, 0, 100)
  const born = int(bornAt, 0, Number.MAX_SAFE_INTEGER)
  if (
    typeof name !== 'string' ||
    !SPECIES.includes(species as Species) ||
    !stage ||
    !FORMS.includes(form as Form) ||
    lvl === null ||
    full === null ||
    md === null ||
    born === null ||
    (sick !== 0 && sick !== 1)
  )
    return null
  // A grown-up has a level and may have a form; nothing younger has either.
  const adult = stage === 'adult'
  if (adult !== lvl > 0 || (!adult && form !== 'base')) return null
  return {
    name: name.slice(0, 24),
    species: species as Species,
    stage,
    form: form as Form,
    level: lvl,
    fullness: full,
    mood: md,
    sick: sick === 1,
    bornAt: born
  }
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

// How much fight each stage has in it, before any grown-up levels.
const STAGE_POWER: Record<Stage, number> = { egg: 0, hatchling: 6, child: 12, teen: 20, adult: 30 }

/**
 * A card's numbers. Levels count, but with diminishing returns (a square root),
 * so a lovingly raised level 20 can still take a swing at a level 60.
 */
export function fighterOf(c: BattleCard): Fighter {
  const power = STAGE_POWER[c.stage] + (c.level > 0 ? 6 * Math.sqrt(c.level) : 0)
  let hp = 30 + power * 1.6
  let atk = 8 + power * 0.5
  let def = 4 + power * 0.25
  let spd = 10 + power * 0.2
  let crit = 0.08
  // How it grew up shapes how it fights.
  switch (c.form) {
    case 'radiant':
      spd *= 1.15
      crit += 0.05
      break
    case 'sturdy':
      def *= 1.3
      hp *= 1.1
      break
    case 'titan':
      hp *= 1.2
      atk *= 1.1
      spd *= 0.85
      break
    case 'wraith':
      atk *= 1.25
      def *= 0.8
      break
  }
  // And how it is doing today: look after it before sending it out.
  if (c.sick) atk *= 0.8
  if (c.fullness < HUNGRY_AT) atk *= 0.9
  if (c.mood >= 70) crit += 0.1
  else if (c.mood < 25) crit = Math.max(0, crit - 0.05)
  return {
    hp: Math.round(hp),
    atk: Math.round(atk * 10) / 10,
    def: Math.round(def * 10) / 10,
    spd: Math.round(spd * 10) / 10,
    crit
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
export const HIT_CHANCE = 0.9
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
  const ca = encodeCard(a)
  const cb = encodeCard(b)
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
    const miss = rand() >= HIT_CHANCE
    const crit = !miss && rand() < f[me].crit
    let dmg = 0
    if (!miss) {
      const swing = f[me].atk * (0.85 + rand() * 0.3) * matchup(cards[me].species, cards[foe].species)
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
