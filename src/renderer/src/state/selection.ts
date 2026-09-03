import { create } from 'zustand'

// Multi-file selection in the explorer (⌘-click toggle, ⇧-click range, for
// sending/deleting several files at once). `anchor` is the last plain/⌘ click —
// the fixed end a ⇧-click range extends from.
interface SelectionState {
  selected: string[]
  anchor: string | null
  single: (path: string) => void
  toggle: (path: string) => void
  setRange: (paths: string[]) => void
  clear: () => void
}

export const useSelection = create<SelectionState>((set) => ({
  selected: [],
  anchor: null,
  single: (path) => set({ selected: [path], anchor: path }),
  toggle: (path) =>
    set((s) => ({
      selected: s.selected.includes(path)
        ? s.selected.filter((p) => p !== path)
        : [...s.selected, path],
      anchor: path
    })),
  // ⇧-click range: replace the selection with the given ordered paths, keeping
  // the existing anchor so a subsequent ⇧-click re-extends from the same origin.
  setRange: (paths) => set({ selected: paths }),
  clear: () => set({ selected: [], anchor: null })
}))
