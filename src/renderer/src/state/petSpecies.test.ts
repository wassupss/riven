import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  ART,
  buildOfDesign,
  customOf,
  familyOfDesign,
  isCustomId,
  newCustomId,
  noteDesign,
  packDesign,
  readSpeciesFile,
  sanitizeDesign,
  unpackDesign,
  useCustomSpecies,
  type CustomDesign,
  type CustomSpeciesId
} from './petSpecies'
import {
  SPECIES,
  adopt,
  archive,
  drawSpecies,
  initialState,
  normalize,
  normalizeNest,
  refreshCustom,
  restart,
  speciesName,
  type PetSave
} from './pet'
import { cardOf, decodeCard, encodeCard, familyOf, fight, matchup, type BattleCard } from './petBattle'
import { statsOf } from './petLevel'
import { answer, type TalkFacts } from './petTalk'

const T0 = 1_700_000_000_000
const COLORS = { body: '#3c8cdc', shade: '#1e5aaa', highlight: '#80b4e8', accent: '#fac828', white: '#e2eefa' }
const fill = (f: (x: number, y: number) => string): string[] =>
  Array.from({ length: ART }, (_, y) => Array.from({ length: ART }, (_, x) => f(x, y)).join(''))
const ROUND = fill((x, y) => ((x - 5.5) ** 2 + (y - 5.5) ** 2 <= 36 ? ((x + y) % 4 === 0 ? 'a' : 'b') : '.'))
const design = (over: Partial<CustomDesign> = {}): CustomDesign => ({
  name: '물방울',
  colors: COLORS,
  art: ROUND,
  face: { x: 3, y: 3 },
  noFace: false,
  ...over
})
const ID: CustomSpeciesId = 'u-drop1234'

beforeEach(() => {
  useCustomSpecies.setState({ own: [], transient: {}, loaded: true, rev: 0 })
})

describe('designs', () => {
  it('reads a design back as it was written', () => {
    expect(sanitizeDesign(JSON.parse(JSON.stringify(design())))).toEqual(design())
  })

  it('refuses what cannot be drawn', () => {
    expect(sanitizeDesign(null)).toBeNull()
    expect(sanitizeDesign(design({ name: '  ' }))).toBeNull()
    expect(sanitizeDesign(design({ colors: { ...COLORS, body: 'red' } }))).toBeNull()
    expect(sanitizeDesign(design({ art: ROUND.slice(1) }))).toBeNull()
    expect(sanitizeDesign(design({ art: ROUND.map((r) => r.replace('b', 'x')) }))).toBeNull()
    // A speck is not an animal.
    expect(sanitizeDesign(design({ art: fill((x, y) => (x < 2 && y < 2 ? 'b' : '.')) }))).toBeNull()
  })

  it('clamps a face that was moved off the art', () => {
    expect(sanitizeDesign(design({ face: { x: 40, y: -3 } }))!.face).toEqual({ x: ART - 6, y: 0 })
  })

  it('packs small for a battle code, and unpacks to the same design', () => {
    const packed = packDesign(design())
    expect(JSON.stringify(packed).length).toBeLessThan(250)
    expect(unpackDesign(packed)).toEqual(design())
    expect(unpackDesign(['x', 'zz', '', 0, 0, 0])).toBeNull()
  })

  it('makes ids that read as custom and never as a built-in animal', () => {
    const id = newCustomId(T0, 0.5)
    expect(isCustomId(id)).toBe(true)
    for (const s of SPECIES) expect(isCustomId(s)).toBe(false)
    expect(isCustomId('u-../../x')).toBe(false)
  })

  it('reads the store file defensively', () => {
    const good = { ...design(), id: ID, createdAt: T0, updatedAt: T0 }
    expect(readSpeciesFile({ version: 1, species: [good, { ...good }, { id: 'bad' }, null] })).toEqual([good])
    expect(readSpeciesFile(null)).toEqual([])
    expect(readSpeciesFile({ species: 'nope' })).toEqual([])
  })

  it('looks a species up in the keeper own list first, then in what is known for now', () => {
    expect(customOf(ID)).toBeNull()
    noteDesign(ID, design({ name: 'snapshot' }))
    expect(customOf(ID)!.name).toBe('snapshot')
    useCustomSpecies.setState({ own: [{ ...design({ name: 'own' }), id: ID, createdAt: T0, updatedAt: T0 }] })
    expect(customOf(ID)!.name).toBe('own')
    expect(customOf('cat')).toBeNull()
  })
})

describe('the shared file', () => {
  it('is read on load and written on every change, never before it was read', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const saved: Array<[string, unknown]> = []
    const file = { version: 1, species: [{ ...design({ name: 'a' }), id: 'u-aaaa1', createdAt: T0, updatedAt: T0 }] }
    vi.stubGlobal('window', {
      api: {
        store: {
          loadAll: async () => ({ 'pet-species': file, auth: { secret: 'x' } }),
          save: async (name: string, data: unknown) => void saved.push([name, data])
        }
      }
    })
    try {
      useCustomSpecies.setState({ own: [], transient: {}, loaded: false, rev: 0 })
      const st = useCustomSpecies.getState()
      st.put({ ...design({ name: 'early' }), id: 'u-bbbb1', createdAt: T0, updatedAt: T0 })
      expect(saved).toEqual([])
      await st.load()
      expect(useCustomSpecies.getState().own.map((o) => o.name)).toEqual(['a'])
      useCustomSpecies.getState().put({ ...design({ name: 'b' }), id: 'u-bbbb1', createdAt: T0, updatedAt: T0 })
      expect(saved.at(-1)![0]).toBe('pet-species')
      expect(readSpeciesFile(saved.at(-1)![1]).map((o) => o.name)).toEqual(['a', 'b'])
      useCustomSpecies.getState().remove('u-aaaa1')
      useCustomSpecies.getState().remove('u-bbbb1')
      // The last one gone: the file goes too.
      expect(saved.at(-1)).toEqual(['pet-species', null])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the family and build a photo gives', () => {
  it('reads the family off the main colour', () => {
    expect(familyOfDesign(design())).toBe('sea')
    expect(familyOfDesign(design({ colors: { ...COLORS, body: '#ef903b' } }))).toBe('spark')
    expect(familyOfDesign(design({ colors: { ...COLORS, body: '#6b4a2b' } }))).toBe('wild')
    expect(familyOfDesign(design({ colors: { ...COLORS, body: '#232630' } }))).toBe('wild')
    expect(familyOfDesign(design({ colors: { ...COLORS, body: '#4caf50' } }))).toBe('wild')
  })

  it('measures its build from -1 (lanky) to 1 (round)', () => {
    expect(buildOfDesign(design({ art: fill(() => 'b') }))).toBe(1)
    const pole = buildOfDesign(design({ art: fill((x, y) => (x === y || x === 11 - y || (x >= 5 && x <= 6) ? 'b' : '.')) }))
    expect(pole).toBe(-1)
    const round = buildOfDesign(design())
    expect(round).toBeGreaterThan(-1)
    expect(round).toBeLessThan(1)
  })
})

describe('pets of a custom species', () => {
  const hatch = { id: ID, design: design() }

  it('arrive as their species, with a snapshot of the design', () => {
    const p = initialState(T0, hatch)
    expect(p.species).toBe(ID)
    expect(p.custom).toEqual(design())
    expect(p.xp).toBe(0)
    // A random draw stays among the built-in animals.
    for (let i = 0; i < 20; i++) expect(SPECIES).toContain(drawSpecies(i / 20))
  })

  it('can be adopted into the nest or started over as', () => {
    const n = normalizeNest(null, T0)
    const more = adopt(n, T0, hatch)
    expect(more.pets[1].species).toBe(ID)
    // Starting one over keeps its species and its snapshot.
    const again = restart(more, T0 + 1, 1)
    expect(again.pets[1].species).toBe(ID)
    expect(again.pets[1].custom).toEqual(design())
  })

  it('survive a reload, and the species being deleted', () => {
    const saved = JSON.parse(JSON.stringify(initialState(T0, hatch)))
    const back = normalize(saved, T0 + 1000)
    expect(back.species).toBe(ID)
    expect(back.custom).toEqual(design())
    // Nothing in the keeper's list: still drawable from its own snapshot.
    expect(customOf(ID)).toBeNull()
    expect(normalizeNest({ version: 2, active: 0, pets: [saved] }, T0).pets[0].species).toBe(ID)
  })

  it('fall back like an old save when the snapshot is missing', () => {
    const saved = { ...JSON.parse(JSON.stringify(initialState(T0, hatch))), custom: undefined }
    expect(SPECIES).toContain(normalize(saved, T0).species)
  })

  it('follow an edit of their species, and keep the last look after a delete', () => {
    const pets = [initialState(T0, hatch), initialState(T0)]
    const edited = { ...design({ name: '새 이름' }), id: ID, createdAt: T0, updatedAt: T0 + 1 }
    const next = refreshCustom(pets, [edited])
    expect(next[0].custom!.name).toBe('새 이름')
    expect(next[1]).toBe(pets[1])
    expect(refreshCustom(next, [edited])).toBe(next)
    // Deleted: the list no longer has it, the pet keeps what it had.
    expect(refreshCustom(next, [])).toBe(next)
  })

  it('are named by their maker, in the album too', () => {
    const t = (k: string): string => `T:${k}`
    expect(speciesName(ID, t, design())).toBe('물방울')
    expect(speciesName('cat', t)).toBe('T:pet.species.cat')
    const fed: PetSave = { ...initialState(T0, hatch), xp: 20 }
    expect(archive(fed, T0 + 1000).slice(-1)[0].speciesName).toBe('물방울')
  })
})

describe('custom species in battle', () => {
  const base: BattleCard = {
    name: '',
    species: 'cat',
    level: 10,
    stats: statsOf(10, 'cat'),
    bornAt: T0
  }
  const mine: BattleCard = { ...base, name: '방울', species: ID, stats: statsOf(10, ID, null, design()), custom: design() }

  it('travels with its design and comes back the same', () => {
    const code = encodeCard(mine)
    expect(decodeCard(code)).toEqual(mine)
    expect(code.length).toBeLessThan(700)
  })

  it('is refused without its design or with a broken one', () => {
    const bare = encodeCard({ ...mine, custom: undefined })
    expect(decodeCard(bare)).toBeNull()
  })

  it('carries its design on a card made from the pet', () => {
    const p: PetSave = { ...initialState(T0, { id: ID, design: design() }), xp: 900 }
    const c = cardOf(p)
    expect(c.custom).toEqual(design())
    expect(decodeCard(encodeCard(c))!.custom).toEqual(design())
  })

  it('fights for the family its colours give, on both machines', () => {
    // A blue one is sea: a paw catches it, it shorts out a spark.
    expect(familyOf(ID, mine)).toBe('sea')
    expect(matchup('cat', ID, base, mine)).toBeGreaterThan(1)
    expect(matchup(ID, 'bird', mine, { ...base, species: 'bird' })).toBeGreaterThan(1)
    // The friend has never seen it: the card alone decides.
    expect(customOf(ID)).toBeNull()
    const foe = decodeCard(encodeCard(mine))!
    expect(familyOf(foe.species, foe)).toBe('sea')
  })

  it('leans by its build, and adds up like any other pet', () => {
    const round = statsOf(30, ID, null, design({ art: fill(() => 'b') }))
    const lanky = statsOf(30, ID, null, design({ art: fill((x, y) => (x === y || x === 11 - y || (x >= 5 && x <= 6) ? 'b' : '.')) }))
    expect(round.stamina).toBeGreaterThan(lanky.stamina)
    expect(lanky.speed).toBeGreaterThan(round.speed)
    const sum = (x: typeof round): number => x.power + x.smarts + x.speed + x.stamina
    expect(sum(round)).toBe(sum(statsOf(30, 'cat')))
    expect(sum(lanky)).toBe(sum(round))
  })

  it('is the same fight from either side', () => {
    const foe: BattleCard = { ...base, name: '나비', species: 'bird', bornAt: T0 + 5 }
    const a = fight(mine, foe)
    const b = fight(foe, mine)
    expect(a.winner === null ? null : 1 - a.winner).toBe(b.winner)
    expect(a.blows.map((w) => w.dmg)).toEqual(b.blows.map((w) => w.dmg))
  })
})

describe('custom species in talk', () => {
  const t = ((key: string, arg1?: unknown): string => {
    const params = typeof arg1 === 'object' && arg1 !== null ? arg1 : undefined
    return params ? `${key}(${JSON.stringify(params)})` : key
  }) as TalkFacts['t']

  it('says what it is by its own name, and where it came from', () => {
    const pet = initialState(T0, { id: ID, design: design() })
    const said = answer('너 몇살이야', {
      pet,
      now: T0 + 60_000,
      busy: [],
      recent: [],
      todayTokens: 0,
      limit: null,
      editedFiles: 0,
      dur: () => '1분',
      fmt: (n) => `${n}`,
      t
    })
    expect(said.topic).toBe('self')
    expect(said.text).toContain('"species":"물방울"')
    expect(said.text).toContain('pet.talk.custom')
  })
})
