import { claudeHookToEvent, type HookEvent } from './terminal/activity'

// What riven knows how to talk to, beyond "some process is running".
//
// Every agent CLI can be detected and watched from its output. These are the
// ones riven can also HEAR from: they report their lifecycle through hooks, so
// riven knows exactly when a turn starts and ends, which conversation a pane is
// in, what the agent answered, and which files it wrote. That is what lets
// panes work with each other — a question typed into another agent's terminal
// comes back as its answer, not as "sent, good luck".
//
// Claude Code and Codex share the hook model closely (the same event names and
// the same payload fields: session_id, transcript_path, last_assistant_message,
// tool_name/tool_input), verified against the installed CLIs. What differs is
// how the hooks are handed over and a few event meanings, which is all this
// file encodes.

export type AgentKind = 'claude' | 'codex'

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex']

// The hook route is told which agent is speaking. Anything unrecognised is
// Claude, which is what every hook sent before this existed was.
export function agentKindOf(v: unknown): AgentKind {
  return v === 'codex' ? 'codex' : 'claude'
}

export function hookToEvent(agent: AgentKind, hook: string, payload?: unknown): HookEvent | null {
  if (agent === 'codex') {
    switch (hook) {
      case 'UserPromptSubmit':
        return 'working'
      case 'SessionStart':
      case 'Stop':
      case 'SessionEnd':
        return 'idle'
      // Codex has no Notification hook. A permission prompt is the moment it
      // stops and waits for the person.
      case 'PermissionRequest':
        return 'needs_input'
      default:
        return null
    }
  }
  return claudeHookToEvent(hook, payload)
}

// Both CLIs put the conversation id in every payload. It ends up in a shell
// command (`… resume <id>`), so it is accepted only in the UUID shape both emit.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function sessionIdOf(payload: unknown): string | null {
  const raw = (payload as { session_id?: unknown } | null)?.session_id
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null
}

// The answer a turn ended with. Stop carries it for both CLIs.
export function replyOf(hook: string, payload: unknown): string | null {
  if (hook !== 'Stop') return null
  const raw = (payload as { last_assistant_message?: unknown } | null)?.last_assistant_message
  return typeof raw === 'string' && raw.trim() ? raw : null
}

// The Codex hooks riven registers, in the order they are passed. Codex keys a
// hook's trust by source + event + POSITION, and remembers the hash of what it
// approved — so these commands never change between runs (everything variable
// comes from the environment), and the user reviews them once, in Codex.
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'] as const
// apply_patch is Codex's file tool; the others are what it may be configured to
// expose instead. Only these pay for a tool hook.
export const CODEX_EDIT_TOOL_MATCHER = 'apply_patch|Edit|Write'

// A TOML basic string. JSON's escaping is a subset TOML accepts.
function tomlString(s: string): string {
  return JSON.stringify(s)
}

function tomlHook(command: string, matcher?: string): string {
  const m = matcher ? `matcher=${tomlString(matcher)},` : ''
  return `[{${m}hooks=[{type="command",command=${tomlString(command)},timeout=5}]}]`
}

// `-c key=value` overrides for a Codex launched in a riven terminal: riven's MCP
// server for this pane, and the lifecycle + file-edit hooks. Nothing is written
// into the user's ~/.codex. Returned as values (without the `-c`).
export function codexConfigOverrides(opts: {
  mcpUrl: string | null
  hookCommand: (event: string) => string
  instructions: string | null
  toolTimeoutSec: number
}): string[] {
  const out: string[] = []
  if (opts.mcpUrl) {
    out.push(`mcp_servers.riven.url=${tomlString(opts.mcpUrl)}`)
    // The token stays out of argv (visible to `ps`); Codex reads it from here.
    out.push('mcp_servers.riven.bearer_token_env_var="RIVEN_MCP_TOKEN"')
    // ask_user waits on a person; riven's own ceiling is the one that applies.
    out.push(`mcp_servers.riven.tool_timeout_sec=${opts.toolTimeoutSec}`)
  }
  for (const ev of CODEX_HOOK_EVENTS) out.push(`hooks.${ev}=${tomlHook(opts.hookCommand(ev))}`)
  for (const ev of ['PreToolUse', 'PostToolUse']) {
    out.push(`hooks.${ev}=${tomlHook(opts.hookCommand(ev), CODEX_EDIT_TOOL_MATCHER)}`)
  }
  if (opts.instructions) out.push(`developer_instructions=${tomlString(opts.instructions)}`)
  return out
}
