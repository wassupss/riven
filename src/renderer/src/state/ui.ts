import { create } from 'zustand'

interface UIState {
  keybindingsOpen: boolean
  setKeybindingsOpen: (v: boolean) => void
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
  showExplorer: boolean
  toggleExplorer: () => void
}

export const useUI = create<UIState>((set) => ({
  keybindingsOpen: false,
  setKeybindingsOpen: (v) => set({ keybindingsOpen: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  showExplorer: true,
  toggleExplorer: () => set((s) => ({ showExplorer: !s.showExplorer }))
}))
