// Turn bookkeeping for a chat transcript.
//
// An answer bubble is created the moment a turn starts and closed when the turn
// reports it is done — but only the LATEST one was ever closed. Anything that
// opened a second bubble (a message queued mid-turn, a turn that started while
// the pane was unmounted) left the earlier one open, and an open bubble shimmers
// "생각 중" forever, in the middle of a finished conversation.
//
// So: when a turn ends, every older bubble is settled too — dropped when it
// never received anything (an empty placeholder is not a turn that happened),
// closed as interrupted when it did.

export interface TurnLike {
  role: 'user' | 'assistant'
  text: string
  items: unknown[]
  done: boolean
  interrupted: boolean
  startedAt: number
  durationMs: number
  completedAt?: number
}

function isEmpty(m: TurnLike): boolean {
  return !m.text.trim() && m.items.length === 0
}

// `keepLast` leaves the newest answer alone: while a turn is running that bubble
// is supposed to be open.
export function settleStaleTurns<T extends TurnLike>(msgs: T[], now = Date.now(), keepLast = true): T[] {
  let lastOpen = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && !msgs[i].done) {
      lastOpen = i
      break
    }
  }
  const out: T[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant' || m.done || (keepLast && i === lastOpen)) {
      out.push(m)
      continue
    }
    if (isEmpty(m)) continue // nothing ever arrived in it
    out.push({
      ...m,
      done: true,
      interrupted: true,
      durationMs: m.durationMs || Math.max(0, now - m.startedAt),
      completedAt: m.completedAt ?? now
    })
  }
  return out
}

// Which turn an event belongs to.
//
// The CLI's stream says "a turn finished" without saying WHICH turn, and riven
// used to apply that to whatever answer bubble was open. Normally the same
// thing — but not when a turn was ended on this side first (Esc/Stop, a steer,
// the no-response watchdog) and the user has already sent the next message: the
// old turn's late result then closed the NEW bubble a second after it opened,
// so the message looked answered when nothing had answered it.
//
// Every send now carries an id, main hands each result back to the turn that
// asked for it (results come back in order, one per message), and an event for
// a turn that is no longer the open one is dropped.
export function isStaleEvent(
  eventTurn: string | null | undefined,
  openTurn: string | null | undefined
): boolean {
  // Untagged either side — a restored pane, a revived child, an older main —
  // behaves exactly as before rather than dropping events it cannot place.
  if (!eventTurn || !openTurn) return false
  return eventTurn !== openTurn
}
