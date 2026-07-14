// Small registries so keybinding actions can move focus between the editor and
// individual terminal panes without prop-drilling.

// Which region currently holds focus — used to make shortcuts (⌘W etc.) act on
// whatever the user is actually looking at.
export type FocusRegion = { kind: 'editor' } | { kind: 'terminal'; paneId: number } | { kind: 'none' }

let focusRegion: FocusRegion = { kind: 'none' }
export function setFocusRegion(r: FocusRegion): void {
  focusRegion = r
}
export function getFocusRegion(): FocusRegion {
  return focusRegion
}

// The active editor registers how to close its current tab. Returns true if a
// tab was handled, false if the editor had no open tab (so ⌘W closes the panel).
let editorCloser: (() => boolean) | null = null
export function setEditorCloser(fn: (() => boolean) | null): void {
  editorCloser = fn
}
export function getEditorCloser(): (() => boolean) | null {
  return editorCloser
}

let editorFocuser: (() => void) | null = null
export function setEditorFocuser(fn: () => void): void {
  editorFocuser = fn
}
export function focusEditor(): void {
  editorFocuser?.()
}

const paneFocusers = new Map<number, () => void>()
export function registerPaneFocuser(id: number, fn: () => void): () => void {
  paneFocusers.set(id, fn)
  return () => paneFocusers.delete(id)
}
export function focusPane(id: number): void {
  paneFocusers.get(id)?.()
}

const paneClearers = new Map<number, () => void>()
export function registerPaneClearer(id: number, fn: () => void): () => void {
  paneClearers.set(id, fn)
  return () => paneClearers.delete(id)
}
// Clear the currently-focused terminal, if any.
export function clearFocusedTerminal(): void {
  const r = focusRegion
  if (r.kind === 'terminal') paneClearers.get(r.paneId)?.()
}
