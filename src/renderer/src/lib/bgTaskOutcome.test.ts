import { describe, expect, it } from 'vitest'
import { bgTaskOutcome } from './bgTaskOutcome'

describe('bgTaskOutcome', () => {
  it('reads completed as done', () => {
    expect(bgTaskOutcome('completed', 'Background command "npm test" completed')).toBe('done')
  })

  it('reads a server ended by a signal as stopped, not failed', () => {
    expect(bgTaskOutcome('failed', 'Background command "Start dev server" failed with exit code 144')).toBe('stopped')
    expect(bgTaskOutcome('failed', 'Background command "x" failed with exit code 143')).toBe('stopped')
    expect(bgTaskOutcome('failed', 'Background command "x" failed with exit code 137')).toBe('stopped')
  })

  it('reads TaskStop, time limits and a session ending as stopped', () => {
    expect(bgTaskOutcome('killed', 'Background command "x" was stopped')).toBe('stopped')
    expect(bgTaskOutcome('stopped', "didn't finish before the previous session ended")).toBe('stopped')
  })

  it('keeps a real non-zero exit a failure', () => {
    expect(bgTaskOutcome('failed', 'Background command "npm test" failed with exit code 1')).toBe('failed')
    expect(bgTaskOutcome('failed', '')).toBe('failed')
  })
})
