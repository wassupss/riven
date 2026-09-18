import { describe, it, expect } from 'vitest'
import { settleStaleTurns, type TurnLike } from './chatTurns'

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
