import { describe, it, expect } from 'vitest'
import { reviewPayload, submitReview, replyToThread, setThreadResolved } from './githubPrReview'

const REPO = '/tmp/nowhere'

describe('reviewPayload', () => {
  it('sends the event, the body and the commit it was written against', () => {
    expect(reviewPayload('APPROVE', 'lgtm', [], 'abc123')).toEqual({
      event: 'APPROVE',
      body: 'lgtm',
      commit_id: 'abc123'
    })
  })

  it('addresses a single-line comment by line and side', () => {
    const p = reviewPayload('COMMENT', '', [{ path: 'a.ts', line: 12, side: 'RIGHT', body: 'nit' }], 'sha')
    expect(p.comments).toEqual([{ path: 'a.ts', line: 12, side: 'RIGHT', body: 'nit' }])
  })

  // GitHub rejects a multi-line comment that names start_line without
  // start_side, and the error it returns doesn't say so.
  it('sends start_side alongside start_line for a multi-line comment', () => {
    const p = reviewPayload(
      'COMMENT',
      '',
      [{ path: 'a.ts', line: 20, startLine: 16, side: 'RIGHT', body: 'this block' }],
      'sha'
    )
    expect(p.comments).toEqual([
      { path: 'a.ts', line: 20, side: 'RIGHT', body: 'this block', start_line: 16, start_side: 'RIGHT' }
    ])
  })

  it('drops a start line that is not actually before the end line', () => {
    const p = reviewPayload(
      'COMMENT',
      '',
      [{ path: 'a.ts', line: 20, startLine: 20, side: 'RIGHT', body: 'x' }],
      'sha'
    )
    expect(p.comments).toEqual([{ path: 'a.ts', line: 20, side: 'RIGHT', body: 'x' }])
  })

  it('comments on a deleted line on the left side', () => {
    const p = reviewPayload('COMMENT', '', [{ path: 'a.ts', line: 7, side: 'LEFT', body: 'why' }], 'sha')
    expect((p.comments as Array<Record<string, unknown>>)[0].side).toBe('LEFT')
  })
})

// These publish under the user's account, so the guards run BEFORE anything is
// spawned — each of these cases must fail without touching the network.
describe('refuses to publish nonsense', () => {
  it('rejects a bad PR number', async () => {
    expect(await submitReview(REPO, 0, 'COMMENT', 'x', [], 'sha')).toEqual({
      ok: false,
      error: 'bad pr number'
    })
    expect(await submitReview(REPO, 1.5, 'COMMENT', 'x', [], 'sha')).toMatchObject({ ok: false })
  })

  it('rejects an event GitHub does not have', async () => {
    expect(await submitReview(REPO, 1, 'MERGE' as never, 'x', [], 'sha')).toEqual({
      ok: false,
      error: 'bad review event'
    })
  })

  it('refuses an empty comment review — that is a misclick, not a review', async () => {
    expect(await submitReview(REPO, 1, 'COMMENT', '   ', [], 'sha')).toEqual({
      ok: false,
      error: 'nothing to submit'
    })
    expect(await submitReview(REPO, 1, 'REQUEST_CHANGES', '', [], 'sha')).toEqual({
      ok: false,
      error: 'nothing to submit'
    })
  })

  it('rejects an id that is not a review thread', async () => {
    // A COMMENT node id, not a thread id — the mutation would fail with a
    // permissions-shaped error instead of saying what is wrong.
    expect(await replyToThread(REPO, 'PRRC_kwDOabc', 'hi')).toEqual({ ok: false, error: 'bad thread id' })
    expect(await setThreadResolved(REPO, 'nonsense', true)).toEqual({ ok: false, error: 'bad thread id' })
  })

  it('rejects an empty reply', async () => {
    expect(await replyToThread(REPO, 'PRRT_kwDOabc123', '  ')).toEqual({ ok: false, error: 'empty reply' })
  })
})
