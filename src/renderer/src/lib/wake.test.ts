import { describe, expect, it } from 'vitest'
import { wakeText, wakeTitles } from './wake'

describe('wake', () => {
  it('reads the titles back from what was sent', () => {
    const one = wakeText('리드 · 팀', 'fix it', 'done [x]')
    expect(wakeTitles(one)).toEqual(['리드 · 팀'])
    expect(wakeTitles([one, wakeText('B', 'q', 'a')].join('\n\n'))).toEqual(['리드 · 팀', 'B'])
  })
  it('leaves ordinary messages alone', () => {
    expect(wakeTitles('hello')).toBeNull()
    expect(wakeTitles('quote: [백그라운드 위임 결과 · X]')).toBeNull()
    expect(wakeTitles('[백그라운드 위임 결과 · ]')).toBeNull()
  })
})
