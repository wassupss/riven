// Saves as earlier rivens wrote pet.json, for the migration tests
// (petMigration.test.ts). Shapes copied from the save format of their time;
// the numbers are made up.

const DAY = 86_400_000
export const OLD_NOW = 1_790_000_000_000

/** A homemade species' design as a v1 pet kept its snapshot. */
export const OLD_DESIGN = {
  name: '물방울',
  colors: { body: '#3c8cdc', shade: '#1e5aaa', highlight: '#80b4e8', accent: '#fac828', white: '#e2eefa' },
  art: Array.from({ length: 12 }, (_, y) =>
    Array.from({ length: 12 }, (_, x) => ((x - 5.5) ** 2 + (y - 5.5) ** 2 <= 36 ? 'b' : '.')).join('')
  ),
  face: { x: 3, y: 3 },
  noFace: false
}

/** The tamagotchi's album page: stage, form, kibble, branches. */
const oldPage = (name: string, species: string, xp: number, branches?: string[]): Record<string, unknown> => ({
  name,
  species,
  stage: 'adult',
  form: 'radiant',
  xp,
  tokens: xp * 20_000,
  ageMs: 30 * DAY,
  neglectMs: 2 * 3_600_000,
  endedAt: OLD_NOW - 40 * DAY,
  ...(branches ? { branches } : {})
})

const ALBUM = [oldPage('첫째', 'fox', 4200, ['sage1', 'sage2a']), oldPage('', 'turtle', 120)]

/** A long-raised v1 adult: past level 10, on a branch, wearing two prizes. */
export const OLD_ADULT = {
  version: 1,
  bornAt: OLD_NOW - 60 * DAY,
  species: 'dragon',
  lastTickAt: OLD_NOW - 3_600_000,
  carryTokens: 12_345,
  xp: 3500,
  totalTokens: 70_000_000,
  fullness: 12,
  mood: 30,
  neglectMs: 5 * DAY,
  feedCount: 812,
  lastFedAt: OLD_NOW - 7_200_000,
  lastPetAt: OLD_NOW - 60_000,
  name: '용용이',
  poops: 3,
  poopCarry: 17,
  illHours: 4.5,
  sick: true,
  workFrom: 0,
  plays: 14,
  wins: 6,
  lastPlayAt: OLD_NOW - DAY,
  battles: 9,
  battleWins: 5,
  fought: ['123@2026-10-01'],
  upsets: 1,
  events: ['halloween'],
  worn: ['crown', 'sparkle'],
  diet: { opus: 2000, sonnet: 1000, haiku: 300, codex: 200, other: 0 },
  evolutions: [
    { stage: 'egg', form: 'base', at: OLD_NOW - 60 * DAY },
    { stage: 'adult', form: 'radiant', at: OLD_NOW - 50 * DAY },
    { stage: 'adult', form: 'radiant', at: OLD_NOW - 20 * DAY, branch: 'sage1' }
  ],
  everSick: true,
  sickCount: 2,
  nightKibble: 400,
  history: [
    { day: '2026-09-20', kibble: 320 },
    { day: '2026-09-21', kibble: 41 }
  ],
  album: ALBUM
}

/** A v1 teen of a homemade species, with its snapshot of the design. */
export const OLD_TEEN_CUSTOM = {
  version: 1,
  bornAt: OLD_NOW - 5 * DAY,
  species: 'u-drop1234',
  custom: OLD_DESIGN,
  lastTickAt: OLD_NOW,
  carryTokens: 0,
  xp: 300,
  totalTokens: 6_000_000,
  fullness: 80,
  mood: 70,
  neglectMs: 0,
  feedCount: 40,
  lastFedAt: OLD_NOW - DAY,
  lastPetAt: 0,
  name: '',
  poops: 0,
  poopCarry: 0,
  illHours: 0,
  sick: false,
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
  diet: { opus: 0, sonnet: 0, haiku: 0, codex: 300, other: 0 },
  evolutions: [{ stage: 'teen', form: 'base', at: OLD_NOW - 2 * DAY }],
  everSick: false,
  sickCount: 0,
  nightKibble: 0,
  history: [],
  album: ALBUM
}

/** A v1 egg nobody fed. */
export const OLD_EGG = { ...OLD_TEEN_CUSTOM, species: 'cat', custom: undefined, xp: 0, totalTokens: 0, bornAt: OLD_NOW - 1000, name: '알' }

/** pet.json as the tamagotchi nest wrote it (nest version 2). */
export const OLD_NEST = { version: 2, active: 1, pets: [OLD_ADULT, OLD_TEEN_CUSTOM, OLD_EGG] }

/** pet.json from before the nest: one bare pet, from before species and branches. */
export const OLDEST_PET = {
  version: 1,
  bornAt: OLD_NOW - 90 * DAY,
  lastTickAt: OLD_NOW - DAY,
  carryTokens: 500,
  xp: 800,
  totalTokens: 16_000_000,
  fullness: 0,
  mood: 5,
  neglectMs: 40 * DAY,
  feedCount: 300,
  lastFedAt: OLD_NOW - 2 * DAY,
  lastPetAt: 0,
  name: 'mochi',
  history: [{ day: '2026-07-01', kibble: 12 }]
}
