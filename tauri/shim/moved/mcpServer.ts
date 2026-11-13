// src/main/mcpServer.ts in the Tauri build. riven's MCP tool server lives in
// Rust now (src-tauri/src/services/mcp: the loopback Streamable-HTTP server,
// the token, the tool catalog and prompt, the hook route, the zsh shim, the
// env every agent gets). Tool calls go from Rust straight to the app page
// ('mcp:invoke' / 'mcp:result' / 'mcp:cancel' are Rust-owned channels).
//
// The riven_db_* tools run in Rust too (src-tauri/src/services/db/engine.rs,
// stage 6). What stays here is the one tool whose engine is still Node, run on
// Rust's request ('mcpTool' on the control line, answered with
// 'mcp.toolResult'):
//   riven_api_request  Node's fetch (src/main/apiRequest.ts, stage 7 with the
//                      API client panel).
import { runApiRequest } from '../../../src/main/apiRequest'
import { call, onEvent } from '../rust'

type ToolAsk = { id: string; tool: string; args: Record<string, unknown>; cwd: string | null; key: string | null }

async function run(m: ToolAsk): Promise<string> {
  if (m.tool === 'riven_api_request') return runApiRequest(m.args ?? {})
  return `error: unknown tool ${m.tool}`
}

export function registerMcpServer(_webContentsGetter?: unknown): void {
  onEvent((m) => {
    if (m.ev !== 'mcpTool') return
    const ask = m as unknown as ToolAsk
    run(ask)
      .catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`)
      .then((text) => call('mcp.toolResult', { id: ask.id, text }))
      .catch(() => {})
  })
}

// Rust fails the calls waiting on a page when that page starts loading again
// (services/mcp::page_started), as this did on did-start-navigation.
export function failPendingToolCalls(_reason: string): number {
  return 0
}

export function stopMcpServer(): void {}
