import { describe, it, expect } from 'vitest'
import { planMove } from './movePlan'

const DEST = '/w/dst'

describe('planMove', () => {
  it('moves a file into the destination', () => {
    expect(planMove(['/w/src/a.ts'], DEST, [])).toEqual({
      moves: [{ from: '/w/src/a.ts', to: '/w/dst/a.ts' }],
      skipped: []
    })
  })

  it('refuses a name the destination already has, rather than overwriting', () => {
    // fs.rename would replace it without a word.
    expect(planMove(['/w/src/a.ts'], DEST, ['a.ts', 'b.ts'])).toEqual({
      moves: [],
      skipped: [{ path: '/w/src/a.ts', reason: 'name-taken' }]
    })
  })

  it('skips a source that is already in the destination', () => {
    expect(planMove(['/w/dst/a.ts'], DEST, ['a.ts'])).toEqual({
      moves: [],
      skipped: [{ path: '/w/dst/a.ts', reason: 'already-there' }]
    })
  })

  it('refuses a folder dropped on itself', () => {
    expect(planMove(['/w/dst'], DEST, [])).toEqual({
      moves: [],
      skipped: [{ path: '/w/dst', reason: 'into-itself' }]
    })
  })

  it('refuses a folder dropped into its own subtree — this one loses the tree', () => {
    expect(planMove(['/w/src'], '/w/src/nested/deep', [])).toEqual({
      moves: [],
      skipped: [{ path: '/w/src', reason: 'into-itself' }]
    })
  })

  it('does not confuse a sibling with a prefix for a descendant', () => {
    // '/w/src2' starts with '/w/src' as a string but is not inside it.
    const plan = planMove(['/w/src'], '/w/src2', [])
    expect(plan.moves).toEqual([{ from: '/w/src', to: '/w/src2/src' }])
  })

  it('keeps two sources with the same base name from colliding with each other', () => {
    const plan = planMove(['/w/a/dup.ts', '/w/b/dup.ts'], DEST, [])
    expect(plan.moves).toEqual([{ from: '/w/a/dup.ts', to: '/w/dst/dup.ts' }])
    expect(plan.skipped).toEqual([{ path: '/w/b/dup.ts', reason: 'name-taken' }])
  })

  it('ignores a repeated source', () => {
    const plan = planMove(['/w/a/x.ts', '/w/a/x.ts'], DEST, [])
    expect(plan.moves).toHaveLength(1)
    expect(plan.skipped).toEqual([])
  })

  it('moves what it can and reports the rest', () => {
    const plan = planMove(['/w/src/ok.ts', '/w/src/taken.ts', '/w/dst/here.ts'], DEST, ['taken.ts'])
    expect(plan.moves).toEqual([{ from: '/w/src/ok.ts', to: '/w/dst/ok.ts' }])
    expect(plan.skipped).toEqual([
      { path: '/w/src/taken.ts', reason: 'name-taken' },
      { path: '/w/dst/here.ts', reason: 'already-there' }
    ])
  })
})
