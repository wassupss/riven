import { create } from 'zustand'

// Tracks files edited by an agent (external process) so the editor can auto-open
// them and show what changed. `before`/`after` drive the inline diff.
export interface AgentEdit {
  before: string
  after: string
  hasBaseline: boolean
}

interface AgentEditsState {
  edits: Record<string, AgentEdit>
  set: (path: string, edit: AgentEdit) => void
  clear: (path: string) => void
}

export const useAgentEdits = create<AgentEditsState>((set) => ({
  edits: {},
  set: (path, edit) => set((s) => ({ edits: { ...s.edits, [path]: edit } })),
  clear: (path) =>
    set((s) => {
      if (!(path in s.edits)) return s
      const edits = { ...s.edits }
      delete edits[path]
      return { edits }
    })
}))

// Last-known content per path — the baseline for diffing an agent edit. Updated
// whenever the editor loads or saves a file, and after an edit is processed.
const cache = new Map<string, string>()
export const cacheGet = (p: string): string | undefined => cache.get(p)
export const cacheSet = (p: string, content: string): void => {
  cache.set(p, content)
}
