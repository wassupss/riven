import { describe, expect, it } from 'vitest'
import { activityOf, type Live } from './rosterActivity'

// The completion rule the rail and the panel both render from. The invariant
// that matters: `done` is raised by the AGENT finishing and cleared ONLY by the
// user acknowledging it — never by a pane becoming visible, a window regaining
// focus, or a workspace re-mounting.

const live = (l: Live): Live => l

describe('activityOf priority', () => {
  it('running beats everything', () => {
    expect(activityOf(live({ busy: true, done: true }), null).status).toBe('busy')
    expect(activityOf(live({ busy: true, attention: 'needs_input' }), null).status).toBe('busy')
  })

  it('needs_input is waiting; finished is done', () => {
    expect(activityOf(live({ attention: 'needs_input' }), null).status).toBe('waiting')
    expect(activityOf(live({ attention: 'finished' }), null).status).toBe('done')
    // "finished" must not read as "waiting on you" — they mean different things
    // to the card's dot.
    expect(activityOf(live({ attention: 'finished' }), null).attention).toBe(false)
    expect(activityOf(live({ attention: 'needs_input' }), null).attention).toBe(true)
  })

  it('nothing at all is idle', () => {
    expect(activityOf(live({}), null).status).toBe('idle')
    expect(activityOf(live({ agent: true }), null).status).toBe('idle')
  })

  it("a new turn supersedes the previous turn's completion", () => {
    expect(activityOf(live({ done: true, busy: true }), null).done).toBe(false)
  })
})

describe('done survives what it must', () => {
  it('is reported with no mounted panel at all', () => {
    // The workspace was evicted by the LRU: no controller, only main's stream.
    expect(activityOf(live({ done: true }), null).status).toBe('done')
  })

  it('a mounted panel that reports done also counts', () => {
    expect(activityOf(live({}), 'done').status).toBe('done')
  })

  it('an idle mounted panel does not erase a completion the roster recorded', () => {
    // Exactly the re-mount case: the controller starts at 'idle' because its
    // status map was dropped on unmount, but the turn did finish.
    expect(activityOf(live({ done: true }), 'idle').status).toBe('done')
  })

  it('is gone once acknowledged', () => {
    expect(activityOf(live({ done: false }), 'idle').status).toBe('idle')
  })
})
