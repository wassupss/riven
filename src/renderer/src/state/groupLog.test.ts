import { describe, it, expect } from 'vitest'
import { activeEdges, append, clip, LOG_CAP, type GroupEvent } from './groupLog'

const ev = (n: number): GroupEvent => ({
  id: `e${n}`,
  ws: '/w',
  group: 'team',
  at: n,
  kind: 'ask',
  from: 'a',
  text: String(n)
})

describe('clip', () => {
  it('keeps an exchange readable on one line', () => {
    expect(clip('  hello\n\n  world  ')).toBe('hello world')
  })

  it('will not let one message fill the whole view', () => {
    const out = clip('x'.repeat(500))
    expect(out.length).toBe(401)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('append', () => {
  it('keeps the newest entries when the log is full', () => {
    let list: GroupEvent[] = []
    for (let i = 0; i < LOG_CAP + 5; i++) list = append(list, ev(i))
    expect(list.length).toBe(LOG_CAP)
    expect(list[0].text).toBe('5')
    expect(list[list.length - 1].text).toBe(String(LOG_CAP + 4))
  })

  it('leaves a short log alone', () => {
    expect(append([ev(1)], ev(2)).map((e) => e.text)).toEqual(['1', '2'])
  })
})

describe('activeEdges', () => {
  const e = (kind: GroupEvent['kind'], from: string, to?: string, at = 0): GroupEvent => ({
    id: `${kind}${from}${to}${at}`,
    ws: '/w',
    group: 'team',
    at,
    kind,
    from,
    to,
    text: ''
  })

  it('marks a delegation that has not been answered', () => {
    expect([...activeEdges([e('ask', 'lead', 'one', 1)])]).toEqual(['lead>one'])
  })

  it('clears it when the answer comes back', () => {
    expect(activeEdges([e('ask', 'lead', 'one', 1), e('reply', 'one', undefined, 2)]).size).toBe(0)
  })

  it('clears it when the delegation failed', () => {
    expect(activeEdges([e('ask', 'lead', 'one', 1), e('error', 'one', 'lead', 2)]).size).toBe(0)
  })

  it('follows several at once, and the newest asker of a member', () => {
    const out = activeEdges([
      e('ask', 'lead', 'one', 1),
      e('ask', 'lead', 'two', 2),
      e('reply', 'one', undefined, 3),
      e('ask', 'two', 'three', 4)
    ])
    expect([...out].sort()).toEqual(['lead>two', 'two>three'])
  })

  it('ignores a post with nobody to send it to', () => {
    expect(activeEdges([e('ask', 'user', undefined, 1)]).size).toBe(0)
  })
})
