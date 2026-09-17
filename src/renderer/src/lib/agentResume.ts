// The command that brings a terminal's CLI conversation back after a restart.
//
// A pane used to come back with `claude --resume <id>` whatever it had been
// running, which would have started Claude in a pane that was talking to Codex.
// The id was checked to be a UUID in main before it was recorded; it is checked
// again here because it is about to be typed into a shell.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type TerminalCli = 'claude' | 'codex'

export function resumeCommand(session: string | null | undefined, cli: TerminalCli | null | undefined): string | null {
  if (!session || !UUID_RE.test(session)) return null
  return cli === 'codex' ? `codex resume ${session}` : `claude --resume ${session}`
}
