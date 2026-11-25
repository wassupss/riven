import { describe, expect, it } from 'vitest'
import { revealCount } from './textDrain'

describe('revealCount', () => {
  it('reveals nothing from an empty buffer', () => {
    expect(revealCount('', 16, 0.12)).toBe(0)
  })

  it('reveals at least one character even when the rate is tiny', () => {
    expect(revealCount('abc', 8, 0.0001)).toBe(1)
  })

  it('never reveals more than the buffer holds', () => {
    expect(revealCount('hi', 50, 5)).toBe(2)
  })

  it('scales with frame gap and rate', () => {
    // 0.1 chars/ms * 20ms * 1.05 = 2.1 -> 2
    expect(revealCount('x'.repeat(100), 20, 0.1)).toBe(2)
  })

  it('drains a large backlog proportionally faster', () => {
    const buf = 'x'.repeat(1200)
    expect(revealCount(buf, 16, 0.12)).toBe(100) // ceil(1200 / 12)
  })

  it('breaks after a nearby space so words do not split', () => {
    const buf = 'hello world again'
    // n = round(0.1 * 16 * 1.05) = 2 -> next space at index 5 is 3 away (<= 12): reveal "hello "
    expect(revealCount(buf, 16, 0.1)).toBe(6)
  })
})
