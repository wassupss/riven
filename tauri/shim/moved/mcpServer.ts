// src/main/mcpServer.ts in the Tauri build. riven's MCP tool server lives in
// Rust (src-tauri/src/services/mcp: the loopback Streamable-HTTP server, the
// token, the tool catalog and prompt, the hook route, the zsh shim, the env
// every agent gets). Every tool runs there or in the page: riven_db_* in
// services/db (stage 6), riven_api_request in services/http (stage 7), the
// rest through the page ('mcp:invoke' / 'mcp:result' / 'mcp:cancel').

export function registerMcpServer(_webContentsGetter?: unknown): void {}

// Rust fails the calls waiting on a page when that page starts loading again
// (services/mcp::page_started), as this did on did-start-navigation.
export function failPendingToolCalls(_reason: string): number {
  return 0
}

export function stopMcpServer(): void {}
