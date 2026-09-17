import { describe, it, expect } from 'vitest'
import { anchorPlacement } from './anchorPlacement'

const viewport = { width: 1200, height: 800 }
const size = { width: 200, height: 150 }

describe('anchorPlacement', () => {
  it('opens just above an anchor in the status bar', () => {
    const chip = { left: 300, top: 780, right: 340, bottom: 796 }
    expect(anchorPlacement(chip, size, viewport)).toEqual({ left: 300, top: 780 - 6 - 150 })
  })

  it('opens just below an anchor in the header', () => {
    const chip = { left: 900, top: 6, right: 940, bottom: 22 }
    expect(anchorPlacement(chip, size, viewport)).toEqual({ left: 900, top: 28 })
  })

  it('stays inside the window at the right edge', () => {
    const chip = { left: 1150, top: 6, right: 1190, bottom: 22 }
    expect(anchorPlacement(chip, size, viewport).left).toBe(1200 - 8 - 200)
  })
})
