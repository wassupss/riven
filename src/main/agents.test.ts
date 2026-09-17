import { describe, it, expect } from 'vitest'
import { agentKindOf, codexConfigOverrides, hookToEvent, replyOf, sessionIdOf } from './agents'
import { titleFromRollout, transcriptFromRollout } from './codexSessions'
import { codexPolicy, codexToolLines, codexUserInput, itemFailed } from './codexChat'

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

describe('transcriptFromRollout', () => {
  it('restores the conversation, one answer per turn', () => {
    const ev = (type: string, message: string): string => JSON.stringify({ type: 'event_msg', payload: { type, message } })
    const text = [ev('user_message', 'hi'), ev('agent_message', 'one'), ev('agent_message', 'two'), ev('user_message', 'bye')].join('\n')
    expect(transcriptFromRollout(text)).toEqual([
      { role: 'user', text: 'hi', tools: [] },
      { role: 'assistant', text: 'one\n\ntwo', tools: [] },
      { role: 'user', text: 'bye', tools: [] }
    ])
  })
})

describe('codex chat mapping', () => {
  it('maps pane modes onto a sandbox and approval policy', () => {
    expect(codexPolicy('plan')).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' })
    expect(codexPolicy('acceptEdits')).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    expect(codexPolicy('bypassPermissions').sandbox).toBe('danger-full-access')
  })

  it('sends images as data URLs after the text', () => {
    const input = codexUserInput('look', [{ mediaType: 'image/png', data: 'AAAA' }])
    expect(input).toEqual([
      { type: 'text', text: 'look', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AAAA' }
    ])
  })

  it('names Codex items the way the pane names tools', () => {
    expect(codexToolLines({ type: 'commandExecution', command: 'npm test' })[0]).toMatchObject({ name: 'Bash', detail: 'npm test' })
    const patch = codexToolLines({
      type: 'fileChange',
      changes: [
        { path: '/w/a.ts', kind: { type: 'update', move_path: null }, diff: '@@\n-a\n+b\n+c' },
        { path: '/w/new.ts', kind: { type: 'add' }, diff: '+x' }
      ]
    })
    expect(patch.map((p) => [p.name, p.detail])).toEqual([
      ['Edit', '/w/a.ts  +2 -1'],
      ['Write', '/w/new.ts']
    ])
    expect(codexToolLines({ type: 'mcpToolCall', server: 'riven', tool: 'ask_user', arguments: {} })[0].name).toBe(
      'mcp__riven__ask_user'
    )
    expect(codexToolLines({ type: 'reasoning' })).toEqual([])
  })

  it('treats a failed or non-zero item as an error', () => {
    expect(itemFailed({ status: 'completed', exitCode: 0 })).toBe(false)
    expect(itemFailed({ status: 'completed', exitCode: 2 })).toBe(true)
    expect(itemFailed({ status: 'failed' })).toBe(true)
  })
})
