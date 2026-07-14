import { create } from 'zustand'

// A file path the explorer should reveal: ancestor folders auto-expand and the
// row scrolls into view. Set whenever the active editor file changes.
interface ExplorerRevealState {
  target: string | null
  reveal: (path: string) => void
}

export const useExplorerReveal = create<ExplorerRevealState>((set) => ({
  target: null,
  reveal: (path) => set({ target: path })
}))
