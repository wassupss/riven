// Which message a `result` answers.
//
// The CLI answers messages in order but never says which one a result ends, so
// riven keeps the ids of the messages it has sent and pops the oldest. That
// holds for every turn a human started — and breaks for the turns the CLI
// starts BY ITSELF.
//
// It does that when a backgrounded command finishes while the CLI is idle: it
// runs a short turn to report the outcome, which emits a result like any other.
// A message sent in that window got that result and was marked answered seconds
// after being sent, with its real work still running.
//
// So a background report CLAIMS the next result instead of letting it pop the
// queue — and the claim expires, because a claim that never gets used would
// swallow a real answer and leave the pane thinking forever.

export interface TurnQueue {
  /** Ids of messages sent and not yet answered, oldest first. */
  turns: string[]
  /** Results expected from turns the CLI started to report a background task. */
  autoTurns: number
  /** When the most recent of those was announced. */
  autoTurnAt: number
}

export const AUTO_TURN_WINDOW_MS = 60_000

/**
 * The CLI says a background task finished.
 *
 * Only counted when nothing is waiting for an answer: a task that ends mid-turn
 * is folded into that turn by the CLI, with no extra result to account for.
 */
export function noteBackgroundReport(q: TurnQueue, now = Date.now()): void {
  if (q.turns.length) return
  q.autoTurns++
  q.autoTurnAt = now
}

/** The turn this result ends, or null when the CLI is answering itself. */
export function claimResult(q: TurnQueue, now = Date.now()): string | null {
  if (q.autoTurns > 0) {
    if (now - q.autoTurnAt < AUTO_TURN_WINDOW_MS) {
      q.autoTurns--
      return null
    }
    q.autoTurns = 0 // the report never came; stop expecting it
  }
  return q.turns.shift() ?? null
}
