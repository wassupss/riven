import * as monaco from 'monaco-editor'

// Code-editor keybindings (Monaco commands). Kept separate from riven's app
// keybindings; Monaco only fires these while the editor is focused, so they're
// inherently context-scoped. Users pick a preset (VS Code / JetBrains / Sublime)
// and can rebind any single command; overrides persist and layer on the preset.
//
// Chords use riven's chord format ('Mod+Shift+d', 'Ctrl+g', 'F12', 'Mod+/') and
// are translated to Monaco keybinding numbers on apply. Defaults are chosen to
// avoid clashing with riven's global chords (⌘1-9, ⌘e/j/b/t, ⌘⇧f/g/l/p/v …).

export type EditorPresetId = 'vscode' | 'jetbrains' | 'sublime'

export interface EditorCommand {
  id: string // Monaco command id
  label: string
  vscode: string
  jetbrains: string
  sublime: string
}

export const EDITOR_PRESETS: Array<{ id: EditorPresetId; label: string }> = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'jetbrains', label: 'JetBrains' },
  { id: 'sublime', label: 'Sublime Text' }
]

// prettier-ignore
export const EDITOR_COMMANDS: EditorCommand[] = [
  { id: 'actions.find',                               label: '찾기',                 vscode: 'Mod+f',             jetbrains: 'Mod+f',            sublime: 'Mod+f' },
  { id: 'editor.action.startFindReplaceAction',       label: '바꾸기',               vscode: 'Mod+Alt+f',         jetbrains: 'Mod+r',            sublime: 'Mod+Alt+f' },
  { id: 'editor.action.addSelectionToNextFindMatch',  label: '다음 같은 항목 선택',   vscode: 'Mod+d',             jetbrains: 'Ctrl+g',           sublime: 'Mod+d' },
  { id: 'editor.action.selectHighlights',             label: '같은 항목 모두 선택',   vscode: 'Mod+F2',            jetbrains: 'Mod+Ctrl+g',       sublime: 'Mod+Ctrl+g' },
  { id: 'editor.action.copyLinesDownAction',          label: '줄 복제',              vscode: 'Shift+Alt+Down',    jetbrains: 'Mod+d',            sublime: 'Mod+Shift+d' },
  { id: 'editor.action.deleteLines',                  label: '줄 삭제',              vscode: 'Mod+Shift+k',       jetbrains: 'Mod+Backspace',    sublime: 'Mod+Ctrl+k' },
  { id: 'editor.action.moveLinesUpAction',            label: '줄 위로 이동',         vscode: 'Alt+Up',            jetbrains: 'Alt+Shift+Up',     sublime: 'Mod+Ctrl+Up' },
  { id: 'editor.action.moveLinesDownAction',          label: '줄 아래로 이동',       vscode: 'Alt+Down',          jetbrains: 'Alt+Shift+Down',   sublime: 'Mod+Ctrl+Down' },
  { id: 'editor.action.commentLine',                  label: '한 줄 주석',           vscode: 'Mod+/',             jetbrains: 'Mod+/',            sublime: 'Mod+/' },
  { id: 'editor.action.blockComment',                 label: '블록 주석',            vscode: 'Shift+Alt+a',       jetbrains: 'Mod+Shift+/',      sublime: 'Mod+Alt+/' },
  { id: 'editor.action.formatDocument',               label: '문서 정렬',            vscode: 'Shift+Alt+f',       jetbrains: 'Mod+Alt+l',        sublime: 'Mod+Alt+f' },
  { id: 'editor.action.rename',                       label: '이름 변경',            vscode: 'F2',                jetbrains: 'Shift+F6',         sublime: 'F2' },
  { id: 'editor.action.quickFix',                     label: '빠른 수정',            vscode: 'Mod+.',             jetbrains: 'Alt+Enter',        sublime: 'Mod+.' },
  { id: 'editor.action.revealDefinition',             label: '정의로 이동',          vscode: 'F12',               jetbrains: 'F12',              sublime: 'F12' },
  { id: 'editor.action.goToReferences',               label: '참조 찾기',            vscode: 'Shift+F12',         jetbrains: 'Shift+F12',        sublime: 'Shift+F12' },
  { id: 'editor.action.triggerSuggest',               label: '자동완성',             vscode: 'Ctrl+Space',        jetbrains: 'Ctrl+Space',       sublime: 'Ctrl+Space' },
  { id: 'editor.action.indentLines',                  label: '들여쓰기',             vscode: 'Mod+]',             jetbrains: 'Mod+]',            sublime: 'Mod+]' },
  { id: 'editor.action.outdentLines',                 label: '내어쓰기',             vscode: 'Mod+[',             jetbrains: 'Mod+[',            sublime: 'Mod+[' },
  { id: 'editor.action.smartSelect.expand',           label: '선택 확장',            vscode: 'Ctrl+Shift+Right',  jetbrains: 'Alt+Up',           sublime: 'Ctrl+Shift+Up' },
  { id: 'editor.action.smartSelect.shrink',           label: '선택 축소',            vscode: 'Ctrl+Shift+Left',   jetbrains: 'Alt+Down',         sublime: 'Ctrl+Shift+Down' },
  { id: 'editor.foldAll',                             label: '모두 접기',            vscode: 'Mod+Alt+[',         jetbrains: 'Mod+Alt+[',        sublime: 'Mod+Alt+[' },
  { id: 'editor.unfoldAll',                           label: '모두 펼치기',          vscode: 'Mod+Alt+]',         jetbrains: 'Mod+Alt+]',        sublime: 'Mod+Alt+]' },
  { id: 'editor.action.quickCommand',                 label: '명령 팔레트',          vscode: 'F1',                jetbrains: 'Mod+Shift+a',      sublime: 'F1' },
  { id: 'editor.action.gotoLine',                     label: '줄 번호로 이동',       vscode: 'Ctrl+g',            jetbrains: 'Mod+Alt+g',        sublime: 'Ctrl+g' }
]

// ---- chord (riven format) → Monaco keybinding number --------------------------

const { KeyMod, KeyCode } = monaco

const KEYCODE: Record<string, number> = {
  Left: KeyCode.LeftArrow, Right: KeyCode.RightArrow, Up: KeyCode.UpArrow, Down: KeyCode.DownArrow,
  Backspace: KeyCode.Backspace, Enter: KeyCode.Enter, Space: KeyCode.Space, Tab: KeyCode.Tab, Escape: KeyCode.Escape,
  '/': KeyCode.Slash, '\\': KeyCode.Backslash, '[': KeyCode.BracketLeft, ']': KeyCode.BracketRight,
  ',': KeyCode.Comma, '.': KeyCode.Period, ';': KeyCode.Semicolon, "'": KeyCode.Quote, '-': KeyCode.Minus, '=': KeyCode.Equal, '`': KeyCode.Backquote
}

const KC = KeyCode as unknown as Record<string, number>
function keyToken(tok: string): number | null {
  if (/^[a-z]$/.test(tok)) return KC['Key' + tok.toUpperCase()] ?? null
  if (/^[0-9]$/.test(tok)) return KC['Digit' + tok] ?? null
  if (/^F[0-9]{1,2}$/.test(tok)) return KC[tok] ?? null
  return KEYCODE[tok] ?? null
}

export function chordToMonaco(chord: string): number | null {
  if (!chord) return null
  const parts = chord.split('+')
  let mods = 0
  let key: number | null = null
  for (const p of parts) {
    if (p === 'Mod') mods |= KeyMod.CtrlCmd
    else if (p === 'Ctrl') mods |= KeyMod.WinCtrl // physical Control (mac)
    else if (p === 'Alt') mods |= KeyMod.Alt
    else if (p === 'Shift') mods |= KeyMod.Shift
    else key = keyToken(p)
  }
  return key == null ? null : mods | key
}

// ---- state: active preset + per-command overrides -----------------------------

let overrides: Record<string, string> = {}
let currentPreset: EditorPresetId = 'vscode'
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}
export function subscribeEditorKeymap(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function presetChord(cmd: EditorCommand, preset: EditorPresetId): string {
  return cmd[preset]
}

// Effective chord for a command under the active preset (override wins).
export function editorBinding(id: string): string {
  const cmd = EDITOR_COMMANDS.find((c) => c.id === id)
  if (!cmd) return ''
  return overrides[id] ?? presetChord(cmd, currentPreset)
}

export function editorBindingIsOverridden(id: string): boolean {
  return id in overrides
}

// Detect a duplicate chord within the editor keymap (excluding self).
export function editorConflict(id: string, chord: string): EditorCommand | null {
  if (!chord) return null
  for (const c of EDITOR_COMMANDS) {
    if (c.id !== id && editorBinding(c.id) === chord) return c
  }
  return null
}

function apply(): void {
  const rules: Array<{ keybinding: number; command: string }> = []
  for (const cmd of EDITOR_COMMANDS) {
    const kb = chordToMonaco(editorBinding(cmd.id))
    if (kb != null) rules.push({ keybinding: kb, command: cmd.id })
  }
  if (rules.length) monaco.editor.addKeybindingRules(rules)
}

// Switch preset + reapply. Note: Monaco has no API to remove previously-added
// rules, so a full switch only fully takes effect after reload (⌘R). Re-applying
// still overrides same-chord commands immediately, covering most switches.
export function applyEditorKeymap(preset: string): void {
  currentPreset = (EDITOR_PRESETS.find((p) => p.id === preset)?.id ?? 'vscode') as EditorPresetId
  apply()
  emit()
}

export function setEditorBinding(id: string, chord: string): void {
  overrides[id] = chord
  window.api.config.save('editorKeybindings.json', overrides)
  apply()
  emit()
}

export function resetEditorBinding(id: string): void {
  delete overrides[id]
  window.api.config.save('editorKeybindings.json', overrides)
  emit()
  // Note: can't unbind a live Monaco rule; the reset takes effect next reload.
}

export async function loadEditorKeymap(): Promise<void> {
  const o = (await window.api.config.load('editorKeybindings.json')) as Record<string, string> | null
  if (o) overrides = o
  emit()
}

export function currentEditorPreset(): EditorPresetId {
  return currentPreset
}
