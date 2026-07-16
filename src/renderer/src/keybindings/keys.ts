// Customizable keybinding engine. Actions register a default chord; users can
// override any binding (persisted to userData/keybindings.json). A global
// capture-phase listener matches chords and runs the action.

import { getFocusRegion } from './focus'

// 'riven' actions fire anywhere; 'terminal' actions fire only while a terminal
// pane is focused (so they don't shadow editor typing). Code-editor shortcuts are
// owned by Monaco (see editorKeymaps.ts), configured separately.
export type KeyContext = 'riven' | 'terminal'

export interface KeyAction {
  id: string
  label: string
  category: string
  context: KeyContext
  def: string // default chord, e.g. 'Mod+1'
  run: () => void
}

export const IS_MAC = navigator.platform.toLowerCase().includes('mac')

const ARROWS: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down'
}

// Punctuation/bracket physical keys, named from e.code so Shift (which flips
// e.key to }, {, :, " …) can't produce a chord that differs from the unshifted
// default binding. Mirrors the Digit/Key handling; ⌘⇧] must equal 'Mod+Shift+]'.
const PUNCT_CODES: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Minus: '-',
  Equal: '='
}

export function chordFromEvent(e: KeyboardEvent): string {
  const k = e.key
  if (k === 'Meta' || k === 'Control' || k === 'Alt' || k === 'Shift') return ''

  let keyName: string
  if (e.code.startsWith('Digit')) keyName = e.code.slice(5)
  else if (e.code.startsWith('Key')) keyName = e.code.slice(3).toLowerCase()
  else if (ARROWS[k]) keyName = ARROWS[k]
  else if (PUNCT_CODES[e.code]) keyName = PUNCT_CODES[e.code]
  else keyName = k.length === 1 ? k.toLowerCase() : k

  const mod = IS_MAC ? e.metaKey : e.ctrlKey
  const parts: string[] = []
  if (mod) parts.push('Mod')
  if (IS_MAC && e.ctrlKey) parts.push('Ctrl') // physical Control on mac (distinct from Mod=Cmd)
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(keyName)
  return parts.join('+')
}

const ARROW_GLYPH: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓' }

export function chordLabel(chord: string): string {
  if (!chord) return '—'
  return chord
    .split('+')
    .map((p) => {
      if (p === 'Mod') return IS_MAC ? '⌘' : 'Ctrl'
      if (p === 'Ctrl') return IS_MAC ? '⌃' : 'Ctrl'
      if (p === 'Alt') return IS_MAC ? '⌥' : 'Alt'
      if (p === 'Shift') return '⇧'
      if (ARROW_GLYPH[p]) return ARROW_GLYPH[p]
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join(IS_MAC ? '' : '+')
}

class Keymap {
  private actions = new Map<string, KeyAction>()
  private overrides: Record<string, string> = {}
  private listeners = new Set<() => void>()
  private recording = false
  private modalOpen = false

  // A keyboard-driven modal (e.g. the quick-panel dialog) suspends the global
  // handler so its own ↑/↓/Enter/chords don't also fire app actions behind it.
  setModalOpen(v: boolean): void {
    this.modalOpen = v
  }

  // While the Settings recorder is capturing a chord, the global handler must
  // not also run the matched action (else recording ⌘T spawns a terminal, etc.).
  setRecording(v: boolean): void {
    this.recording = v
  }

  register(a: KeyAction): void {
    this.actions.set(a.id, a)
    this.emit()
  }

  binding(id: string): string {
    return this.overrides[id] ?? this.actions.get(id)?.def ?? ''
  }

  setBinding(id: string, chord: string): void {
    this.overrides[id] = chord
    this.persist()
    this.emit()
  }

  resetBinding(id: string): void {
    delete this.overrides[id]
    this.persist()
    this.emit()
  }

  list(): KeyAction[] {
    return [...this.actions.values()]
  }

  conflict(id: string, chord: string): KeyAction | null {
    for (const a of this.actions.values()) {
      if (a.id !== id && this.binding(a.id) === chord) return a
    }
    return null
  }

  handle = (e: KeyboardEvent): void => {
    // Recorder is capturing this keydown, or a keyboard-driven modal is open —
    // let it own the keyboard without side effects.
    if (this.recording || this.modalOpen) return
    // Never act on IME composition keydowns (keyCode 229 is the legacy signal).
    if (e.isComposing || e.keyCode === 229) return
    const chord = chordFromEvent(e)
    if (!chord) return
    // Don't fire app/terminal shortcuts while typing in a plain text field
    // (search box, tab-rename input, modal fields …). The terminal (xterm) and
    // Monaco both host editable elements but own their region/keybindings, so
    // they're exempt.
    const ae = document.activeElement as HTMLElement | null
    if (ae && !ae.closest?.('.monaco-editor') && !ae.closest?.('.xterm')) {
      if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable) return
    }
    const focused = getFocusRegion().kind
    for (const a of this.actions.values()) {
      if (this.binding(a.id) !== chord) continue
      // Terminal-scoped actions only fire while a terminal is focused, so they
      // never steal keys from the code editor (or vice-versa).
      if (a.context === 'terminal' && focused !== 'terminal') continue
      e.preventDefault()
      e.stopPropagation()
      a.run()
      return
    }
  }

  async load(): Promise<void> {
    const o = (await window.api.config.load('keybindings.json')) as Record<string, string> | null
    if (o) this.overrides = o
    this.emit()
  }

  private persist(): void {
    window.api.config.save('keybindings.json', this.overrides)
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    this.listeners.forEach((l) => l())
  }
}

export const keymap = new Keymap()
