import { create } from 'zustand'
import { resolveAgent } from './agents'

// Scheduled messages: send a prompt to an agent pane at a future time, optionally
// repeating. Not a native feature — a riven-electron addition. Persisted so
// schedules survive restarts; a single module-level ticker fires the due ones.

export type Repeat = 'none' | 'hourly' | 'daily'

export interface Scheduled {
  id: string
  workspace: string
  chatKey: string // target agent pane
  targetTitle: string // for display + a fallback resolve if the pane was reopened
  text: string
  fireAt: number
  repeat: Repeat
  createdAt: number
}

const LS_KEY = 'scheduled:v1'

function load(): Scheduled[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw) as Scheduled[]
  } catch {
    /* ignore */
  }
  return []
}
function persist(items: Scheduled[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(items))
  } catch {
    /* ignore */
  }
}

interface State {
  items: Scheduled[]
  add: (s: Omit<Scheduled, 'id' | 'createdAt'>) => string
  remove: (id: string) => void
  replaceAll: (items: Scheduled[]) => void
}

export const useScheduled = create<State>((set) => ({
  items: load(),
  add: (s) => {
    const id = `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    set((st) => {
      const items = [...st.items, { ...s, id, createdAt: Date.now() }]
      persist(items)
      return { items }
    })
    return id
  },
  remove: (id) =>
    set((st) => {
      const items = st.items.filter((i) => i.id !== id)
      persist(items)
      return { items }
    }),
  replaceAll: (items) => {
    persist(items)
    set({ items })
  }
}))

export function schedulesFor(workspace: string, chatKey: string): Scheduled[] {
  return useScheduled
    .getState()
    .items.filter((i) => i.workspace === workspace && i.chatKey === chatKey)
    .sort((a, b) => a.fireAt - b.fireAt)
}

function nextFire(fireAt: number, repeat: Repeat): number {
  if (repeat === 'hourly') return fireAt + 3600_000
  if (repeat === 'daily') return fireAt + 86_400_000
  return 0
}

// ---- ticker: fire due schedules ---------------------------------------------
let started = false
export function startScheduler(): void {
  if (started) return
  started = true
  const tick = (): void => {
    const now = Date.now()
    const { items } = useScheduled.getState()
    const due = items.filter((i) => i.fireAt <= now)
    if (due.length === 0) return
    const remaining: Scheduled[] = []
    for (const i of items) {
      if (i.fireAt > now) {
        remaining.push(i)
        continue
      }
      // Deliver to the target pane (by key, else by title if it was reopened).
      const agent = resolveAgent(i.chatKey) ?? resolveAgent(i.targetTitle)
      if (agent) agent.send(i.text)
      else {
        try {
          window.api.notify.show('예약 메시지', `${i.targetTitle}: 대상 패널이 닫혀 전송하지 못했습니다`)
        } catch {
          /* ignore */
        }
      }
      // Reschedule a repeating one; otherwise drop it.
      if (i.repeat !== 'none') {
        let next = nextFire(i.fireAt, i.repeat)
        while (next <= now) next = nextFire(next, i.repeat) // catch up past misses
        remaining.push({ ...i, fireAt: next })
      }
    }
    useScheduled.getState().replaceAll(remaining)
  }
  setInterval(tick, 15_000)
  // Also fire soon after start to catch anything already overdue from last session.
  setTimeout(tick, 2_000)
}
