import { create } from 'zustand'

// Backs the `ask_user` MCP tool: an agent asks the user something and the tool
// call blocks (in the main process) until the user answers here.
//
// A request is bound to the chat pane that asked (chatKey), so it renders INLINE
// in that conversation — not as a global dialog that would interrupt whatever
// workspace you happen to be looking at. Requests with no pane (e.g. a terminal
// agent) fall back to the modal so they can't be lost.

export interface AskRequest {
  id: string
  chatKey: string | null // the pane that asked; null ⇒ show the fallback modal
  question: string
  options: string[]
  resolve: (choice: string) => void
  // The asking agent gave up (killed, or its own tool timeout). The question
  // stays visible but stops accepting answers: silently removing it would make
  // the user think their click was registered.
  expired?: boolean
}

interface AskUserState {
  pending: AskRequest[]
  enqueue: (req: AskRequest) => void
  // Answer a specific request (a chosen option or free-typed text).
  answer: (id: string, choice: string) => void
  cancel: (id: string) => void
  // The agent stopped listening: keep the card, mark it dead, unblock the tool.
  expire: (id: string) => void
  // Remove an expired card the user has acknowledged.
  dismiss: (id: string) => void
  // The oldest request that isn't bound to a pane (drives the fallback modal).
  unattached: () => AskRequest | null
}

export const useAskUser = create<AskUserState>((set, get) => ({
  pending: [],
  enqueue: (req) => set((s) => ({ pending: [...s.pending, req] })),
  answer: (id, choice) => {
    const req = get().pending.find((r) => r.id === id)
    if (!req || req.expired) return
    req.resolve(choice)
    set((s) => ({ pending: s.pending.filter((r) => r.id !== id) }))
  },
  cancel: (id) => {
    const req = get().pending.find((r) => r.id === id)
    if (!req) return
    req.resolve('riven: the user dismissed the question')
    set((s) => ({ pending: s.pending.filter((r) => r.id !== id) }))
  },
  expire: (id) => {
    const req = get().pending.find((r) => r.id === id)
    if (!req || req.expired) return
    // Resolve so the tool's promise isn't left hanging; nobody is listening for
    // the value any more (main already dropped the call).
    req.resolve('riven: the agent stopped waiting for an answer')
    set((s) => ({
      pending: s.pending.map((r) => (r.id === id ? { ...r, expired: true } : r))
    }))
  },
  dismiss: (id) => set((s) => ({ pending: s.pending.filter((r) => r.id !== id) })),
  unattached: () => get().pending.find((r) => !r.chatKey) ?? null
}))
