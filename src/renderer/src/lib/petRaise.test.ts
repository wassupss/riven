import { describe, expect, it } from 'vitest'
import { listenRaise, requestRaise } from './petRaise'
import type { Hatch } from '../state/pet'

const hatch = { id: 'c-test', design: { name: 'x' } } as unknown as Hatch

describe('petRaise', () => {
  it('the window showing the pet answers', async () => {
    let got: Hatch | null = null
    const stop = listenRaise((h) => {
      got = h
      return 'ok'
    })
    expect(await requestRaise(hatch)).toBe('ok')
    expect(got).toEqual(hatch)
    stop()
  })

  it('passes a full nest back', async () => {
    const stop = listenRaise(() => 'full')
    expect(await requestRaise(hatch)).toBe('full')
    stop()
  })

  it('says none when no pet is listening', async () => {
    expect(await requestRaise(hatch, 50)).toBe('none')
  })
})
