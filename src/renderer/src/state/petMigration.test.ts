import { describe, it, expect } from 'vitest'
import { NEST_VERSION, PET_VERSION, initialState, normalize, normalizeNest, speciesFromBirth, type PetSave } from './pet'
import { levelOf } from './petLevel'
import { OLDEST_PET, OLD_ADULT, OLD_DESIGN, OLD_EGG, OLD_NEST, OLD_NOW, OLD_TEEN_CUSTOM } from './petSave.fixtures'

// pet.json as the tamagotchi wrote it has to load as the levelling pet: every
// pet kept, with its name, animal, homemade design, prizes, records and the
// album, its lifetime kibble as XP, and nothing of hunger or evolution left.

const NOW = OLD_NOW + 60_000
/** What a save looks like once it has been written and read back. */
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('migrating a version 1 nest', () => {
  const nest = normalizeNest(roundTrip(OLD_NEST), NOW)

  it('keeps every pet, in order, with the same one out', () => {
    expect(nest.version).toBe(NEST_VERSION)
    expect(nest.active).toBe(1)
    expect(nest.pets.map((p) => [p.name, p.species, p.bornAt])).toEqual([
      ['용용이', 'dragon', OLD_ADULT.bornAt],
      ['', 'u-drop1234', OLD_TEEN_CUSTOM.bornAt],
      ['알', 'cat', OLD_EGG.bornAt]
    ])
    for (const p of nest.pets) expect(p.version).toBe(PET_VERSION)
  })

  it('turns lifetime kibble into XP one for one, so a long-raised pet starts high', () => {
    const [adult, teen, egg] = nest.pets
    expect(adult.xp).toBe(3500)
    expect(levelOf(adult.xp).level).toBe(25)
    expect(levelOf(teen.xp).level).toBe(6)
    expect(levelOf(egg.xp).level).toBe(1)
    // A v1 adult (800 kibble, OLDEST_PET) lands at level 11.
    expect(levelOf(normalize(roundTrip(OLDEST_PET), NOW).xp).level).toBe(11)
  })

  it('keeps what it wore, its records, its breaks, its diet and its log', () => {
    const adult = nest.pets[0]
    expect(adult.worn).toEqual(['crown', 'sparkle'])
    expect(adult.events).toEqual(['halloween'])
    expect(adult).toMatchObject({
      battles: 9,
      battleWins: 5,
      upsets: 1,
      fought: ['123@2026-10-01'],
      plays: 14,
      wins: 6,
      totalTokens: 70_000_000,
      carryTokens: 12_345,
      lastFedAt: OLD_ADULT.lastFedAt
    })
    expect(adult.diet).toEqual(OLD_ADULT.diet)
    expect(adult.history).toEqual([
      { day: '2026-09-20', xp: 320 },
      { day: '2026-09-21', xp: 41 }
    ])
  })

  it('keeps a homemade animal drawable from its own snapshot', () => {
    expect(nest.pets[1].custom).toEqual(OLD_DESIGN)
  })

  it('keeps the album, each page at the level its kibble is now', () => {
    for (const p of nest.pets) expect(p.album).toBe(nest.pets[0].album)
    expect(nest.pets[0].album).toEqual([
      { name: '첫째', species: 'fox', level: levelOf(4200).level, xp: 4200, tokens: 4200 * 20_000, ageMs: 30 * 86_400_000, endedAt: OLD_NOW - 40 * 86_400_000 },
      { name: '', species: 'turtle', level: levelOf(120).level, xp: 120, tokens: 120 * 20_000, ageMs: 30 * 86_400_000, endedAt: OLD_NOW - 40 * 86_400_000 }
    ])
  })

  it('drops every field of care and evolution', () => {
    const gone = [
      'lastTickAt',
      'fullness',
      'mood',
      'neglectMs',
      'feedCount',
      'lastPetAt',
      'poops',
      'poopCarry',
      'illHours',
      'sick',
      'evolutions',
      'everSick',
      'sickCount',
      'nightKibble'
    ]
    for (const p of nest.pets) for (const k of gone) expect(k in p, k).toBe(false)
    for (const a of nest.pets[0].album)
      for (const k of ['stage', 'form', 'neglectMs', 'branches']) expect(k in a, k).toBe(false)
    // And has exactly the fields a new pet has.
    expect(Object.keys(nest.pets[0]).sort()).toEqual(Object.keys(initialState(NOW)).sort())
  })

  it('is stable: migrating a migrated save changes nothing', () => {
    const again = normalizeNest(roundTrip(nest), NOW + 1000)
    expect(again).toEqual(nest)
  })
})

describe('migrating the oldest saves', () => {
  it('reads a bare pet from before the nest and before species', () => {
    const n = normalizeNest(roundTrip(OLDEST_PET), NOW)
    expect(n.pets).toHaveLength(1)
    const p: PetSave = n.pets[0]
    expect(p.name).toBe('mochi')
    expect(p.species).toBe(speciesFromBirth(OLDEST_PET.bornAt))
    expect(p.xp).toBe(800)
    expect(p.carryTokens).toBe(500)
    expect(p.history).toEqual([{ day: '2026-07-01', xp: 12 }])
    expect(p.worn).toEqual([])
    expect(p.album).toEqual([])
  })

  it('drops album pages it cannot read rather than the whole album', () => {
    const p = normalize({ ...roundTrip(OLD_ADULT), album: [null, 'x', { name: 'ok', species: 'owl', xp: 50 }, { species: 'unicorn' }] }, NOW)
    expect(p.album.map((a) => [a.name, a.species, a.level])).toEqual([['ok', 'owl', levelOf(50).level]])
  })
})
