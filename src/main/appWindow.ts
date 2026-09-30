import { BrowserWindow } from 'electron'

// riven's own window — the one the app's UI lives in.
//
// "The first window that is still alive" is not it. BrowserWindow.getAllWindows()
// lists the NEWEST window first, so the moment anything else opens — the browser
// address bar's suggestion dropdown, a sign-in window, the pet — that is what a
// lookup by position finds. Every agent tool call was then sent to a window that
// never answers them: the call hung, for every agent, until riven was restarted.

let current: BrowserWindow | null = null

export function setAppWindow(win: BrowserWindow): void {
  current = win
}

export function appWindow(): BrowserWindow | null {
  if (current && !current.isDestroyed()) return current
  // Before the window exists, or after it closed: never a helper window
  // (dropdowns are unfocusable, dialogs have a parent).
  return (
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isFocusable() && !w.getParentWindow()) ?? null
  )
}
