import { describe, expect, it } from 'vitest'
import { PROBE_INIT, PROBE_STATUS, parseSessionProbeLine } from './sessionProbe'

const answer = (id: string, response: unknown): string =>
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })

describe('parseSessionProbeLine', () => {
  it('reads the slash commands from initialize', () => {
    const line = answer(PROBE_INIT, { commands: [{ name: 'compact', description: 'x' }, { name: 'wiki' }, {}] })
    expect(parseSessionProbeLine(line)).toEqual({ kind: 'commands', names: ['compact', 'wiki'] })
  })

  it('reads the MCP servers from mcp_status, whichever attempt it answers', () => {
    const line = answer(`${PROBE_STATUS}3`, {
      mcpServers: [
        { name: 'riven', status: 'connected', tools: [] },
        { name: 'figma', status: 'needs-auth' }
      ]
    })
    expect(parseSessionProbeLine(line)).toEqual({
      kind: 'mcp',
      servers: [
        { name: 'riven', status: 'connected' },
        { name: 'figma', status: 'needs-auth' }
      ]
    })
  })

  it('ignores stream events and answers to anything else', () => {
    expect(parseSessionProbeLine('{"type":"system","subtype":"init"}')).toBeNull()
    expect(parseSessionProbeLine(answer('someone-else', { commands: [] }))).toBeNull()
    expect(parseSessionProbeLine('')).toBeNull()
    expect(parseSessionProbeLine('garbage')).toBeNull()
  })
})
