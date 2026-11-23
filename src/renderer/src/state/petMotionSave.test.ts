import { describe, it, expect, beforeEach } from 'vitest'
import {
  ART,
  SPECIES_FILE_VERSION,
  designOf,
  motionOfSpecies,
  readSpeciesFile,
  sanitizeSpecies,
  useCustomSpecies,
  type CustomDesign,
  type CustomSpecies
} from './petSpecies'
import { PET_VERSION, applyCommand, briefOf, initialState, normalize, normalizeNest, withPetMotion, type PetSave } from './pet'
import { cardOf, encodeCard } from './petBattle'
import { checkMotion, type MotionSpec } from '../lib/petMotion'

// The motion editor's saves: a homemade species' `motion` in the species file
// (version 2), a pet's own `motion` in its save (version 4). Old files load
// as they were; battle codes never carry either.

const T0 = 1_700_000_000_000
const COLORS = { body: '#3c8cdc', shade: '#1e5aaa', highlight: '#80b4e8', accent: '#fac828', white: '#e2eefa' }
const ROUND = Array.from({ length: ART }, (_, y) =>
  Array.from({ length: ART }, (_, x) => ((x - 5.5) ** 2 + (y - 5.5) ** 2 <= 36 ? 'b' : '.')).join('')
)
const N = 32
const pic = (shift = 0): string[] =>
  Array.from({ length: N }, (_, y) =>
    Array.from({ length: N }, (_, x) => (y >= 10 && y < 20 && x >= 10 && x < 20 ? (x === 12 + shift ? '1' : '0') : '.')).join('')
  )
const design: CustomDesign = {
  name: '물방울',
  colors: COLORS,
  art: ROUND,
  face: { x: 3, y: 3 },
  noFace: true,
  photo: { palette: ['#111111', '#eeeeee'], rows: pic() }
}
const ID = 'u-drop1234' as const
const hop = (checkMotion({ keyframes: [{ at: 0 }, { at: 0.5, y: -4, rot: 6 }], duration_ms: 700, easing: 'ease-out', iterations: 2 }) as {
  value: MotionSpec
}).value
const species = (over: Partial<CustomSpecies> = {}): CustomSpecies => ({ ...design, id: ID, createdAt: T0, updatedAt: T0, ...over })

beforeEach(() => {
  useCustomSpecies.setState({ own: [], transient: {}, loaded: true, rev: 0 })
})

describe('the species file', () => {
  it('a version 1 file loads unchanged (no motion)', () => {
    const v1 = { version: 1, species: [species()] }
    const read = readSpeciesFile(JSON.parse(JSON.stringify(v1)))
    expect(read).toEqual([species()])
    expect('motion' in read[0]).toBe(false)
  })
  it('keeps a species motion, specs and frames, through a save and load', () => {
    const motion = { v: 1 as const, specs: { happy: hop }, frames: { idle: { fps: 3, frames: [pic(0), pic(1)] } } }
    const file = { version: SPECIES_FILE_VERSION, species: [species({ motion })] }
    expect(SPECIES_FILE_VERSION).toBe(2)
    expect(readSpeciesFile(JSON.parse(JSON.stringify(file)))).toEqual([species({ motion })])
  })
  it('drops a broken motion, not the species', () => {
    const s = sanitizeSpecies({ ...species(), motion: { v: 1, specs: { happy: { ...hop, duration_ms: 99999 } }, frames: { idle: { frames: [pic()] } } } })
    expect(s).toEqual(species())
  })
  it('frames need the picture: a 12x12 species keeps only its specs', () => {
    const { photo: _p, ...plain } = design
    void _p
    const s = sanitizeSpecies({ ...plain, noFace: false, id: ID, createdAt: T0, updatedAt: T0, motion: { v: 1, specs: { happy: hop }, frames: { idle: { frames: [pic(), pic()] } } } })
    expect(s?.motion).toEqual({ v: 1, specs: { happy: hop } })
  })
  it('the design copy, and so a battle code and a pet snapshot, leave motion out', () => {
    const s = species({ motion: { v: 1, specs: { happy: hop } } })
    expect('motion' in designOf(s)).toBe(false)
    useCustomSpecies.setState({ own: [s] })
    expect(motionOfSpecies(ID)).toEqual({ v: 1, specs: { happy: hop } })
    const pet: PetSave = { ...initialState(T0, { id: ID, design: designOf(s) }), xp: 500 }
    const withOwn = encodeCard(cardOf(pet))
    useCustomSpecies.setState({ own: [species()] })
    expect(encodeCard(cardOf(pet))).toBe(withOwn)
  })
})

describe('the pet save', () => {
  it('a version 3 pet loads unchanged, moving as its species does', () => {
    const v3 = JSON.parse(JSON.stringify({ ...initialState(T0), version: 3, xp: 1234 })) as Record<string, unknown>
    const p = normalize(v3, T0 + 1)
    expect(PET_VERSION).toBe(4)
    expect(p.version).toBe(4)
    expect('motion' in p).toBe(false)
    expect(p.xp).toBe(1234)
    const n = normalizeNest({ version: 3, active: 0, pets: [v3] }, T0 + 1)
    expect(n.pets[0].motion).toBeUndefined()
  })
  it('keeps its own motion through a save and load, read defensively', () => {
    const p = { ...initialState(T0), motion: { happy: hop, idle: { ...hop, keyframes: [] }, fly: hop } }
    expect(normalize(JSON.parse(JSON.stringify(p)), T0 + 1).motion).toEqual({ happy: hop })
    expect('motion' in normalize({ ...p, motion: { fly: hop } }, T0 + 1)).toBe(false)
  })
  it('the motion command, for that pet only, through the nest brief', () => {
    const a = { ...initialState(T0), bornAt: 5 }
    const b = { ...initialState(T0), bornAt: 6 }
    const n = { version: 3 as const, active: 0, pets: [a, b] }
    const r = applyCommand(n, { op: 'motion', index: 1, bornAt: 6, motion: { resting: hop } }, T0)
    expect(r.result).toBe('ok')
    expect(r.nest.pets[1].motion).toEqual({ resting: hop })
    expect(r.nest.pets[0]).toBe(a)
    expect(briefOf(r.nest).pets[1].motion).toEqual({ resting: hop })
    // Back to its species'.
    const r2 = applyCommand(r.nest, { op: 'motion', index: 1, bornAt: 6, motion: null }, T0)
    expect('motion' in r2.nest.pets[1]).toBe(false)
    // A command about a pet that moved is refused.
    expect(applyCommand(n, { op: 'motion', index: 1, bornAt: 5, motion: { resting: hop } }, T0).result).toBe('stale')
    // Nothing changed: the same pet.
    expect(withPetMotion(r.nest.pets[1], { resting: hop })).toBe(r.nest.pets[1])
  })
  it('a battle code is the same with or without its own motion', () => {
    const p = { ...initialState(T0), species: 'cat' as const, xp: 900 }
    expect(encodeCard(cardOf({ ...p, motion: { happy: hop } }))).toBe(encodeCard(cardOf(p)))
  })
})
