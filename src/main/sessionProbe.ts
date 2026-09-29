// Reading the answers to riven's environment probe (see probeSessionInfo in
// agentChat): `initialize` for the slash commands, `mcp_status` for the MCP
// servers. Kept apart so it can be tested without the rest of agentChat.

export const PROBE_INIT = 'riven-probe-init'
export const PROBE_STATUS = 'riven-probe-mcp-'

/** One line of the probe's output → what it answered, if it is an answer. */
export function parseSessionProbeLine(
  line: string
):
  | { kind: 'commands'; names: string[] }
  | { kind: 'mcp'; servers: Array<{ name: string; status: string }> }
  | null {
  if (!line.trim()) return null
  let j: { type?: string; response?: { request_id?: string; response?: Record<string, unknown> } }
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  if (j.type !== 'control_response') return null
  const id = j.response?.request_id ?? ''
  const body = j.response?.response ?? {}
  if (id === PROBE_INIT) {
    const cmds = Array.isArray(body.commands) ? (body.commands as Array<{ name?: unknown }>) : []
    return { kind: 'commands', names: cmds.map((c) => c.name).filter((n): n is string => typeof n === 'string') }
  }
  if (id.startsWith(PROBE_STATUS)) {
    const list = Array.isArray(body.mcpServers) ? (body.mcpServers as Array<{ name?: unknown; status?: unknown }>) : []
    return {
      kind: 'mcp',
      servers: list
        .filter((s) => typeof s.name === 'string')
        .map((s) => ({ name: s.name as string, status: typeof s.status === 'string' ? s.status : 'unknown' }))
    }
  }
  return null
}
