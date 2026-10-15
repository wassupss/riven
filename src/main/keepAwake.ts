import { ipcMain, powerSaveBlocker } from 'electron'

// Don't let the machine sleep while an agent is mid-turn.
//
// A laptop that sleeps halfway through a build leaves the pane waiting on a CLI
// that simply stopped getting CPU: no output, no error, no end — the most
// confusing way for a long run to fail, and the one riven had no answer for.
//
// `prevent-app-suspension` stops the SYSTEM sleeping; the display may still turn
// off, which is what you want for something running in the background. The
// blocker is refcounted by the renderer's report of how many panes are busy, so
// the last one to finish releases it.

let blockerId: number | null = null
let busyPanes = 0
let enabled = true
// Remote control is on: a machine left at the office has to stay reachable,
// working or not, or the phone finds nobody home (see renderer state/remote).
let remoteHold = false

function sync(): void {
  const want = (enabled && busyPanes > 0) || remoteHold
  if (want && blockerId == null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
    // Worth a line in the log: "why didn't my machine sleep last night" has
    // exactly one answer here, and it should be findable.
    console.log(remoteHold ? '[power] holding sleep off - remote control is on' : `[power] holding sleep off - ${busyPanes} pane(s) working`)
    return
  }
  if (!want && blockerId != null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
    console.log('[power] released')
  }
}

export function registerKeepAwake(): void {
  ipcMain.on('power:busy', (_e, count: number, on: boolean) => {
    busyPanes = Math.max(0, Math.floor(count))
    enabled = on
    sync()
  })
  ipcMain.on('power:remote', (_e, on: boolean) => {
    remoteHold = !!on
    sync()
  })
}

/** For tests and shutdown: let the machine sleep again. */
export function releaseKeepAwake(): void {
  busyPanes = 0
  remoteHold = false
  sync()
}
