import { askChatTurn, resolveAgent } from './agents'
import { rosterFor, type RosterEntry } from './roster'

// Ask ANY agent in a workspace and get its answer — a native chat pane or a CLI
// running in a riven terminal.
//
// The two are driven differently (one takes a message, the other is typed at),
// and that difference used to live inside the MCP tool layer, so anything else
// that wanted an answer — the group panel, a goal round — could only talk to
// chat panes. A terminal agent could be delegated to by another AGENT but could
// not be part of a team. This is that logic, in one place, for both callers.

export const ASK_TIMEOUT_MS = 5 * 60_000

/** A CLI that reports its turns (Claude Code, Codex) answers; anything else is fire-and-forget. */
export function canReply(entry: RosterEntry): boolean {
  return entry.kind === 'chat' ? true : !!entry.replies
}

export function rosterEntry(ws: string, paneId: string): RosterEntry | null {
  return rosterFor(ws).find((e) => e.id === paneId) ?? null
}

export function terminalReply(pane: string, quietMs: number, timeoutText: string): Promise<string> {
  return new Promise((resolve) => {
    // Give up on SILENCE, not on elapsed time: a CLI still printing is still
    // working, and a long build used to be declared unanswered mid-run (see
    // askChatTurnNow, which does the same for chat panes).
    let lastSeen = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const done = (text: string): void => {
      clearTimeout(timer)
      offData()
      offReply()
      resolve(text)
    }
    const tick = (): void => {
      const left = quietMs - (Date.now() - lastSeen)
      if (left <= 0) return done(timeoutText)
      timer = setTimeout(tick, Math.min(left, 5_000))
    }
    timer = setTimeout(tick, Math.min(quietMs, 5_000))
    const offData = window.api.pty.onData(pane, () => {
      lastSeen = Date.now()
    })
    const offReply = window.api.pty.onReply(({ key, text }) => {
      if (key === pane) done(text)
    })
  })
}

export async function askAnyAgent(
  entry: RosterEntry,
  message: string,
  ws: string,
  opts: { wait?: boolean; timeoutMs?: number; timeoutText?: string } = {}
): Promise<string> {
  const wait = opts.wait !== false
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS
  const timeoutText = opts.timeoutText ?? '(no reply within 5 min)'

  if (entry.kind === 'terminal') {
    // Writing into a running turn would be read as an answer to whatever the CLI
    // is currently asking, so a busy terminal is refused rather than corrupted.
    if (entry.busy)
      return `error: "${entry.title}" is mid-turn; its CLI would read this as an answer to what it is currently asking.`
    const replyP = wait && entry.replies ? terminalReply(entry.id, timeoutMs, timeoutText) : null
    // Typed the way a person types it: the text, a pause, then Enter on its own.
    // One burst ending in CR leaves the message sitting unsent in a TUI's box.
    // Newlines collapse to spaces, because each one would submit by itself.
    window.api.pty.write(entry.id, message.replace(/\r?\n/g, ' '))
    await new Promise((r) => setTimeout(r, 120))
    window.api.pty.write(entry.id, '\r')
    if (!replyP) return `typed into "${entry.title}"${wait ? " — this CLI doesn't report its turns" : ' (async)'}`
    return replyP
  }

  const target = resolveAgent(entry.id, undefined, ws)
  if (!target)
    return `error: "${entry.title}" exists but its panel isn't mounted, so it cannot receive a message.`
  const answer = askChatTurn(target, message, timeoutMs, timeoutText)
  if (!wait) {
    void answer
    return `delegated to "${target.getTitle()}" (async)`
  }
  return answer
}
