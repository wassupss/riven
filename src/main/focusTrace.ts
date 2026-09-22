import { app, BrowserWindow } from 'electron'

// Why did riven just jump in front of what I was doing?
//
// Window activation comes from the OS, so nothing in the app can point at the
// culprit after the fact — by the time the window is focused, whatever raised it
// has returned. So the few calls that CAN raise an app (showing a window,
// lifting one above the others, posting a notification, showing a native view)
// leave a breadcrumb here, and the breadcrumbs are printed with the activation.
//
// Dev only: it costs a string per action and prints nothing in a packaged build.
const KEEP = 12
const trail: string[] = []

export function note(what: string): void {
  if (app.isPackaged) return
  trail.push(`${new Date().toISOString().slice(11, 23)} ${what}`)
  if (trail.length > KEEP) trail.shift()
}

export function registerFocusTrace(): void {
  if (app.isPackaged) return
  app.on('browser-window-focus', (_e, win) => {
    const who = win.getTitle() || `win#${win.id}`
    console.log(`[focus] "${who}" came forward — last actions:\n  ${trail.join('\n  ') || '(none)'}`)
  })
}
