import { describe, expect, it } from 'vitest'
import { auditTranscript, mergeTools, pct } from './tokenAudit.mjs'

const line = (o) => JSON.stringify(o)
const usage = (input, create, read, out = 10) => ({
  input_tokens: input,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
  output_tokens: out
})

// A turn with one riven call: the person asks, the agent calls riven_agents
// (written as TWO transcript entries for one API call), gets a result, answers.
const TRANSCRIPT = [
  line({ type: 'user', message: { role: 'user', content: '누가 있어?' } }),
  line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '' }], usage: usage(5, 1000, 150_000) } }),
  line({
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__riven__riven_agents', input: {} }], usage: usage(5, 1000, 150_000) }
  }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x'.repeat(300) }] }] } }),
  line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '둘' }], usage: usage(5, 50, 251_000) } }),
  line({ type: 'user', isMeta: true, message: { content: 'injected note' } }),
  line({ type: 'system', subtype: 'compact_boundary' }),
  line({ type: 'assistant', isSidechain: true, message: { id: 's1', content: [], usage: usage(1, 1, 999_999) } }),
  'not json'
]

describe('auditTranscript', () => {
  const a = auditTranscript(TRANSCRIPT)

  it('counts an API call once, however many entries it was written as', () => {
    expect(a.apiCalls).toBe(2)
    expect(a.cacheRead).toBe(401_000)
  })

  it('counts the person\'s turns, not tool results or injected notes', () => {
    expect(a.userTurns).toBe(1)
    expect(a.callsPerTurn).toBe(2)
  })

  it('measures the context each call carried', () => {
    expect(a.ctxMax).toBe(251_055)
    expect(a.over200k).toBe(0.5)
  })

  it('leaves subagent calls out, and counts compactions', () => {
    expect(a.ctxMax).toBeLessThan(999_999)
    expect(a.compactions).toBe(1)
  })

  it('sizes riven tool traffic in and out', () => {
    const [t] = mergeTools([a])
    expect(t).toMatchObject({ name: 'riven_agents', calls: 1, inP50: 2, outP50: 300 })
  })
})

describe('pct', () => {
  it('is nearest-rank and safe on empty input', () => {
    expect(pct([], 50)).toBe(0)
    expect(pct([3, 1, 2, 4], 50)).toBe(2)
    expect(pct([3, 1, 2, 4], 90)).toBe(4)
  })
})
