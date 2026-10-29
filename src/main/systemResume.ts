import { BrowserWindow, powerMonitor, screen, WebContents } from 'electron'

// Waking from sleep can leave the compositor holding tiles it will never repaint:
// the window is "there" but frozen until something forces it. paseo answers this
// with a full compositor watchdog (rAF probe → SIGKILL the GPU process); orca
// just repaints on resume. This is orca's half, which needs no reproduction to
// justify and cannot misfire. The watchdog is deliberately NOT here (see
// .claude/docs/paseo-orca-remaining-plan.md item 4: without a reported stall its
// effect is unknown, and a false recovery flickers every WebGL context, Monaco
// and the browser panel).
//
// The renderer half: resume also broadcasts, and each TerminalPane redraws its
// canvas in full, so a terminal whose tiles went stale over sleep does not wait
// for the next byte of output to look right again.

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
  // The displays rearranging themselves — which a screen going to sleep and
  // waking does, most of all with an external monitor: the window is moved to
  // another display and back, and its size changes under the page without the
  // page reliably hearing about it. The dock was left laid out for the size in
  // between, with a band of nothing under every panel, until something forced
  // a relayout. Coalesced: one rearrangement fires several of these.
  let displayTimer: ReturnType<typeof setTimeout> | null = null
  const onDisplays = (): void => {
    if (displayTimer) clearTimeout(displayTimer)
    displayTimer = setTimeout(() => {
      displayTimer = null
      onWake('display')
    }, 400)
  }
  screen.on('display-added', onDisplays)
  screen.on('display-removed', onDisplays)
  screen.on('display-metrics-changed', onDisplays)
}
