import { create } from 'zustand'

// What a chat has going on besides its conversation: backgrounded commands,
// subagents still out, work handed to another pane. Each chat pane keeps these
// in its own state for the strips above its composer; it also publishes them
// here so something outside the pane (the phone, through state/remote) can see
// them without reaching into a component.

export interface LiveWork {
  bg: Array<{ id: string; label: string; since?: number }>
  agents: Array<{ id: string; label: string; since: number; steps: number; lastActivityAt: number }>
  delegations: Array<{ id: string; label: string; since: number }>
}

export type TaskOutcome = 'done' | 'stopped' | 'failed'

export interface TaskFinished {
  chatKey: string
  label: string
  outcome: TaskOutcome
  durationMs?: number
}

interface State {
  byChat: Record<string, LiveWork>
}

export const useChatWork = create<State>(() => ({ byChat: {} }))

const isEmpty = (w: LiveWork): boolean => !w.bg.length && !w.agents.length && !w.delegations.length

/** Record a chat's current work. Only a real change touches the store. */
export function publishWork(chatKey: string, w: LiveWork | null): void {
  const all = useChatWork.getState().byChat
  const prev = all[chatKey]
  if (!w || isEmpty(w)) {
    if (!prev) return
    const next = { ...all }
    delete next[chatKey]
    useChatWork.setState({ byChat: next })
    return
  }
  if (prev && JSON.stringify(prev) === JSON.stringify(w)) return
  useChatWork.setState({ byChat: { ...all, [chatKey]: w } })
}

/** How many things a chat has running outside its turn. */
export function workCount(chatKey: string): number {
  const w = useChatWork.getState().byChat[chatKey]
  return w ? w.bg.length + w.agents.length + w.delegations.length : 0
}

// A finished background task is an event, not a state: it is gone from the
// list the moment it ends, so whoever wants to say it ended has to be told.
const finished = new Set<(f: TaskFinished) => void>()

export function onTaskFinished(fn: (f: TaskFinished) => void): () => void {
  finished.add(fn)
  return () => finished.delete(fn)
}

export function reportTaskFinished(f: TaskFinished): void {
  for (const fn of finished) fn(f)
}
