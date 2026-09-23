import { describe, expect, it } from 'vitest'
import { AUTO_TURN_WINDOW_MS, claimResult, noteBackgroundReport, type TurnQueue } from './turnClaim'

const q = (over: Partial<TurnQueue> = {}): TurnQueue => ({
  turns: [],
  autoTurns: 0,
  autoTurnAt: 0,
  ...over
})

describe('claimResult', () => {
  it('answers the oldest unanswered message', () => {
    const s = q({ turns: ['a', 'b'] })
    expect(claimResult(s)).toBe('a')
    expect(s.turns).toEqual(['b'])
  })

  it('returns null when nothing is waiting', () => {
    expect(claimResult(q())).toBeNull()
  })

  it('lets a background report consume its own result', () => {
    const s = q()
    noteBackgroundReport(s, 1000)
    // The message the user sends while the CLI is reporting the task.
    s.turns.push('user-1')
    expect(claimResult(s, 1500)).toBeNull()
    expect(s.turns).toEqual(['user-1']) // still unanswered, as it should be
    expect(claimResult(s, 9000)).toBe('user-1')
  })

  it('ignores a task that finishes mid-turn', () => {
    // The CLI folds it into the running turn — no extra result to account for.
    const s = q({ turns: ['user-1'] })
    noteBackgroundReport(s, 1000)
    expect(s.autoTurns).toBe(0)
    expect(claimResult(s, 1200)).toBe('user-1')
  })

  it('accounts for one result per report', () => {
    const s = q()
    noteBackgroundReport(s, 1000)
    noteBackgroundReport(s, 1100)
    s.turns.push('user-1')
    expect(claimResult(s, 1200)).toBeNull()
    expect(claimResult(s, 1300)).toBeNull()
    expect(claimResult(s, 1400)).toBe('user-1')
  })

  it('stops expecting a report that never arrives', () => {
    const s = q({ turns: ['user-1'] })
    noteBackgroundReport(s, 1000) // (queue emptied below, as if that turn ended)
    s.turns.length = 0
    noteBackgroundReport(s, 1000)
    s.turns.push('user-1')
    const late = 1000 + AUTO_TURN_WINDOW_MS + 1
    expect(claimResult(s, late)).toBe('user-1') // the real answer still lands
    expect(s.autoTurns).toBe(0)
  })
})
