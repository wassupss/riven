import { create } from 'zustand'

// Work an agent handed to another agent WITHOUT waiting for it (riven_ask_agent
// with wait=false), per pane that handed it off.
//
// It used to be fire-and-forget: the caller was told "(async)", said it would
// report back when the work was done, and never heard another word — the answer
// went to the group log and nowhere else, so the lead sat idle while its members
// finished. Now the pane shows each one as a background task, the way it shows a
// command the CLI left running, and the answer is brought back to the caller
// when it lands (see mcpTools, askOneAgent).
//
// Not persisted: an answer can only come back to the process that asked, so a
// restart ends these along with the turns they were waiting on.

export interface Delegation {
  id: string
  /** The pane that handed the work off, and gets the answer. */
  from: string
  /** The pane doing it. */
  to: string
  toTitle: string
  startedAt: number
}

interface State {
  byPane: Record<string, Delegation[]>
  start: (d: Omit<Delegation, 'id' | 'startedAt'>) => Delegation
  finish: (id: string) => Delegation | null
}

let seq = 0

export const useDelegations = create<State>((set, get) => ({
  byPane: {},
  start: (d) => {
    const full: Delegation = { ...d, id: `dg${++seq}`, startedAt: Date.now() }
    set((s) => ({ byPane: { ...s.byPane, [d.from]: [...(s.byPane[d.from] ?? []), full] } }))
    return full
  },
  finish: (id) => {
    for (const [pane, list] of Object.entries(get().byPane)) {
      const hit = list.find((d) => d.id === id)
      if (!hit) continue
      const rest = list.filter((d) => d.id !== id)
      set((s) => {
        const byPane = { ...s.byPane }
        if (rest.length) byPane[pane] = rest
        else delete byPane[pane]
        return { byPane }
      })
      return hit
    }
    return null
  }
}))

const EMPTY: Delegation[] = []
export const delegationsOf = (s: State, pane: string): Delegation[] => s.byPane[pane] ?? EMPTY
