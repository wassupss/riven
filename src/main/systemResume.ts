import { BrowserWindow, powerMonitor, WebContents } from 'electron'

// Waking from sleep can leave the compositor holding tiles it will never repaint:
// the window is "there" but frozen until something forces it. paseo answers this
// with a full compositor watchdog (rAF probe → SIGKILL the GPU process); orca
// just repaints on resume. This is orca's half, which needs no reproduction to
// justify and cannot misfire — the watchdog is deliberately NOT here (see
// .claude/docs/paseo-orca-remaining-plan.md item 4: without a reported stall its
// effect is unknown, and a false recovery flickers every WebGL context, Monaco
// and the browser panel).
//
// The renderer half matters as much as the repaint. A terminal that lost its
// WebGL context falls back to xterm's DOM renderer FOR THE REST OF THE SESSION,
// on purpose — an unstable GPU context is worse than a slow renderer. But a loss
// caused by the machine sleeping is not an unstable GPU, and leaving every
// terminal on the DOM renderer after a lunch break is its own bug. So resume
// broadcasts, and TerminalPane treats that as permission to try WebGL once more.

export const SYSTEM_RESUMED = 'system:resumed'

function liveWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
}

function repaint(wc: WebContents): void {
  try {
    // Chromium drops the stale tiles and re-rasterises. Cheap, and a no-op when
    // the compositor was fine.
    wc.invalidate()
  } catch {
    /* window went away mid-resume */
  }
}

let installed = false

export function registerSystemResume(): void {
  if (installed) return
  installed = true
  const onWake = (reason: string): void => {
    for (const w of liveWindows()) {
      repaint(w.webContents)
      try {
        w.webContents.send(SYSTEM_RESUMED, reason)
      } catch {
        /* destroyed between the filter and here */
      }
    }
  }
  powerMonitor.on('resume', () => onWake('resume'))
  // Display sleep and the lock screen produce the same frozen-tile symptom
  // without a full system suspend, so they get the same treatment.
  powerMonitor.on('unlock-screen', () => onWake('unlock-screen'))
}
