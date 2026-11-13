// src/main/agentChat.ts in the Tauri build. Agent chat lives in Rust
// (src-tauri/src/services/chat), including riven's MCP config and hook env for
// each pane (src-tauri/src/services/mcp). What Node still asks is how many
// panes are mid-turn, for the quit confirmation in index.ts.
import { callSync } from '../rust'

export function runningChatCount(): number {
  try {
    return callSync<number>('chat.running')
  } catch {
    return 0
  }
}

// Rust kills the children itself when the shell exits (services/chat::shutdown).
export function killAllChatSessions(): void {}

export function registerAgentChatHandlers(): void {}
