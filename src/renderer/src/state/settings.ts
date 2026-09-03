import { create } from 'zustand'

export interface Settings {
  theme: string
  editorKeymap: string
  editorFontFamily: string
  editorFontSize: number
  editorTabSize: number
  editorWordWrap: boolean
  editorMinimap: boolean
  editorLigatures: boolean
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
  // Launch AI agents in the native chat panel (streaming UI) instead of a raw CLI
  // terminal. Only Claude has a native chat driver so far; others fall back to a
  // terminal regardless.
  agentChatUI: boolean
  // A fixed instruction appended to every agent chat (like CLAUDE.md but app-wide).
  // Mirrors native's `prompt.global`.
  globalPrompt: string
  // riven MCP tools that are turned OFF (all are on by default, so we store the
  // disabled set — an empty list means every tool is available to the agent).
  mcpDisabledTools: string[]
  // Browser panel's default search engine (a URL template with `{q}`).
  browserSearch: string
  // Default model + permission mode new agent chats start on.
  defaultChatModel: string
  defaultPermissionMode: string
  // Desktop notifications when a background agent turn finishes.
  notifications: boolean
  // Send anonymous crash reports (stored pref; parity with native).
  crashReporting: boolean
  // Whole-UI zoom factor (native UIScale; ⌘+/-/0).
  uiScale: number
  // Show USED % instead of remaining % in the usage widget.
  usageShowUsed: boolean
  // Offer message suggestions in the agent chat.
  chatSuggest: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'ember',
  editorKeymap: 'vscode',
  editorFontFamily: 'Menlo, Monaco, "Courier New", monospace',
  editorFontSize: 12,
  editorTabSize: 2,
  editorWordWrap: false,
  editorMinimap: true,
  editorLigatures: false,
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
  agentChatUI: true,
  globalPrompt: '',
  mcpDisabledTools: [],
  browserSearch: 'https://www.google.com/search?q={q}',
  defaultChatModel: 'default',
  defaultPermissionMode: 'acceptEdits',
  notifications: true,
  crashReporting: true,
  uiScale: 1,
  usageShowUsed: true,
  chatSuggest: false,
  // JetBrains Mono for Latin (matches Ghostty/cmux — the native terminal look),
  // with D2Coding picking up Korean glyphs JetBrains Mono lacks. System name first
  // (instant if installed), then the bundled web copy, so it resolves even with no
  // system install.
  terminalFontFamily:
    '"JetBrains Mono", "JetBrains Mono Web", "D2Coding", "D2Coding Web", Menlo, Monaco, monospace',
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

// Old default terminal-font stacks. Users who never customized the terminal font
// (their saved value matches one of these) are migrated to the current default so
// Korean renders crisply — including the interim "D2Coding"-first value that
// shadowed the system font, now superseded by the "D2Coding" + "D2Coding Web"
// stack. Only the TERMINAL font changes; editor/UI fonts are left as they were.
const LEGACY_TERMINAL_FONTS = new Set([
  '"MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, monospace',
  '"D2Coding", "MesloLGS NF", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, monospace',
  // The previous D2Coding-first default — migrate existing users to the current
  // JetBrains Mono (cmux/Ghostty-style) default.
  '"D2Coding", "D2Coding Web", "MesloLGS NF", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, monospace',
  // The JetBrains+system-Korean default — superseded by the JetBrains+D2Coding
  // (bundled) current default.
  '"JetBrains Mono", "JetBrains Mono Web", "Apple SD Gothic Neo", "Malgun Gothic", "D2Coding Web", Menlo, Monaco, monospace',
  // The interim unified Nanum Gothic Coding default — migrate back to the
  // JetBrains Mono + D2Coding (Ghostty/native) look.
  '"Nanum Gothic Coding", "Nanum Gothic Coding Web", "D2Coding Web", Menlo, Monaco, monospace'
])

export const useSettings = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  ready: false,
  hydrate: (partial) => {
    const merged = { ...DEFAULT_SETTINGS, ...partial }
    if (partial.terminalFontFamily && LEGACY_TERMINAL_FONTS.has(partial.terminalFontFamily))
      merged.terminalFontFamily = DEFAULT_SETTINGS.terminalFontFamily
    // Unify font sizes to 12px: migrate the old per-panel defaults (editor 13,
    // terminal 11) for users who never customized them.
    if (partial.editorFontSize === 13) merged.editorFontSize = 12
    if (partial.terminalFontSize === 11) merged.terminalFontSize = 12
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
