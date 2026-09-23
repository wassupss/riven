import { describe, it, expect } from 'vitest'
import { retryLabel, limitLabel, compactLabel, resetsInMinutes } from './agentNotice'

// The real translator, so a missing key would show up as a failure here.
const t = ((key: string, vars?: Record<string, string | number>): string =>
  ({
    'chat.retrying': `재시도 ${vars?.n}/${vars?.max} · ${vars?.s}초 후`,
    'chat.limitHit': '사용 한도에 걸렸습니다',
    'chat.limitNear': '사용 한도에 근접했습니다',
    'chat.limitResets': `${vars?.n}분 후 풀림`,
    'chat.compactAuto': '컨텍스트 자동 압축',
    'chat.compactManual': '컨텍스트 압축'
  })[key] ?? key) as never

describe('retryLabel', () => {
  it('says which attempt and how long it will wait', () => {
    expect(retryLabel({ attempt: 2, max: 5, delayMs: 30_000, status: null }, t)).toBe('재시도 2/5 · 30초 후')
  })

  it('names the HTTP status when there is one', () => {
    expect(retryLabel({ attempt: 1, max: 3, delayMs: 1200, status: 529 }, t)).toBe('재시도 1/3 · 1초 후 (HTTP 529)')
  })
})

describe('resetsInMinutes', () => {
  const now = 1_700_000_000_000

  it('reads the CLI\'s seconds-since-epoch', () => {
    expect(resetsInMinutes(now / 1000 + 900, now)).toBe(15)
  })

  it('also survives a value already in milliseconds', () => {
    expect(resetsInMinutes(now + 600_000, now)).toBe(10)
  })

  it('says nothing about a reset that has passed', () => {
    expect(resetsInMinutes(now / 1000 - 60, now)).toBeNull()
    expect(resetsInMinutes(undefined, now)).toBeNull()
  })
})

describe('limitLabel', () => {
  const now = 1_700_000_000_000

  it('tells a refusal from a warning', () => {
    expect(limitLabel({ status: 'rejected', resetsAt: now / 1000 + 1800 }, t, now)).toBe(
      '사용 한도에 걸렸습니다 · 30분 후 풀림'
    )
    expect(limitLabel({ status: 'allowed_warning' }, t, now)).toBe('사용 한도에 근접했습니다')
  })
})

describe('compactLabel', () => {
  it('shows what the conversation shrank to', () => {
    expect(compactLabel({ trigger: 'auto', pre: 120_000, post: 32_000 }, t)).toBe('컨텍스트 자동 압축 · 120k → 32k')
  })

  it('copes with a compaction still in flight', () => {
    expect(compactLabel({ trigger: 'manual', pre: 90_000 }, t)).toBe('컨텍스트 압축 · 90k')
  })
})
