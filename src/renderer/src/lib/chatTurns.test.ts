import { describe, it, expect } from 'vitest'
import { settleStaleTurns, type TurnLike, isStaleEvent, endsOpenTurn } from './chatTurns'

const user = (text: string): TurnLike => ({
  role: 'user',
  text,
  items: [],
  done: true,
  interrupted: false,
  startedAt: 0,
  durationMs: 0
})
const answer = (text: string, done: boolean, items: unknown[] = text ? [{ type: 'text' }] : []): TurnLike => ({
  role: 'assistant',
  text,
  items,
  done,
  interrupted: false,
  startedAt: 1000,
  durationMs: 0
})

describe('settleStaleTurns', () => {
  it('drops an older bubble that never received anything', () => {
    const msgs = [user('q1'), answer('', false), user('q2'), answer('answering', false)]
    const out = settleStaleTurns(msgs, 5000)
    expect(out.map((m) => m.text)).toEqual(['q1', 'q2', 'answering'])
  })

  it('closes an older bubble that has content, as interrupted', () => {
    const out = settleStaleTurns([answer('half a reply', false), user('q'), answer('', false)], 5000)
    expect(out[0]).toMatchObject({ done: true, interrupted: true, durationMs: 4000, completedAt: 5000 })
  })

  it('leaves the running answer open', () => {
    const out = settleStaleTurns([user('q'), answer('streaming', false)], 5000)
    expect(out[1].done).toBe(false)
  })

  it('closes everything when nothing is running any more', () => {
    const out = settleStaleTurns([user('q'), answer('streaming', false)], 5000, false)
    expect(out[1]).toMatchObject({ done: true, interrupted: true })
  })

  it('leaves a settled transcript alone', () => {
    const msgs = [user('q'), answer('done', true)]
    expect(settleStaleTurns(msgs, 5000)).toEqual(msgs)
  })
})

describe('isStaleEvent', () => {
  it('keeps events for the turn that is open', () => {
    expect(isStaleEvent('t2', 't2')).toBe(false)
  })

  it('drops an event from a turn that has been left behind', () => {
    expect(isStaleEvent('t1', 't2')).toBe(true)
  })

  it('never drops what it cannot place', () => {
    expect(isStaleEvent(undefined, 't2')).toBe(false) // main did not tag it
    expect(isStaleEvent('t1', null)).toBe(false) // no turn open here
    expect(isStaleEvent(null, undefined)).toBe(false)
  })
})

describe('endsOpenTurn', () => {
  it('lets a turn end itself', () => {
    expect(endsOpenTurn('t2', 't2')).toBe(true)
  })

  it('refuses a turn that has already moved on', () => {
    expect(endsOpenTurn('t1', 't2')).toBe(false)
  })

  it('refuses an end nobody can place — main tags every one it can', () => {
    expect(endsOpenTurn(undefined, 't2')).toBe(false)
    expect(endsOpenTurn(null, 't2')).toBe(false)
  })

  it('leaves a pane with no open turn alone', () => {
    expect(endsOpenTurn(undefined, null)).toBe(true)
    expect(endsOpenTurn('t1', undefined)).toBe(true)
  })
})
