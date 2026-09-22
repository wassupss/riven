import { create } from 'zustand'

// What the agents said to each other.
//
// A delegation only ever appeared inside the target's own pane: the question in
// its transcript, the answer scrolling past in whoever asked. With three agents
// working there was no way to see who asked whom for what, which of them was
// waiting, or why everything had gone quiet — the collaboration was real but
// invisible, and a failure looked identical to a long think.
//
// So every ask, answer, refusal and roster change is recorded here, per
// workspace, and the group panel draws it as one timeline.
//
// Deliberately not persisted: it is an activity view of what is happening now,
// and keeping transcript-sized text in sessions.json for every exchange would
// bloat the file that restores the app.

export type GroupEventKind = 'ask' | 'reply' | 'error' | 'roster'

export interface GroupEvent {
  id: string
  ws: string
  /** The group this belongs to, or null for a delegation outside any group. */
  group: string | null
  at: number
  kind: GroupEventKind
  from: string
  to?: string
  text: string
}

/** Per workspace. Old entries fall off the end — this is a view, not an archive. */
export const LOG_CAP = 200
/** One exchange must not be able to push everything else out of the view. */
export const TEXT_CAP = 400

export function clip(text: string, cap = TEXT_CAP): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > cap ? t.slice(0, cap) + '…' : t
}

export function append(list: GroupEvent[], event: GroupEvent, cap = LOG_CAP): GroupEvent[] {
  const next = [...list, event]
  return next.length > cap ? next.slice(next.length - cap) : next
}

interface State {
  byWorkspace: Record<string, GroupEvent[]>
  add: (e: Omit<GroupEvent, 'id' | 'at'> & { at?: number }) => void
  clear: (ws: string) => void
}

let seq = 0

export const useGroupLog = create<State>((set) => ({
  byWorkspace: {},
  add: (e) =>
    set((s) => {
      const event: GroupEvent = {
        ...e,
        text: clip(e.text),
        id: `ge${++seq}`,
        at: e.at ?? Date.now()
      }
      return { byWorkspace: { ...s.byWorkspace, [e.ws]: append(s.byWorkspace[e.ws] ?? [], event) } }
    }),
  clear: (ws) =>
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [ws]: [] } }))
}))

/** The timeline for a workspace, optionally narrowed to one group. */
export function eventsFor(ws: string, group?: string | null): GroupEvent[] {
  const all = useGroupLog.getState().byWorkspace[ws] ?? []
  return group ? all.filter((e) => e.group === group) : all
}

/**
 * Which way work is flowing right now: every "X asked Y" that Y has not answered
 * yet, as `from>to`. The chart draws these edges as moving, so a team at work
 * reads as a flow rather than a still diagram — you can see which delegation is
 * outstanding, not just that a pane is busy.
 */
export function activeEdges(events: GroupEvent[]): Set<string> {
  const waiting = new Map<string, string>() // target → who is waiting on it
  for (const e of events) {
    if (e.kind === 'ask' && e.to) waiting.set(e.to, e.from)
    // An answer (or a failure) from the target closes what was asked of it.
    else if ((e.kind === 'reply' || e.kind === 'error') && waiting.has(e.from)) waiting.delete(e.from)
  }
  return new Set([...waiting].map(([to, from]) => `${from}>${to}`))
}
