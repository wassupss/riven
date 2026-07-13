// Customizable keybinding engine. Actions register a default chord; users can
// override any binding (persisted to userData/keybindings.json). A global
// capture-phase listener matches chords and runs the action.

export interface KeyAction {
  id: string
  label: string
  category: string
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

export function chordFromEvent(e: KeyboardEvent): string {
  const k = e.key
  if (k === 'Meta' || k === 'Control' || k === 'Alt' || k === 'Shift') return ''

  let keyName: string
  if (e.code.startsWith('Digit')) keyName = e.code.slice(5)
  else if (e.code.startsWith('Key')) keyName = e.code.slice(3).toLowerCase()
  else if (ARROWS[k]) keyName = ARROWS[k]
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

export function chordLabel(chord: string): string {
  if (!chord) return '—'
  return chord
    .split('+')
    .map((p) => {
      if (p === 'Mod') return IS_MAC ? '⌘' : 'Ctrl'
      if (p === 'Ctrl') return IS_MAC ? '⌃' : 'Ctrl'
      if (p === 'Alt') return IS_MAC ? '⌥' : 'Alt'
      if (p === 'Shift') return '⇧'
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join(IS_MAC ? '' : '+')
}

class Keymap {
  private actions = new Map<string, KeyAction>()
  private overrides: Record<string, string> = {}
  private listeners = new Set<() => void>()

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
    const chord = chordFromEvent(e)
    if (!chord) return
    for (const a of this.actions.values()) {
      if (this.binding(a.id) === chord) {
        e.preventDefault()
        e.stopPropagation()
        a.run()
        return
      }
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
