import { create } from 'zustand'

// Multi-file selection in the explorer (for sending several files to a terminal).
interface SelectionState {
  selected: string[]
  single: (path: string) => void
  toggle: (path: string) => void
  clear: () => void
}

export const useSelection = create<SelectionState>((set) => ({
  selected: [],
  single: (path) => set({ selected: [path] }),
  toggle: (path) =>
    set((s) =>
      s.selected.includes(path)
        ? { selected: s.selected.filter((p) => p !== path) }
        : { selected: [...s.selected, path] }
    ),
  clear: () => set({ selected: [] })
}))
