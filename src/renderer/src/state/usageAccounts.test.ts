import { describe, it, expect } from 'vitest'
import { dedupeByDir } from './usage'

describe('dedupeByDir', () => {
  it('keeps one account per config dir', () => {
    const out = dedupeByDir([
      { id: 'a', dir: '/Users/me/.claude' },
      { id: 'b', dir: '/Users/me/.claude/' }, // same place, trailing slash
      { id: 'c', dir: '/Users/me/.claude-work' }
    ])
    expect(out.map((a) => a.id)).toEqual(['a', 'c'])
  })

  it('treats "no dir" as one account, not several', () => {
    expect(dedupeByDir([{ id: 'a' }, { id: 'b', dir: '' }, { id: 'c', dir: '/other' }]).map((a) => a.id)).toEqual([
      'a',
      'c'
    ])
  })

  it('leaves genuinely separate accounts alone', () => {
    const list = [{ id: 'a', dir: '/one' }, { id: 'b', dir: '/two' }]
    expect(dedupeByDir(list)).toEqual(list)
  })
})
