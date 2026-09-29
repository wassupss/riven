import { describe, expect, it } from 'vitest'
import { autocompactArg } from './cliArgs'

describe('autocompactArg', () => {
  it('passes a window the CLI accepts, as a plain number', () => {
    expect(autocompactArg('200000')).toBe('200000')
    expect(autocompactArg('150k')).toBe('150000')
    expect(autocompactArg('1m')).toBe('1000000')
  })

  it('passes nothing for auto, which is already the CLI default', () => {
    expect(autocompactArg('auto')).toBeNull()
    expect(autocompactArg(undefined)).toBeNull()
    expect(autocompactArg('')).toBeNull()
  })

  it('drops what would stop the CLI from starting at all', () => {
    expect(autocompactArg('50000')).toBeNull() // below 100K
    expect(autocompactArg('2000000')).toBeNull() // above 1M
    expect(autocompactArg('lots')).toBeNull()
  })
})
