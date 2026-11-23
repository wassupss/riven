// What runs a new chat pane: the CLI chat (services/clichat: the interactive
// CLI in a hidden pty, drawn as a chat) or the headless chat (services/chat).
// Pure; the registry passes the setting and what the CLI chat can run.

export type ChatEngine = 'cli' | 'native'

/** The CLI chat runs these agents; anything else opens headless. */
export const CLI_CHAT_AGENTS: ReadonlyArray<string> = ['claude', 'codex']

/** An explicit choice wins, then the setting; an agent the CLI chat cannot run is headless. */
export function chatEngine(
  cli: string | undefined,
  explicit: ChatEngine | undefined,
  setting: string | undefined,
  supported: ReadonlyArray<string> = CLI_CHAT_AGENTS
): ChatEngine {
  if (!supported.includes(cli ?? 'claude')) return 'native'
  return explicit ?? (setting === 'native' ? 'native' : 'cli')
}
