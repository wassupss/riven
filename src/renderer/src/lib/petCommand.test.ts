import { afterEach, describe, expect, it } from 'vitest'
import { announceNest, closeAnnouncer, onNest, requestPet, servePet } from './petCommand'
import type { Hatch, NestBrief, PetCommand } from '../state/pet'

const hatch = { id: 'u-test', design: { name: 'x' } } as unknown as Hatch
const nest: NestBrief = {
  active: 0,
  pets: [{ bornAt: 1, name: 'mochi', species: 'cat', stage: 'egg', form: 'base', branch: null, level: 0 }]
}
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(() => closeAnnouncer())

describe('petCommand', () => {
  it('the window showing the pet answers, with the nest after the command', async () => {
    let got: PetCommand | null = null
    const stop = servePet((cmd) => {
      got = cmd
      return { result: 'ok', nest }
    })
    const a = await requestPet({ op: 'adopt', hatch })
    expect(a).toEqual({ result: 'ok', nest })
    expect(got).toEqual({ op: 'adopt', hatch })
    stop()
  })

  it('passes a refusal back', async () => {
    const stop = servePet(() => ({ result: 'full', nest }))
    expect((await requestPet({ op: 'adopt', hatch: null })).result).toBe('full')
    stop()
  })

  it('asks for the nest alone with a null command', async () => {
    let got: PetCommand | null | undefined
    const stop = servePet((cmd) => {
      got = cmd
      return { result: 'ok', nest }
    })
    expect((await requestPet(null)).nest).toEqual(nest)
    expect(got).toBeNull()
    stop()
  })

  it('says none when no pet is listening', async () => {
    expect(await requestPet({ op: 'select', index: 0, bornAt: 1 }, 50)).toEqual({ result: 'none', nest: null })
  })

  it('lets a list follow the nest as it is announced', async () => {
    const seen: NestBrief[] = []
    const stop = onNest((n) => seen.push(n))
    announceNest(nest)
    await tick()
    expect(seen).toEqual([nest])
    stop()
  })

  it("hears the nest in answers to someone else's command too", async () => {
    const seen: NestBrief[] = []
    const stopList = onNest((n) => seen.push(n))
    const stopPet = servePet(() => ({ result: 'ok', nest }))
    await requestPet({ op: 'select', index: 0, bornAt: 1 })
    await tick()
    expect(seen).toEqual([nest])
    stopPet()
    stopList()
  })
})
