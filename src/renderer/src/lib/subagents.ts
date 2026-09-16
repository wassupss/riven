// Which delegated agents are running right now, and whether they are still
// doing anything.
//
// A subagent is a `Task`/`Agent` tool call whose result has not arrived. Its
// card sits wherever it appeared in the transcript, which is fine until the
// conversation scrolls past it: then work is happening with nothing on screen
// saying so. Worse, an agent that quietly dies looks exactly like one that is
// thinking — the only difference is that nothing has happened for a while, and
// that is only visible if someone is tracking the time.

export interface SubagentLine {
  name: string
  detail: string
  toolId?: string | null
  parent?: string | null
  done?: boolean
  error?: boolean
  interrupted?: boolean
  startedAt?: number
}

export interface RunningSubagent {
  toolId: string
  label: string
  startedAt: number
  // Latest sign of life: its own start, or the newest tool call made inside it.
  lastActivityAt: number
  steps: number
}

export const isSubagentTool = (name: string): boolean => name === 'Agent' || name === 'Task'

export function activeSubagents(lines: SubagentLine[]): RunningSubagent[] {
  const running = new Map<string, RunningSubagent>()
  for (const l of lines) {
    if (!isSubagentTool(l.name) || !l.toolId) continue
    if (l.done || l.error || l.interrupted) continue
    const startedAt = l.startedAt ?? 0
    running.set(l.toolId, {
      toolId: l.toolId,
      label: l.detail?.trim() || l.name,
      startedAt,
      lastActivityAt: startedAt,
      steps: 0
    })
  }
  // A nested call is the subagent's heartbeat.
  for (const l of lines) {
    if (!l.parent) continue
    const agent = running.get(l.parent)
    if (!agent) continue
    agent.steps++
    if ((l.startedAt ?? 0) > agent.lastActivityAt) agent.lastActivityAt = l.startedAt ?? 0
  }
  const out = [...running.values()]
  // Oldest first: the one that has been going longest is the one worth looking
  // at, and it is also the one most likely to be stuck.
  out.sort((a, b) => a.startedAt - b.startedAt)
  return out
}

// Has this one gone quiet? Kept separate so the component can tick a clock
// without recomputing the list. It is a hint, not a verdict: one long step (a
// big search, a slow API call) is legitimately quiet.
export function isQuiet(agent: RunningSubagent, now: number, quietMs: number): boolean {
  return agent.lastActivityAt > 0 && now - agent.lastActivityAt >= quietMs
}
