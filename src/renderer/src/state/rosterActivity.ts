import type { AgentActivity } from './agents'

// The pure half of the roster: what one pane's raw signals MEAN. Kept apart from
// roster.ts so it carries no window/session dependency and can be tested directly.

export type PaneKind = 'chat' | 'terminal'

// Live signals for one pane, keyed by pane key in roster.ts. Fed by ONE
// app-level subscription to main's broadcasts rather than by each panel, so a
// pane going off screen no longer takes its status with it.
//
// `done` in particular has to live here and not in the panel: a turn that
// finishes in an unmounted workspace has no panel to record it, which is exactly
// the case where you most need to be told.
export interface Live {
  agent?: boolean // terminal: a CLI agent is running
  name?: string | null // terminal: the agent's name, from pty:agent
  title?: string // terminal: the pty title
  busy?: boolean
  attention?: 'finished' | 'needs_input' | null
  done?: boolean
}

export interface RosterEntry {
  id: string // pane key: chat-N | term-N
  workspace: string
  kind: PaneKind
  title: string
  busy: boolean
  // Waiting on the user (a permission prompt / idle prompt), not merely finished.
  attention: boolean
  // Finished a turn and nobody has acknowledged it yet.
  done: boolean
  status: AgentActivity
}

// Fold one pane's signals into the activity the UI shows. The priority order —
// and the rule that `done` outlives everything until it is acknowledged — is
// pinned down in roster.test.ts.
//
// `pane` is a mounted chat controller's own status, or null (a terminal, or a
// chat whose panel isn't mounted).
export function activityOf(
  l: Live,
  pane: AgentActivity | null
): { busy: boolean; attention: boolean; done: boolean; status: AgentActivity } {
  const busy = !!l.busy || pane === 'busy'
  // A terminal's attention flag lives in main and carries its reason: only
  // needs_input is "waiting on you"; `finished` is a completion.
  const attention = l.attention === 'needs_input'
  // Still running? Then a stale completion from the PREVIOUS turn is not news.
  const done = !busy && (!!l.done || l.attention === 'finished' || pane === 'done')
  const status: AgentActivity = busy ? 'busy' : attention ? 'waiting' : done ? 'done' : 'idle'
  return { busy, attention, done, status }
}
