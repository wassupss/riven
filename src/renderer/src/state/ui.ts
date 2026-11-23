import { create } from 'zustand'

export type PaletteMode = 'files' | 'commands' | null
export type SettingsTab =
  | 'general'
  | 'editor'
  | 'terminal'
  | 'ai'
  | 'perm'
  | 'notify'
  | 'remote'
  | 'pet'
  | 'keys'
  | 'account'
  | 'about'

interface UIState {
  keybindingsOpen: boolean
  setKeybindingsOpen: (v: boolean) => void
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
  settingsTab: SettingsTab
  openSettings: (tab?: SettingsTab) => void
  /** Bumped to open Settings > 리븐펫 with the decoration layout of the shown pet open. */
  petLayoutAsk: number
  openPetLayout: () => void
  /** Bumped to open Settings > 리븐펫 with the motion editor (움직임) of the shown pet open. */
  petMotionAsk: number
  openPetMotion: () => void
  /** Set to open Settings > 리븐펫 with the species maker open on a new species; taken (cleared) by it. */
  petMakerAsk: boolean
  openPetMaker: () => void
  /** The species maker is open over Settings: Escape is its, not Settings'. */
  petMakerOpen: boolean
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
  petLayoutAsk: 0,
  openPetLayout: () => set((s) => ({ settingsOpen: true, settingsTab: 'pet', petLayoutAsk: s.petLayoutAsk + 1 })),
  petMotionAsk: 0,
  openPetMotion: () => set((s) => ({ settingsOpen: true, settingsTab: 'pet', petMotionAsk: s.petMotionAsk + 1 })),
  petMakerAsk: false,
  openPetMaker: () => set({ settingsOpen: true, settingsTab: 'pet', petMakerAsk: true }),
  petMakerOpen: false,
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
