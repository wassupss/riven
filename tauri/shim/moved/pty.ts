// src/main/pty.ts in the Tauri build. Terminals live in Rust
// (src-tauri/src/services/pty), and so do the riven environment a shell gets,
// the zsh shim and the agent hooks (src-tauri/src/services/mcp). What Node
// still asks is how many terminal agents are working, for the quit
// confirmation in index.ts, which is synchronous.
import { callSync } from '../rust'

export function primeShellShim(): void {}

export function runningTerminalAgentCount(): number {
  try {
    return callSync<number>('pty.working')
  } catch {
    return 0
  }
}

export function registerPtyHandlers(): void {}
