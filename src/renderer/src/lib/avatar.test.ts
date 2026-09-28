import { describe, expect, it } from 'vitest'

import { monogram } from './avatar'

describe('monogram', () => {
  it('takes the initials of a hyphenated or spaced name', () => {
    expect(monogram('riven-electron')).toBe('RE')
    expect(monogram('hs playground')).toBe('HP')
    expect(monogram('fe_rentalpay_web')).toBe('FR')
  })

  it('takes two letters from a single Latin word', () => {
    expect(monogram('portboard')).toBe('PO')
  })

  it('takes ONE character from a script that has no case', () => {
    // Two Hangul syllables in a 16px tile cannot be read.
    expect(monogram('테스트 폴더')).toBe('테')
    expect(monogram('作業')).toBe('作')
  })

  it('never splits a surrogate pair in half', () => {
    expect(monogram('🚀rocket')).toBe('🚀')
  })

  it('says something for a nameless workspace', () => {
    expect(monogram('')).toBe('?')
    expect(monogram('   ')).toBe('?')
  })
})
