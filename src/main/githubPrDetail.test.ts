import { describe, it, expect } from 'vitest'
import { toConversation, flattenPages, toCheckRuns } from './githubPrDetail'

describe('toConversation', () => {
  it('puts reviews and comments on one timeline, oldest first', () => {
    const out = toConversation(
      [{ author: { login: 'kim' }, body: 'LGTM with one nit', submittedAt: '2026-09-10T10:00:00Z', state: 'APPROVED' }],
      [{ author: { login: 'lee' }, body: 'why this approach?', createdAt: '2026-09-09T09:00:00Z' }]
    )
    expect(out.map((i) => [i.kind, i.author, i.state ?? null])).toEqual([
      ['comment', 'lee', null],
      ['review', 'kim', 'APPROVED']
    ])
  })

  // The shell GitHub creates to carry line comments: no body, state COMMENTED.
  // Its comments are already shown on their lines.
  it('leaves out the empty review that only carries line comments', () => {
    expect(
      toConversation([{ author: { login: 'kim' }, body: '', submittedAt: 't', state: 'COMMENTED' }], [])
    ).toEqual([])
  })

  // A verdict with nothing written is still a verdict — it is the thing the
  // author most needs to see.
  it('keeps an approval or a change request even with no text', () => {
    const out = toConversation(
      [
        { author: { login: 'a' }, body: '', submittedAt: '1', state: 'APPROVED' },
        { author: { login: 'b' }, body: '', submittedAt: '2', state: 'CHANGES_REQUESTED' }
      ],
      []
    )
    expect(out.map((i) => i.state)).toEqual(['APPROVED', 'CHANGES_REQUESTED'])
  })

  it('does not show a review that was never submitted', () => {
    expect(toConversation([{ author: { login: 'a' }, body: 'draft', submittedAt: '1', state: 'PENDING' }], [])).toEqual([])
  })

  it('skips an empty comment and survives missing arrays', () => {
    expect(toConversation(null, [{ author: { login: 'a' }, body: '  ', createdAt: '1' }])).toEqual([])
    expect(toConversation(undefined, undefined)).toEqual([])
  })
})

describe('flattenPages', () => {
  it('flattens --slurp output (one array per page)', () => {
    expect(flattenPages([[1, 2], [3]])).toEqual([1, 2, 3])
  })
  it('accepts a single page too', () => {
    expect(flattenPages([1, 2])).toEqual([1, 2])
  })
})

describe('toCheckRuns', () => {
  // Different key names for the same ideas; both must come out the same shape.
  it('reads a CheckRun and a StatusContext into one shape', () => {
    expect(
      toCheckRuns([
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u1' },
        { __typename: 'StatusContext', context: 'Vercel', state: 'PENDING', targetUrl: 'u2' }
      ])
    ).toEqual([
      { name: 'lint', state: 'SUCCESS', url: 'u1' },
      { name: 'Vercel', state: 'PENDING', url: 'u2' }
    ])
  })
})
