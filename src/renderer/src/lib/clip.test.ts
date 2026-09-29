import { describe, expect, it } from 'vitest'
import { clipNotice, clipText } from './clip'

describe('clipText', () => {
  it('leaves a short answer alone', () => {
    expect(clipText('짧은 답', 100)).toEqual({ head: '짧은 답', clipped: false })
  })

  it('cuts a long one at a paragraph break near the cap', () => {
    const text = 'a'.repeat(850) + '\n\n' + 'b'.repeat(500)
    const { head, clipped } = clipText(text, 1000)
    expect(clipped).toBe(true)
    expect(head).toBe('a'.repeat(850))
  })

  it('cuts hard when there is no break to use', () => {
    const { head, clipped } = clipText('z'.repeat(5000), 1000)
    expect(clipped).toBe(true)
    expect(head.length).toBe(1000)
  })

  it('treats a cap of 0 as no cap', () => {
    expect(clipText('z'.repeat(5000), 0).clipped).toBe(false)
  })
})

describe('clipNotice', () => {
  it('tells the reader where the rest is', () => {
    expect(clipNotice(12900, 8000, '보고-1')).toContain('riven_note_read(note="보고-1")')
    expect(clipNotice(12900, 8000, null)).toContain('저장하지 못했습니다')
  })
})
