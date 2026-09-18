import { describe, it, expect } from 'vitest'
import { placeable } from './viewRect'

const win = { width: 1333, height: 833 }

describe('placeable', () => {
  it('accepts a panel box inside the window', () => {
    expect(placeable({ left: 223, top: 124, width: 555, height: 684 }, win)).toBe(true)
  })

  it('rejects a collapsed box', () => {
    expect(placeable({ left: 223, top: 124, width: 0, height: 0 }, win)).toBe(false)
    expect(placeable({ left: 223, top: 124, width: 555, height: 2 }, win)).toBe(false)
  })

  // What an occluded window produces: the dock's overlay never gets positioned,
  // so the panel reads as sitting below the window.
  it('rejects a box that falls outside the window', () => {
    expect(placeable({ left: 223, top: 808, width: 1110, height: 778 }, win)).toBe(false)
    expect(placeable({ left: -400, top: 124, width: 555, height: 684 }, win)).toBe(false)
  })

  it('rejects anything when the window has no size', () => {
    expect(placeable({ left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBe(false)
  })
})
