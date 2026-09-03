import { create } from 'zustand'

export type PaletteMode = 'files' | 'commands' | null
export type SettingsTab = 'general' | 'ai' | 'keys' | 'account' | 'about'

interface UIState {
  keybindingsOpen: boolean
  setKeybindingsOpen: (v: boolean) => void
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
  settingsTab: SettingsTab
  openSettings: (tab?: SettingsTab) => void
  showExplorer: boolean
  toggleExplorer: () => void
  // The entire left sidebar (workspaces + explorer + usage). ⌘B toggles this.
  showSidebar: boolean
  toggleSidebar: () => void
  // True only while ⌘ (Meta) is held — used to peek the workspace ⌘N hints.
  metaHeld: boolean
  setMetaHeld: (v: boolean) => void
  palette: PaletteMode
  setPalette: (v: PaletteMode) => void
  // Quick-panel dialog (new terminal / panels / view actions), keyboard-driven.
  quickPanel: boolean
  // When set, the picker opens as a SPLIT: the chosen panel is placed beside the
  // active one in this direction (⌘D / ⌘⇧D). null = normal open.
  quickSplitDir: 'right' | 'below' | null
  setQuickPanel: (v: boolean, splitDir?: 'right' | 'below' | null) => void
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
  showSidebar: true,
  toggleSidebar: () => set((s) => ({ showSidebar: !s.showSidebar })),
  metaHeld: false,
  setMetaHeld: (v) => set((s) => (s.metaHeld === v ? s : { metaHeld: v })),
  // The three keyboard-driven overlays (palette / quick-panel / agent-picker) are
  // mutually exclusive: opening one closes the others so two can't render stacked
  // and fight over focus/keys.
  palette: null,
  setPalette: (v) => set(v ? { palette: v, quickPanel: false, agentPicker: null } : { palette: null }),
  quickPanel: false,
  quickSplitDir: null,
  setQuickPanel: (v, splitDir = null) =>
    set(
      v
        ? { quickPanel: true, quickSplitDir: splitDir, palette: null, agentPicker: null }
        : { quickPanel: false, quickSplitDir: null }
    ),
  agentPicker: null,
  setAgentPicker: (v) => set(v ? { agentPicker: v, palette: null, quickPanel: false } : { agentPicker: null })
}))
