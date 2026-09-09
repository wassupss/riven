import { describe, expect, it } from 'vitest'
import { TerminalActivity, claudeHookToEvent } from './activity'

describe('TerminalActivity', () => {
  it('hook: a turn that starts and stops raises "finished" exactly once', () => {
    const a = new TerminalActivity(() => 1)
    expect(a.hook('working')).toBeNull()
    expect(a.snapshot().state).toBe('working')
    expect(a.hook('idle')).toBe('finished')
    expect(a.snapshot()).toMatchObject({ state: 'idle', attention: 'finished' })
    // A second Stop is not news.
    expect(a.hook('idle')).toBeNull()
  })

  it('hook: needs_input is raised even from idle, and a new turn clears it', () => {
    const a = new TerminalActivity(() => 1)
    expect(a.hook('needs_input')).toBe('needs_input')
    expect(a.hook('working')).toBeNull()
    expect(a.snapshot().attention).toBeNull()
  })

  it('the heuristic is ignored once hooks have spoken', () => {
    const a = new TerminalActivity(() => 1)
    a.hook('working')
    expect(a.heuristic('idle')).toBeNull()
    expect(a.snapshot().state).toBe('working')
  })

  it('the heuristic alone still produces finished', () => {
    const a = new TerminalActivity(() => 1)
    expect(a.heuristic('working')).toBeNull()
    expect(a.heuristic('idle')).toBe('finished')
  })

  it('clearAttention reports whether there was anything to clear', () => {
    const a = new TerminalActivity(() => 1)
    expect(a.clearAttention()).toBe(false)
    a.hook('working')
    a.hook('idle')
    expect(a.clearAttention()).toBe(true)
    expect(a.snapshot().attention).toBeNull()
  })

  it('reset returns to idle and re-enables the heuristic', () => {
    const a = new TerminalActivity(() => 1)
    a.hook('working')
    a.reset()
    expect(a.hookDriven).toBe(false)
    expect(a.heuristic('working')).toBeNull()
    expect(a.snapshot().state).toBe('working')
  })
})

describe('claudeHookToEvent', () => {
  it('maps lifecycle hooks', () => {
    expect(claudeHookToEvent('UserPromptSubmit', null)).toBe('working')
    expect(claudeHookToEvent('Stop', null)).toBe('idle')
    expect(claudeHookToEvent('StopFailure', null)).toBe('idle')
    expect(claudeHookToEvent('SessionEnd', null)).toBe('idle')
    expect(claudeHookToEvent('PreToolUse', null)).toBeNull()
  })

  it('only an idle/permission Notification means needs_input', () => {
    expect(claudeHookToEvent('Notification', { notification_type: 'idle_prompt' })).toBe('needs_input')
    expect(claudeHookToEvent('Notification', { matcher: 'permission_prompt' })).toBe('needs_input')
    expect(claudeHookToEvent('Notification', { notification_type: 'auth_success' })).toBeNull()
    expect(claudeHookToEvent('Notification', null)).toBeNull()
  })
})
