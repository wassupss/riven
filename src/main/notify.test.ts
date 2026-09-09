import { describe, expect, it, vi } from 'vitest'

// notify.ts imports electron at module scope; the plan functions are pure, so
// stub the module rather than drag Electron into a unit test.
vi.mock('electron', () => ({
  app: { name: 'riven' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: () => {} },
  Notification: { isSupported: () => false }
}))

const { computePlan, reserveCooldown, PRESENCE_THRESHOLD_MS } = await import('./notify')

const now = 1_000_000
const present = (over: Partial<Parameters<typeof computePlan>[0][number]> = {}) => ({
  visible: true,
  focused: true,
  activePane: null,
  at: now,
  ...over
})

describe('computePlan', () => {
  it('suppresses when a present, visible, focused window shows that pane', () => {
    const plan = computePlan([present({ activePane: 'term-3' })], 'term-3', now)
    expect(plan).toEqual({ recipient: null, suppressed: true })
  })

  it('does not suppress for a window that is unfocused, even on that pane', () => {
    const plan = computePlan([present({ activePane: 'term-3', focused: false })], 'term-3', now)
    expect(plan).toEqual({ recipient: 0, suppressed: false })
  })

  it('picks the most recently active present window', () => {
    const plan = computePlan(
      [present({ at: now - 50_000 }), present({ at: now - 1_000 }), present({ at: now - 20_000 })],
      'term-1',
      now
    )
    expect(plan.recipient).toBe(1)
  })

  it('a window idle past the presence threshold is not a recipient', () => {
    const plan = computePlan([present({ at: now - PRESENCE_THRESHOLD_MS - 1 })], 'term-1', now)
    expect(plan).toEqual({ recipient: null, suppressed: false })
  })

  it('a clock ahead of main cannot make a window look present forever', () => {
    const plan = computePlan([present({ at: now + 999_999 })], 'term-1', now)
    expect(plan.recipient).toBe(0)
  })

  it('a focused window on a DIFFERENT pane still gets the notification', () => {
    const plan = computePlan([present({ activePane: 'chat-9' })], 'term-3', now)
    expect(plan).toEqual({ recipient: 0, suppressed: false })
  })
})

describe('reserveCooldown', () => {
  it('lets the first through and blocks a repeat within the window', () => {
    const m = new Map<string, number>()
    expect(reserveCooldown(m, 'term-1', now)).toBe(true)
    expect(reserveCooldown(m, 'term-1', now + 100)).toBe(false)
    expect(reserveCooldown(m, 'term-2', now + 100)).toBe(true)
    expect(reserveCooldown(m, 'term-1', now + 5_001)).toBe(true)
  })
})

// The bug this pins down: TerminalPanel used to call notify.show(title, body)
// with no options, so paneId was undefined for every terminal bell/done. Both
// the suppression rule and the click deep-link are gated on it, which made a
// terminal notification unsuppressable and inert when clicked.
describe('a request with no paneId', () => {
  it('is NOT suppressed even by the window the user is looking at', () => {
    const focusedOnThatPane = present({ activePane: 'term-7' })
    expect(computePlan([focusedOnThatPane], 'term-7', now)).toEqual({
      recipient: null,
      suppressed: true
    })
    // …but without the id, the same state notifies anyway.
    expect(computePlan([focusedOnThatPane], null, now)).toEqual({
      recipient: 0,
      suppressed: false
    })
  })

  it('shares one cooldown key across panes, so distinct panes silence each other', () => {
    // paneId absent → show() falls back to the title, which for terminals is
    // per-pane, but for any two callers sharing a title it collapses them.
    const m = new Map<string, number>()
    expect(reserveCooldown(m, 'Claude', now)).toBe(true)
    expect(reserveCooldown(m, 'Claude', now + 100)).toBe(false)
    // With ids they stay independent.
    const m2 = new Map<string, number>()
    expect(reserveCooldown(m2, 'term-1', now)).toBe(true)
    expect(reserveCooldown(m2, 'term-2', now + 100)).toBe(true)
  })
})
