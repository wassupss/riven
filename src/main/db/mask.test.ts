import { describe, expect, it } from 'vitest'
import { maskValue, projectRow, suggestMask } from './mask'

describe('maskValue', () => {
  it('keeps separators and nulls', () => {
    expect(maskValue('010-1234-5678', 'middle')).toBe('010-****-5678')
    expect(maskValue('abc', 'full')).toBe('***')
    expect(maskValue(null, 'full')).toBeNull()
    expect(maskValue('x', 'empty')).toBeNull()
    expect(maskValue(42, 'none')).toBe(42)
  })

  it('keeps the start or end', () => {
    expect(maskValue('홍길동', 'start')).toBe('홍**')
    expect(maskValue('1234567890', 'end')).toBe('******7890')
    expect(maskValue('1234567890', 'end', 2)).toBe('********90')
  })

  it('masks the local part of an email', () => {
    expect(maskValue('alice@example.com', 'email')).toBe('al***@example.com')
    expect(maskValue('a@b.c', 'email')).toBe('a@b.c')
  })
})

describe('projectRow', () => {
  it('picks and masks columns in order', () => {
    const cols = [
      { index: 2, name: 'c', type: 'text', mask: 'none' as const },
      { index: 0, name: 'a', type: 'text', mask: 'full' as const }
    ]
    expect(projectRow(['ab', 'x', 'c'], cols)).toEqual(['c', '**'])
  })
})

describe('suggestMask', () => {
  it('guesses personal columns', () => {
    expect(suggestMask('user_email')).toBe('email')
    expect(suggestMask('password_hash')).toBe('full')
    expect(suggestMask('phone')).toBe('middle')
    expect(suggestMask('id')).toBe('none')
  })
})
