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

  // Regression: this used to read notification_type/matcher/reason, none of
  // which exist in Claude Code's payload, so needs_input never fired and every
  // agent could only report "finished". These are the REAL payload shapes.
  it('a Notification means needs_input, whatever its message says', () => {
    const base = {
      session_id: 'abc',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/repo',
      hook_event_name: 'Notification'
    }
    expect(
      claudeHookToEvent('Notification', {
        ...base,
        message: 'Claude needs your permission to use Bash'
      })
    ).toBe('needs_input')
    expect(
      claudeHookToEvent('Notification', {
        ...base,
        message: 'Claude is waiting for your input'
      })
    ).toBe('needs_input')
    // Reworded or localised messages must not silently stop reporting.
    expect(claudeHookToEvent('Notification', { ...base, message: '입력을 기다리는 중' })).toBe(
      'needs_input'
    )
    // A payload we can't parse at all still means the agent wants the user.
    expect(claudeHookToEvent('Notification', null)).toBe('needs_input')
  })

  it('a hook-driven turn can still report needs_input after finishing', () => {
    const a = new TerminalActivity(() => 1)
    a.hook(claudeHookToEvent('UserPromptSubmit', null) as 'working')
    expect(a.hook(claudeHookToEvent('Stop', null) as 'idle')).toBe('finished')
    // The permission prompt arrives next; the heuristic is off by now, so this
    // is the ONLY way needs_input can still be reported.
    expect(a.hook(claudeHookToEvent('Notification', { message: 'permission' }) as 'needs_input')).toBe(
      'needs_input'
    )
    expect(a.snapshot().attention).toBe('needs_input')
  })
})
