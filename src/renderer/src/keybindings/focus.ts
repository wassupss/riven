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

// Without this, the region only ever moves to 'terminal'/'editor' and never
// back — so after touching a terminal, clicking any panel/input leaves the
// region stale at 'terminal' and terminal-scoped shortcuts (⌘D/⌘K) keep firing.
// A capture-phase focusin resets to 'none' for every surface that isn't a
// terminal or the code editor (those set their own region on focus).
export function initFocusTracking(): void {
  window.addEventListener(
    'focusin',
    (e) => {
      const el = e.target as HTMLElement | null
      if (!el || typeof el.closest !== 'function') return
      if (el.closest('.xterm')) return // TerminalPane's focusin sets 'terminal'
      if (el.closest('.monaco-editor')) return // Monaco sets 'editor'
      setFocusRegion({ kind: 'none' })
    },
    true
  )
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

// Same multi-pane hazard as editorSaver: every workspace mounts an editor, so
// registering unconditionally at mount let a hidden/last-mounted pane win (⌘E
// then focused nothing, and could call focus() on a disposed editor). Claimed on
// focus, cleared on unmount only if still ours.
let editorFocuser: (() => void) | null = null
export function setEditorFocuser(fn: () => void): void {
  editorFocuser = fn
}
export function clearEditorFocuser(fn: () => void): void {
  if (editorFocuser === fn) editorFocuser = null
}
export function focusEditor(): void {
  editorFocuser?.()
}

// The active editor registers how to save its current file. Exposed as an app
// keybinding (⌘S) so save works whenever an editor is open — not only while the
// Monaco textarea itself holds DOM focus (a tab/gutter click would otherwise
// swallow ⌘S, since Monaco only sees keydowns on its own input).
// Set by the editor that currently holds (or last held) focus AND has a file
// bound. Keyed by focus rather than a single mount-time registration, because
// multiple editor panes (one per workspace) mount at once — a fileless one must
// not clobber the active editor's saver.
let editorSaver: (() => void) | null = null
export function setEditorSaver(fn: () => void): void {
  editorSaver = fn
}
// Only clear if the departing editor is still the registered one, so unmounting
// a background pane can't wipe the active editor's saver.
export function clearEditorSaver(fn: () => void): void {
  if (editorSaver === fn) editorSaver = null
}
export function saveActiveEditor(): void {
  editorSaver?.()
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
