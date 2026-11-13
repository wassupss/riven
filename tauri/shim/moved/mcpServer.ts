// src/main/mcpServer.ts in the Tauri build. riven's MCP tool server lives in
// Rust now (src-tauri/src/services/mcp: the loopback Streamable-HTTP server,
// the token, the tool catalog and prompt, the hook route, the zsh shim, the
// env every agent gets). Tool calls go from Rust straight to the app page
// ('mcp:invoke' / 'mcp:result' / 'mcp:cancel' are Rust-owned channels).
//
// What stays here is the tools whose engine is still Node, run on Rust's
// request ('mcpTool' on the control line, answered with 'mcp.toolResult'):
//   riven_db_*         the DB engine (src/main/db, stage 6). riven_db_execute
//                      asks the user first: 'mcp.ask' has Rust show the
//                      ask_user card in the calling pane and wait.
//   riven_api_request  Node's fetch (src/main/apiRequest.ts, stage 7 with the
//                      API client panel).
import { runApiRequest } from '../../../src/main/apiRequest'
import { call, onEvent } from '../rust'

type ToolAsk = { id: string; tool: string; args: Record<string, unknown>; cwd: string | null; key: string | null }

async function run(m: ToolAsk): Promise<string> {
  if (m.tool === 'riven_api_request') return runApiRequest(m.args ?? {})
  const { runDbTool } = await import('../../../src/main/db/engine')
  return runDbTool(m.tool, m.args ?? {}, (question, options) =>
    call<string>('mcp.ask', { parent: m.id, question, options, cwd: m.cwd, key: m.key }).catch(
      () => 'riven: no window available'
    )
  )
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
