import { describe, expect, it } from 'vitest'
import { chatEngine } from './chatEngine'

describe('chatEngine', () => {
  it('follows the setting, CLI chat by default', () => {
    expect(chatEngine('claude', undefined, undefined)).toBe('cli')
    expect(chatEngine(undefined, undefined, 'cli')).toBe('cli')
    expect(chatEngine('claude', undefined, 'native')).toBe('native')
  })
  it('an explicit choice wins', () => {
    expect(chatEngine('claude', 'native', 'cli')).toBe('native')
    expect(chatEngine('claude', 'cli', 'native')).toBe('cli')
  })
  it('an agent the CLI chat cannot run stays headless', () => {
    expect(chatEngine('codex', 'cli', 'cli', ['claude'])).toBe('native')
    expect(chatEngine('codex', undefined, 'cli', ['claude', 'codex'])).toBe('cli')
  })
})
