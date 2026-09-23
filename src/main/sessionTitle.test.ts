import { describe, expect, it } from 'vitest'
import { scanTitles, titleOf } from './sessionTitle'

const line = (o: unknown): string => JSON.stringify(o)
const user = (content: string): string => line({ type: 'user', message: { content } })

describe('scanTitles', () => {
  it('falls back to the opening message', () => {
    const s = scanTitles([user('버그 하나 고쳐줘'), line({ type: 'assistant', message: {} })])
    expect(titleOf(s, 48)).toBe('버그 하나 고쳐줘')
    expect(s.messages).toBe(2)
  })

  it('prefers the model summary over the opening message', () => {
    const s = scanTitles([user('버그 하나 고쳐줘'), line({ type: 'ai-title', title: '로그인 버그 수정' })])
    expect(titleOf(s, 48)).toBe('로그인 버그 수정')
  })

  it('prefers a human name over both', () => {
    const s = scanTitles([
      user('버그 하나 고쳐줘'),
      line({ type: 'ai-title', title: '로그인 버그 수정' }),
      line({ type: 'custom-title', customTitle: '급한 건' })
    ])
    expect(titleOf(s, 48)).toBe('급한 건')
  })

  it('takes the newest name when renamed twice', () => {
    const s = scanTitles([
      user('안녕'),
      line({ type: 'custom-title', customTitle: '첫 이름' }),
      line({ type: 'custom-title', customTitle: '두번째 이름' })
    ])
    expect(s.custom).toBe('두번째 이름')
  })

  it('ignores the CLI\'s synthetic messages as titles', () => {
    const s = scanTitles([user('<command-name>/resume</command-name>'), user('진짜 질문')])
    expect(s.firstUser).toBe('진짜 질문')
  })

  it('survives a half-written line', () => {
    const s = scanTitles([user('첫 줄'), '{"type":"assis', line({ type: 'ai-title', title: '제목' })])
    expect(titleOf(s, 48)).toBe('제목')
  })

  it('truncates to the caller\'s width', () => {
    const s = scanTitles([user('가'.repeat(80))])
    expect(titleOf(s, 48)).toHaveLength(49) // 48 + the ellipsis
    expect(titleOf(s, 48).endsWith('…')).toBe(true)
  })

  it('says nothing rather than guessing', () => {
    expect(titleOf(scanTitles([]), 48)).toBe('')
  })
})
