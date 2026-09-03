import { create } from 'zustand'

// Backs the `ask_user` MCP tool: an agent asks the user to pick one option, and
// the tool call blocks (in the main process) until the user chooses here. Only
// one prompt shows at a time; a second request queues behind it.

export interface AskRequest {
  id: string
  question: string
  options: string[]
  resolve: (choice: string) => void
}

interface AskUserState {
  queue: AskRequest[]
  current: AskRequest | null
  enqueue: (req: AskRequest) => void
  answer: (choice: string) => void
  cancel: () => void
}

export const useAskUser = create<AskUserState>((set, get) => ({
  queue: [],
  current: null,
  enqueue: (req) =>
    set((s) => {
      if (s.current) return { queue: [...s.queue, req] }
      return { current: req }
    }),
  answer: (choice) => {
    const cur = get().current
    if (!cur) return
    cur.resolve(choice)
    set((s) => {
      const [next, ...rest] = s.queue
      return { current: next ?? null, queue: rest }
    })
  },
  cancel: () => {
    const cur = get().current
    if (!cur) return
    cur.resolve('riven: the user dismissed the question')
    set((s) => {
      const [next, ...rest] = s.queue
      return { current: next ?? null, queue: rest }
    })
  }
}))
