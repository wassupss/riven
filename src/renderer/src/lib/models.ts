// Which models each CLI can be asked for.
//
// One list, because there were three: the chat pane's picker, the agent-group
// panel's member form, and the tool descriptions. They drifted — the group panel
// offered opus/sonnet/haiku and nothing else, so a team could not be given fable
// or any Codex model from the UI at all, even though a pane created by an agent
// could run them.
export type Cli = 'claude' | 'codex'

export const CLAUDE_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku']
// Codex's own ids (from its app-server model/list). "default" is the account's.
export const CODEX_MODELS = ['default', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']

export function modelsFor(cli: Cli | string | null | undefined): string[] {
  return cli === 'codex' ? CODEX_MODELS : CLAUDE_MODELS
}

/** A model picked for one CLI means nothing to the other: fall back to default. */
export function modelForCli(model: string | null | undefined, cli: Cli): string {
  const m = model ?? 'default'
  return modelsFor(cli).includes(m) ? m : 'default'
}
