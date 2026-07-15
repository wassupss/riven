import { create } from 'zustand'

export interface Settings {
  theme: string
  editorKeymap: string
  editorFontFamily: string
  editorFontSize: number
  terminalFontFamily: string
  terminalFontSize: number
  terminalBackground: string
  terminalForeground: string
  terminalCursor: string
  // AI inline completion (ghost text) — off by default to stay lightweight.
  aiComplete: boolean
  aiProvider: string
  aiCompleteEndpoint: string
  aiCompleteModel: string
  aiApiKey: string
  language: 'ko' | 'en'
  importedFonts: Array<{ family: string; dataUrl: string }>
  usagePinned: boolean
  // Run the language formatter on ⌘S before writing to disk.
  formatOnSave: boolean
  // Named "new terminal" presets: each runs `command` in a fresh terminal.
  terminalProfiles: Array<{ name: string; command: string }>
  // Editor snippets: typing `prefix` offers `body` (supports ${1} tab stops).
  snippets: Array<{ prefix: string; body: string }>
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'ember',
  editorKeymap: 'vscode',
  editorFontFamily: 'Menlo, Monaco, "Courier New", monospace',
  editorFontSize: 13,
  aiComplete: false,
  aiProvider: 'ollama',
  aiCompleteEndpoint: 'http://localhost:11434',
  aiCompleteModel: 'qwen2.5-coder:1.5b',
  aiApiKey: '',
  language: 'ko',
  importedFonts: [],
  usagePinned: false,
  formatOnSave: false,
  terminalProfiles: [{ name: 'claude', command: 'claude' }],
  snippets: [{ prefix: 'clg', body: 'console.log($1)' }],
  terminalFontFamily:
    '"D2Coding", "MesloLGS NF", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, monospace',
  terminalFontSize: 12,
  terminalBackground: '#101113',
  terminalForeground: '#e3e5ea',
  terminalCursor: '#ff7847'
}

interface SettingsState {
  settings: Settings
  ready: boolean
  hydrate: (partial: Partial<Settings>) => void
  set: (partial: Partial<Settings>) => void
  reset: () => void
}

// The old default terminal-font stack. Users who never customized it (their saved
// value matches this) are migrated to the new D2Coding-first default so Korean
// renders crisply in the terminal without a manual reset. Only the TERMINAL font
// changes — the editor/UI fonts are left as they were.
const LEGACY_TERMINAL_FONT =
  '"MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, monospace'

export const useSettings = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  ready: false,
  hydrate: (partial) => {
    const merged = { ...DEFAULT_SETTINGS, ...partial }
    if (partial.terminalFontFamily === LEGACY_TERMINAL_FONT)
      merged.terminalFontFamily = DEFAULT_SETTINGS.terminalFontFamily
    set({ settings: merged, ready: true })
  },
  set: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
  reset: () => set({ settings: DEFAULT_SETTINGS })
}))

export function getSettings(): Settings {
  return useSettings.getState().settings
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
useSettings.subscribe((s) => {
  if (!s.ready) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => window.api.config.save('settings.json', s.settings), 300)
})

export async function loadSettings(): Promise<void> {
  const saved = (await window.api.config.load('settings.json')) as Partial<Settings> | null
  useSettings.getState().hydrate(saved ?? {})
}
