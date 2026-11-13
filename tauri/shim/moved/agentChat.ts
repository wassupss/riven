// src/main/agentChat.ts in the Tauri build. Agent chat lives in Rust now
// (src-tauri/src/services/chat: the claude/codex children, the stream, the
// idle park, past sessions, `claude mcp`, accounts, CLI updates), and its
// channels never reach Node (tauri/shim/rust-owned.ts). codexChat.ts and the
// helpers only chat used are no longer in this bundle.
//
// What stays here is what needs Node's MCP server and hook route until those
// move too (docs/tauri-rust-main.md, stage 4). Each is one message on the
// control line:
//   'chatEnv'     Rust asks for a pane's riven MCP config, tool prompt and
//                 hook env; answered with 'chat.env'.
//   'chatEdit'    a Codex pane changed a file: into the changes timeline
//                 (agentHooks.reportAgentEdit), as the Node build did.
//   'chatRunning' how many panes are mid-turn, for the quit confirmation.
import {
  mcpConfigJson,
  mcpPaneUrl,
  mcpSystemPrompt,
  mcpAuthToken,
  mcpRequestTimeoutMs,
  implementedToolNames,
  agentMcpEnv,
  mcpReady,
  MCP_TOOL_PREFIX
} from '../../../src/main/mcpServer'
import { hookEnv, reportAgentEdit } from '../../../src/main/agentHooks'
import type { AgentFileEdit } from '../../../src/main/agentEdits'
import { call, onEvent } from '../rust'

type EnvAsk = { id: number; kind: 'claude' | 'codex' | 'probe'; key: string; disabled?: string[] }

async function chatEnv(m: EnvAsk): Promise<Record<string, unknown>> {
  // The probe never waited for the server (agentChat.probeSessionInfo).
  if (m.kind === 'probe') return { mcpConfig: mcpConfigJson(implementedToolNames()) }
  await mcpReady()
  const disabled = new Set(m.disabled ?? [])
  const enabled = implementedToolNames().filter((n) => !disabled.has(n))
  if (m.kind === 'codex') {
    const url = enabled.length ? mcpPaneUrl(enabled, m.key) : null
    return {
      url,
      prompt: url ? mcpSystemPrompt(enabled) : null,
      token: mcpAuthToken(),
      timeoutSec: Math.round(mcpRequestTimeoutMs() / 1000)
    }
  }
  const mcpConfig = enabled.length ? mcpConfigJson(enabled, m.key) : null
  return {
    enabled: enabled.length,
    mcpConfig,
    prompt: mcpConfig ? mcpSystemPrompt(enabled) : null,
    prefix: MCP_TOOL_PREFIX,
    agentEnv: agentMcpEnv(),
    hooks: hookEnv(m.key)
  }
}

let running = 0

// Chat panes whose agent is mid-turn: what quitting would cut off.
export function runningChatCount(): number {
  return running
}

// Rust kills the children itself when the shell exits (services/chat::shutdown).
export function killAllChatSessions(): void {}

export function registerAgentChatHandlers(): void {
  onEvent((m) => {
    if (m.ev === 'chatEnv') {
      const ask = m as unknown as EnvAsk
      chatEnv(ask)
        .catch((e) => {
          console.error('[riven] chat env failed', e)
          return null
        })
        .then((val) => call('chat.env', { id: ask.id, val }))
        .catch(() => {})
    } else if (m.ev === 'chatEdit') {
      reportAgentEdit(m.edit as AgentFileEdit)
    } else if (m.ev === 'chatRunning') {
      running = typeof m.n === 'number' ? m.n : 0
    }
  })
}
