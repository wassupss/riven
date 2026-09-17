import { describe, it, expect } from 'vitest'
import { terminalRosterTitle } from './rosterActivity'

describe('terminalRosterTitle', () => {
  it('uses the title the tab shows once it names the conversation', () => {
    expect(terminalRosterTitle({ agent: true, name: 'claude', tabTitle: 'Fix login redirect' }, '❯ 터미널')).toBe(
      'Fix login redirect'
    )
  })

  it('falls back to the persisted tab title for an unmounted workspace', () => {
    expect(terminalRosterTitle({ agent: true, name: 'claude' }, 'My rename')).toBe('My rename')
  })

  it('prefers the agent name over the generic placeholder', () => {
    expect(terminalRosterTitle({ agent: true, name: 'codex', tabTitle: '❯ 터미널' }, '❯ 터미널')).toBe('codex')
  })
})
