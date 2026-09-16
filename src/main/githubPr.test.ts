import { describe, it, expect } from 'vitest'
import { summariseChecks, reviewStateOf, buildStacks, toPullRequests, humanizeBranch } from './githubPr'

describe('summariseChecks', () => {
  // gh puts both shapes in one array — a CheckRun reports status+conclusion, a
  // StatusContext reports state. Reading only one is how a red PR looks green.
  it('reads a CheckRun and a StatusContext from the same array', () => {
    expect(
      summariseChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'FAILURE' }
      ])
    ).toEqual({ total: 2, passed: 1, failed: 1, pending: 0 })
  })

  it('counts a check that has not finished as pending, by either spelling', () => {
    expect(
      summariseChecks([
        { __typename: 'CheckRun', status: 'IN_PROGRESS' },
        { __typename: 'CheckRun', status: 'QUEUED' },
        { __typename: 'StatusContext', state: 'PENDING' }
      ])
    ).toEqual({ total: 3, passed: 0, failed: 0, pending: 3 })
  })

  it('treats neutral and skipped as not-a-failure', () => {
    expect(
      summariseChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }
      ])
    ).toEqual({ total: 2, passed: 2, failed: 0, pending: 0 })
  })

  it('counts a cancelled or timed-out run as failed', () => {
    expect(
      summariseChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' }
      ])
    ).toEqual({ total: 2, passed: 0, failed: 2, pending: 0 })
  })

  it('survives a PR with no checks at all', () => {
    expect(summariseChecks(null)).toEqual({ total: 0, passed: 0, failed: 0, pending: 0 })
    expect(summariseChecks([])).toEqual({ total: 0, passed: 0, failed: 0, pending: 0 })
  })
})

describe('reviewStateOf', () => {
  it('maps the decisions GitHub actually sends', () => {
    expect(reviewStateOf('APPROVED')).toBe('approved')
    expect(reviewStateOf('CHANGES_REQUESTED')).toBe('changes_requested')
    expect(reviewStateOf('REVIEW_REQUIRED')).toBe('review_required')
  })

  // A repo with no required reviewers returns "" — not null, not absent.
  it('treats an empty decision as none', () => {
    expect(reviewStateOf('')).toBe('none')
    expect(reviewStateOf(undefined)).toBe('none')
  })
})

describe('buildStacks', () => {
  const pr = (number: number, headRefName: string, baseRefName: string) => ({
    number,
    headRefName,
    baseRefName
  })

  it('puts a child directly under the PR it is based on', () => {
    const out = buildStacks([pr(2, 'feat/b', 'feat/a'), pr(1, 'feat/a', 'main')])
    expect(out.map((p) => [p.number, p.depth, p.parent])).toEqual([
      [1, 0, null],
      [2, 1, 1]
    ])
  })

  it('handles a three-deep stack', () => {
    const out = buildStacks([
      pr(3, 'feat/c', 'feat/b'),
      pr(1, 'feat/a', 'main'),
      pr(2, 'feat/b', 'feat/a')
    ])
    expect(out.map((p) => p.number)).toEqual([1, 2, 3])
    expect(out.map((p) => p.depth)).toEqual([0, 1, 2])
  })

  it('lists independent PRs newest first', () => {
    const out = buildStacks([pr(1, 'feat/a', 'main'), pr(7, 'feat/b', 'main'), pr(4, 'feat/c', 'main')])
    expect(out.map((p) => p.number)).toEqual([7, 4, 1])
    expect(out.every((p) => p.depth === 0 && p.parent === null)).toBe(true)
  })

  it('keeps two stacks apart', () => {
    const out = buildStacks([
      pr(1, 'a1', 'main'),
      pr(2, 'a2', 'a1'),
      pr(10, 'b1', 'main'),
      pr(11, 'b2', 'b1')
    ])
    expect(out.map((p) => p.number)).toEqual([10, 11, 1, 2])
  })

  // The base branch is usually just `main` and has no PR of its own.
  it('treats a PR onto a branch with no PR as a root', () => {
    const out = buildStacks([pr(5, 'feat/x', 'release/1.0')])
    expect(out).toEqual([{ ...pr(5, 'feat/x', 'release/1.0'), parent: null, depth: 0 }])
  })

  // Can't happen in git, but a malformed response must not hang or lose rows.
  it('emits every PR exactly once even if the bases form a cycle', () => {
    const out = buildStacks([pr(1, 'a', 'b'), pr(2, 'b', 'a')])
    expect(out.map((p) => p.number).sort()).toEqual([1, 2])
  })
})

describe('toPullRequests', () => {
  const raw = [
    {
      number: 1,
      title: 'mine',
      url: 'u1',
      author: { login: 'me' },
      headRefName: 'feat/a',
      baseRefName: 'main',
      isDraft: false,
      reviewDecision: 'APPROVED',
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      reviewRequests: [],
      updatedAt: 't1'
    },
    {
      number: 2,
      title: 'theirs, waiting on me',
      url: 'u2',
      author: { login: 'other' },
      headRefName: 'feat/b',
      baseRefName: 'main',
      isDraft: false,
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [],
      reviewRequests: [{ login: 'me' }],
      updatedAt: 't2'
    }
  ]

  it('separates my PRs from the ones waiting on my review', () => {
    const out = toPullRequests(raw, 'me')
    const mine = out.find((p) => p.number === 1)!
    const theirs = out.find((p) => p.number === 2)!
    expect([mine.isMine, mine.needsMyReview]).toEqual([true, false])
    expect([theirs.isMine, theirs.needsMyReview]).toEqual([false, true])
  })

  // Without a login nothing can be attributed — and guessing would put someone
  // else's PR in the user's own section.
  it('claims nothing when the viewer is unknown', () => {
    const out = toPullRequests(raw, null)
    expect(out.some((p) => p.isMine || p.needsMyReview)).toBe(false)
  })

  it('carries the check and review summary through', () => {
    const mine = toPullRequests(raw, 'me').find((p) => p.number === 1)!
    expect(mine.review).toBe('approved')
    expect(mine.checks).toEqual({ total: 1, passed: 1, failed: 0, pending: 0 })
  })
})

describe('humanizeBranch', () => {
  it('reads a branch name as a sentence', () => {
    expect(humanizeBranch('feat/kill-port')).toBe('Kill port')
    expect(humanizeBranch('fix/pr_review_layout')).toBe('Pr review layout')
  })

  it('keeps a branch that is already a word', () => {
    expect(humanizeBranch('main')).toBe('Main')
  })

  it('uses the last segment of a nested branch', () => {
    expect(humanizeBranch('users/hs/feat/new-thing')).toBe('New thing')
  })

  it('gives back something rather than nothing for an odd name', () => {
    expect(humanizeBranch('feat/')).toBe('feat/')
  })
})
