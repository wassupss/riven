import { describe, expect, it } from 'vitest'
import { resultError } from './resultError'

describe('resultError', () => {
  it('says why a limit-stopped turn ended, not "success"', () => {
    const ev = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "You've hit your session limit · resets 7pm (Asia/Seoul)"
    }
    expect(resultError(ev)).toBe("You've hit your session limit · resets 7pm (Asia/Seoul)")
  })

  it('takes an execution error from `errors`', () => {
    const ev = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['No conversation found with session ID: 00000000-0000-4000-8000-000000000000']
    }
    expect(resultError(ev)).toBe('No conversation found with session ID: 00000000-0000-4000-8000-000000000000')
  })

  it('falls back to the subtype when there is nothing better', () => {
    expect(resultError({ subtype: 'error_max_turns', is_error: true })).toBe('error_max_turns')
    expect(resultError({ is_error: true })).toBe('error')
  })
})
