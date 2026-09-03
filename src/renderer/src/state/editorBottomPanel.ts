import { create } from 'zustand'

// The editor's bottom drawer (VS Code-style Problems / Output). Scoped to the code
// editor — NOT a global dock panel. Toggled from the editor status bar / palette.
export type BottomTab = 'problems' | 'output' | 'debug'

interface State {
  open: boolean
  tab: BottomTab
  openTab: (tab: BottomTab) => void
  toggle: (tab?: BottomTab) => void
  close: () => void
}

export const useEditorBottom = create<State>((set) => ({
  open: false,
  tab: 'problems',
  openTab: (tab) => set({ open: true, tab }),
  toggle: (tab) =>
    set((s) => {
      if (!tab) return { open: !s.open }
      if (s.open && s.tab === tab) return { open: false } // same tab toggles closed
      return { open: true, tab }
    }),
  close: () => set({ open: false })
}))
