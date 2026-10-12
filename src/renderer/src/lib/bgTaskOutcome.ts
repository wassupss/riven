// How a background task ended, as the pane should tell it.
//
// The CLI has four statuses and riven used to read anything but `completed` as
// a failure. Most of those "failures" were the agent shutting down its own dev
// server once the work was done: `pkill` ends it on a signal, the shell exits
// 128+N (143, 144, 137), and the CLI reports "failed with exit code 144". That is
// a stop, not a failure. So are `killed` (TaskStop, the background time limit)
// and `stopped` (the session ended under it). A real non-zero exit — a test run,
// a lint — still fails.
export type BgTaskOutcome = 'done' | 'stopped' | 'failed'

export function bgTaskOutcome(status: string, summary?: string | null): BgTaskOutcome {
  if (status === 'completed') return 'done'
  if (status === 'killed' || status === 'stopped') return 'stopped'
  const code = /exit code (\d+)/i.exec(summary ?? '')
  if (code && Number(code[1]) > 128) return 'stopped'
  return 'failed'
}
