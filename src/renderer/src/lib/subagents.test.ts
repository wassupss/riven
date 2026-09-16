import { describe, it, expect } from 'vitest'
import { activeSubagents, isQuiet, isSubagentTool, toolGroupMode, type SubagentLine } from './subagents'

describe('toolGroupMode', () => {
  const run = { done: false }
  const fin = { done: true }

  it('is running while any call in the group is still out', () => {
    expect(toolGroupMode([fin, run], true)).toBe('running')
    expect(toolGroupMode([fin, run], false)).toBe('running')
  })

  // The point of the change: a finished command stays named until something
  // replaces it, instead of collapsing to "1 command" the instant it returns.
  it('keeps naming the last command while nothing has happened since', () => {
    expect(toolGroupMode([fin], true)).toBe('last')
    expect(toolGroupMode([fin, fin], true)).toBe('last')
  })

  // Once the agent speaks, a text block follows this group — it is no longer
  // trailing — and the count is the more useful thing to leave behind.
  it('falls back to the summary once the turn has moved on', () => {
    expect(toolGroupMode([fin], false)).toBe('summary')
  })

  it('summarises a group that was cut off, so "stopped" is not hidden', () => {
    expect(toolGroupMode([{ done: true, interrupted: true }], true)).toBe('summary')
  })
})

const T0 = 1_000_000

const task = (id: string, detail: string, startedAt: number, over: Partial<SubagentLine> = {}): SubagentLine => ({
  name: 'Task',
  detail,
  toolId: id,
  startedAt,
  ...over
})
const step = (parent: string, startedAt: number): SubagentLine => ({
  name: 'Grep',
  detail: 'search',
  toolId: `${parent}-${startedAt}`,
  parent,
  startedAt
})

describe('isSubagentTool', () => {
  it('knows the two names a delegation arrives under', () => {
    expect(isSubagentTool('Task')).toBe(true)
    expect(isSubagentTool('Agent')).toBe(true)
    expect(isSubagentTool('Bash')).toBe(false)
  })
})

describe('activeSubagents', () => {
  it('lists a delegation whose result has not arrived', () => {
    const out = activeSubagents([task('a', 'research logos', T0)])
    expect(out).toEqual([
      { toolId: 'a', label: 'research logos', startedAt: T0, lastActivityAt: T0, steps: 0 }
    ])
  })

  it('drops one that finished, failed, or was stopped with the turn', () => {
    const out = activeSubagents([
      task('a', 'done', T0, { done: true }),
      task('b', 'failed', T0, { error: true }),
      task('c', 'stopped', T0, { interrupted: true }),
      task('d', 'still going', T0)
    ])
    expect(out.map((a) => a.toolId)).toEqual(['d'])
  })

  // The nested calls are the only evidence a delegated agent is alive.
  it('counts its steps and tracks the newest one as its heartbeat', () => {
    const out = activeSubagents([
      task('a', 'research', T0),
      step('a', T0 + 5_000),
      step('a', T0 + 20_000)
    ])
    expect(out[0].steps).toBe(2)
    expect(out[0].lastActivityAt).toBe(T0 + 20_000)
  })

  it('does not credit one agent with another agent’s steps', () => {
    const out = activeSubagents([task('a', 'a', T0), task('b', 'b', T0), step('b', T0 + 9_000)])
    const a = out.find((x) => x.toolId === 'a')!
    const b = out.find((x) => x.toolId === 'b')!
    expect([a.steps, b.steps]).toEqual([0, 1])
    expect(a.lastActivityAt).toBe(T0)
  })

  it('ignores steps belonging to an agent that already finished', () => {
    const out = activeSubagents([task('a', 'a', T0, { done: true }), step('a', T0 + 1_000)])
    expect(out).toEqual([])
  })

  // The longest-running one is both the most interesting and the most likely
  // to be stuck, so it reads first.
  it('puts the oldest first', () => {
    const out = activeSubagents([task('new', 'new', T0 + 60_000), task('old', 'old', T0)])
    expect(out.map((a) => a.toolId)).toEqual(['old', 'new'])
  })

  it('falls back to the tool name when the call carries no description', () => {
    expect(activeSubagents([task('a', '   ', T0)])[0].label).toBe('Task')
  })
})

describe('isQuiet', () => {
  const agent = { toolId: 'a', label: 'x', startedAt: T0, lastActivityAt: T0, steps: 0 }

  // The case this exists for: an agent that stopped writing half an hour ago
  // looks exactly like one that is thinking.
  it('is quiet once nothing has happened for the threshold', () => {
    expect(isQuiet(agent, T0 + 5 * 60_000, 3 * 60_000)).toBe(true)
  })

  it('is not quiet while steps keep arriving', () => {
    expect(isQuiet({ ...agent, lastActivityAt: T0 + 4 * 60_000 }, T0 + 5 * 60_000, 3 * 60_000)).toBe(
      false
    )
  })

  it('says nothing about an agent with no timestamps at all', () => {
    expect(isQuiet({ ...agent, startedAt: 0, lastActivityAt: 0 }, T0, 1)).toBe(false)
  })
})
