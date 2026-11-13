// src/main/agentHooks.ts in the Tauri build. The hook route, the --settings
// file, the edit tracker and the hook -> activity mapping live in Rust now
// (src-tauri/src/services/mcp/hooks.rs), which sends 'agent:fileEdit' to the
// app's pages itself.
import type { AgentFileEdit } from '../../../src/main/agentEdits'

export function registerAgentEditHooks(_handler: (edit: AgentFileEdit) => void): void {}
