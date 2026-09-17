import { describe, it, expect } from 'vitest'
import { agentKindOf, codexConfigOverrides, hookToEvent, replyOf, sessionIdOf } from './agents'
import { titleFromRollout } from './codexSessions'

describe('hookToEvent', () => {
  it('maps Codex turns and its permission prompt', () => {
    expect(hookToEvent('codex', 'UserPromptSubmit')).toBe('working')
    expect(hookToEvent('codex', 'Stop')).toBe('idle')
    expect(hookToEvent('codex', 'SessionStart')).toBe('idle')
    expect(hookToEvent('codex', 'PermissionRequest')).toBe('needs_input')
    expect(hookToEvent('codex', 'PostToolUse')).toBeNull()
  })

  it('keeps Claude on its own mapping', () => {
    expect(hookToEvent('claude', 'Notification')).toBe('needs_input')
    expect(hookToEvent('claude', 'PermissionRequest')).toBeNull()
  })

  it('treats an unnamed agent as Claude', () => {
    expect(agentKindOf(null)).toBe('claude')
    expect(agentKindOf('codex')).toBe('codex')
    expect(agentKindOf('rm -rf')).toBe('claude')
  })
})

describe('payload fields', () => {
  it('accepts a UUID session id only', () => {
    expect(sessionIdOf({ session_id: '019fda6a-3125-73b0-9bcb-3ef1304e0210' })).toBe(
      '019fda6a-3125-73b0-9bcb-3ef1304e0210'
    )
    expect(sessionIdOf({ session_id: 'x; rm -rf ~' })).toBeNull()
  })

  it('takes the reply from Stop only', () => {
    expect(replyOf('Stop', { last_assistant_message: '42' })).toBe('42')
    expect(replyOf('Stop', { last_assistant_message: '  ' })).toBeNull()
    expect(replyOf('SessionStart', { last_assistant_message: '42' })).toBeNull()
  })
})

describe('codexConfigOverrides', () => {
  const opts = {
    mcpUrl: 'http://127.0.0.1:5000/mcp?pane=term-1',
    hookCommand: (ev: string) => `curl "$URL?event=${ev}" 'x'`,
    instructions: '도구 안내\n둘째 줄',
    toolTimeoutSec: 1800
  }

  it('passes the MCP server with the token left in the environment', () => {
    const out = codexConfigOverrides(opts)
    expect(out).toContain('mcp_servers.riven.url="http://127.0.0.1:5000/mcp?pane=term-1"')
    expect(out).toContain('mcp_servers.riven.bearer_token_env_var="RIVEN_MCP_TOKEN"')
    expect(out).toContain('mcp_servers.riven.tool_timeout_sec=1800')
    expect(out.join('\n')).not.toMatch(/Bearer/)
  })

  // One override per line of an env var: nothing may contain a raw newline.
  it('keeps every override on one line, as valid TOML strings', () => {
    const out = codexConfigOverrides(opts)
    for (const o of out) expect(o).not.toContain('\n')
    expect(out).toContain(
      'hooks.Stop=[{hooks=[{type="command",command="curl \\"$URL?event=Stop\\" \'x\'",timeout=5}]}]'
    )
    expect(out.find((o) => o.startsWith('hooks.PostToolUse='))).toContain('matcher="apply_patch|Edit|Write"')
    expect(out.find((o) => o.startsWith('developer_instructions='))).toBe(
      'developer_instructions="도구 안내\\n둘째 줄"'
    )
  })

  it('still hooks a terminal with no MCP server', () => {
    const out = codexConfigOverrides({ ...opts, mcpUrl: null, instructions: null })
    expect(out.some((o) => o.startsWith('mcp_servers'))).toBe(false)
    expect(out.some((o) => o.startsWith('hooks.SessionStart='))).toBe(true)
  })
})

describe('titleFromRollout', () => {
  it('names a Codex conversation after its first message', () => {
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '\n  로그인 버그 고쳐줘\n자세히' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'second' } })
    ]
    expect(titleFromRollout(lines.join('\n'))).toBe('로그인 버그 고쳐줘')
  })

  it('shortens a long opening line', () => {
    const msg = 'a'.repeat(200)
    const t = titleFromRollout(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: msg } }))
    expect(t?.length).toBe(80)
  })

  it('has no title before the first message', () => {
    expect(titleFromRollout(JSON.stringify({ type: 'session_meta', payload: {} }))).toBeNull()
  })
})
