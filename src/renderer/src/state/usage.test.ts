import { describe, it, expect } from 'vitest'
import { pickAccount, tightestLimit, type AccountUsage, type PlanLimit } from './usage'

const limit = (usedPct: number): PlanLimit => ({ usedPct, resetsAt: null })
const limits = (session: PlanLimit | null, weekly: PlanLimit | null): AccountUsage['limits'] => ({
  session,
  weekly
})

const acct = (id: string, cli: 'claude' | 'codex', limits?: AccountUsage['limits']): AccountUsage => ({
  id,
  cli,
  label: id,
  today: null,
  limits: limits ?? null
})

describe('pickAccount', () => {
  const work = acct('work', 'claude')
  const personal = acct('personal', 'claude')
  const codex = acct('codex', 'codex')

  it("uses the workspace's own profile when it has one", () => {
    expect(
      pickAccount([work, personal], {
        byWorkspace: { '/w/a': 'personal' },
        globalId: 'work',
        workspace: '/w/a'
      })?.id
    ).toBe('personal')
  })

  it('falls back to the global default for a workspace with no override', () => {
    expect(
      pickAccount([work, personal], { byWorkspace: {}, globalId: 'personal', workspace: '/w/b' })?.id
    ).toBe('personal')
  })

  // The override names a profile that has been deleted since: show something
  // real rather than nothing.
  it('falls back to a claude account when the wanted id is gone', () => {
    expect(
      pickAccount([work, codex], { byWorkspace: { '/w/a': 'deleted' }, globalId: null, workspace: '/w/a' })
        ?.id
    ).toBe('work')
  })

  it('has nothing to show before any account has reported', () => {
    expect(pickAccount([], { byWorkspace: {}, globalId: 'work', workspace: '/w/a' })).toBeNull()
  })
})

describe('tightestLimit', () => {
  // A weekly figure shown while the 5-hour session is nearly spent would be
  // reassuring and wrong — the session is what stops you working.
  it('picks the more-used of the two windows', () => {
    expect(tightestLimit(acct('x', 'claude', limits(limit(92), limit(40))))?.usedPct).toBe(92)
    expect(tightestLimit(acct('y', 'claude', limits(limit(10), limit(75))))?.usedPct).toBe(75)
  })

  it('uses whichever single window the account reports', () => {
    expect(tightestLimit(acct('x', 'codex', limits(null, limit(33))))?.usedPct).toBe(33)
    expect(tightestLimit(acct('x', 'claude', limits(limit(12), null)))?.usedPct).toBe(12)
  })

  it('has no bar to draw when the plan reports no window', () => {
    expect(tightestLimit(acct('x', 'claude'))).toBeNull()
    expect(tightestLimit(acct('x', 'claude', limits(null, null)))).toBeNull()
    expect(tightestLimit(null)).toBeNull()
  })
})
