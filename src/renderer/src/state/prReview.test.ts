import { describe, it, expect, beforeEach } from 'vitest'
import { usePrReview, prKey, draftsFor, threadsFor, threadsOnLine, type ThreadLite } from './prReview'

const A = prKey('/repo/a', 1)
const B = prKey('/repo/a', 2)

const thread = (over: Partial<ThreadLite>): ThreadLite => ({
  id: 't',
  path: 'src/a.ts',
  line: 10,
  originalLine: 8,
  diffSide: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  comments: [{ author: 'me', body: 'hi' }],
  ...over
})

beforeEach(() => usePrReview.setState({ drafts: {}, threads: {} }))

describe('drafts', () => {
  it('keeps two pull requests apart', () => {
    const { addDraft } = usePrReview.getState()
    addDraft(A, { path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' })
    addDraft(B, { path: 'b.ts', line: 2, side: 'RIGHT', body: 'two' })
    const { drafts } = usePrReview.getState()
    expect(draftsFor(drafts, A).map((d) => d.body)).toEqual(['one'])
    expect(draftsFor(drafts, B).map((d) => d.body)).toEqual(['two'])
  })

  // A review is submitted in one call, so comments written in the diff editor
  // and in the panel have to accumulate in the same place.
  it('collects comments from anywhere into one review', () => {
    const { addDraft } = usePrReview.getState()
    addDraft(A, { path: 'a.ts', line: 1, side: 'RIGHT', body: 'from the panel' })
    addDraft(A, { path: 'b.ts', line: 9, side: 'LEFT', body: 'from the editor' })
    expect(draftsFor(usePrReview.getState().drafts, A)).toHaveLength(2)
  })

  it('drops one comment without disturbing the rest', () => {
    const { addDraft, removeDraft } = usePrReview.getState()
    addDraft(A, { path: 'a.ts', line: 1, side: 'RIGHT', body: 'keep' })
    addDraft(A, { path: 'a.ts', line: 2, side: 'RIGHT', body: 'drop' })
    removeDraft(A, 1)
    expect(draftsFor(usePrReview.getState().drafts, A).map((d) => d.body)).toEqual(['keep'])
  })

  it('clears one PR on submit and leaves the other alone', () => {
    const { addDraft, clearDrafts } = usePrReview.getState()
    addDraft(A, { path: 'a.ts', line: 1, side: 'RIGHT', body: 'a' })
    addDraft(B, { path: 'b.ts', line: 1, side: 'RIGHT', body: 'b' })
    clearDrafts(A)
    expect(draftsFor(usePrReview.getState().drafts, A)).toEqual([])
    expect(draftsFor(usePrReview.getState().drafts, B)).toHaveLength(1)
  })

  // The selector trap this codebase has been bitten by: a fresh array every
  // call makes useSyncExternalStore re-render forever.
  it('returns the same empty array every time for an untouched PR', () => {
    const { drafts, threads } = usePrReview.getState()
    expect(draftsFor(drafts, A)).toBe(draftsFor(drafts, B))
    expect(threadsFor(threads, A)).toBe(threadsFor(threads, B))
  })
})

describe('threadsOnLine', () => {
  const threads = [
    thread({ id: 'right10' }),
    thread({ id: 'left10', diffSide: 'LEFT' }),
    thread({ id: 'other', path: 'src/b.ts' }),
    thread({ id: 'outdated', line: null, originalLine: 42 })
  ]

  it('matches a thread by file, side and line', () => {
    expect(threadsOnLine(threads, 'src/a.ts', 10, 'RIGHT').map((t) => t.id)).toEqual(['right10'])
  })

  it('does not put a deleted-side thread on the added side', () => {
    expect(threadsOnLine(threads, 'src/a.ts', 10, 'LEFT').map((t) => t.id)).toEqual(['left10'])
  })

  // Otherwise every outdated thread belongs to no line and disappears.
  it('falls back to the original line when GitHub has dropped the current one', () => {
    expect(threadsOnLine(threads, 'src/a.ts', 42, 'RIGHT').map((t) => t.id)).toEqual(['outdated'])
  })

  it('ignores threads from other files', () => {
    expect(threadsOnLine(threads, 'src/b.ts', 10, 'RIGHT').map((t) => t.id)).toEqual(['other'])
  })
})
