import { create } from 'zustand'

export interface Settings {
  theme: string
  editorFontFamily: string
  editorFontSize: number
  terminalFontFamily: string
  terminalFontSize: number
  terminalBackground: string
  terminalForeground: string
  terminalCursor: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'ember',
  editorFontFamily: 'Menlo, Monaco, "Courier New", monospace',
  editorFontSize: 13,
  terminalFontFamily:
    '"MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, monospace',
  terminalFontSize: 12,
  terminalBackground: '#15171a',
  terminalForeground: '#d6dae0',
  terminalCursor: '#ff6b3d'
}

interface SettingsState {
  settings: Settings
  ready: boolean
  hydrate: (partial: Partial<Settings>) => void
  set: (partial: Partial<Settings>) => void
  reset: () => void
}

export const useSettings = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  ready: false,
  hydrate: (partial) => set({ settings: { ...DEFAULT_SETTINGS, ...partial }, ready: true }),
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
