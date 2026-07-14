import { create } from 'zustand'

export type PaletteMode = 'files' | 'commands' | null
export type SettingsTab = 'general' | 'ai' | 'keys' | 'account'

interface UIState {
  keybindingsOpen: boolean
  setKeybindingsOpen: (v: boolean) => void
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
  settingsTab: SettingsTab
  openSettings: (tab?: SettingsTab) => void
  showExplorer: boolean
  toggleExplorer: () => void
  palette: PaletteMode
  setPalette: (v: PaletteMode) => void
  // Workspace awaiting an agent to be launched (send-to-LLM with none running).
  agentPicker: string | null
  setAgentPicker: (v: string | null) => void
}

export const useUI = create<UIState>((set) => ({
  keybindingsOpen: false,
  setKeybindingsOpen: (v) => set({ keybindingsOpen: v }),
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  settingsTab: 'general',
  openSettings: (tab = 'general') => set({ settingsOpen: true, settingsTab: tab }),
  showExplorer: true,
  toggleExplorer: () => set((s) => ({ showExplorer: !s.showExplorer })),
  palette: null,
  setPalette: (v) => set({ palette: v }),
  agentPicker: null,
  setAgentPicker: (v) => set({ agentPicker: v })
}))
