import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

// Dev-only: RIVEN_DEMO=<frameDir> drives a scripted tour of the real UI while
// grabbing frames off the actual renderer (capturePage — no screen-recording
// permission needed). The frames are later encoded to a web video for the
// landing page. Gated by env; never runs in normal use.
//
// The tour shows riven as a UNIFIED workbench: a clean editor (no LSP errors),
// a real terminal running the dev server, and a live web preview of the running
// app — all docked together. No settings/theme fiddling.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runDemo(win: BrowserWindow): Promise<void> {
  const outDir = process.env.RIVEN_DEMO as string
  await fs.mkdir(outDir, { recursive: true })

  let frame = 0
  let capturing = false
  const grab = async (): Promise<void> => {
    // Spins continuously; only writes frames while `capturing` is true, so the
    // recorded clip opens already-composed (dev server up, preview live) and the
    // very first frame has motion — no static lead-in to trim.
    for (;;) {
      const t = Date.now()
      if (capturing) {
        try {
          const img = (await win.webContents.capturePage()).resize({ width: 1280 })
          await fs.writeFile(path.join(outDir, `f-${String(frame).padStart(4, '0')}.png`), img.toPNG())
          frame++
        } catch {
          /* window busy — skip this frame */
        }
      }
      if (!capturing && frame > 0) break // stopped
      await sleep(Math.max(0, 100 - (Date.now() - t))) // ~10 fps
    }
  }

  const js = (code: string): Promise<unknown> =>
    win.webContents.executeJavaScript(code, true).catch(() => undefined)
  const wheel = (x: number, y: number, deltaY: number): void =>
    win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY, canScroll: true } as never)

  // Smoothly scroll the editor by many small wheel ticks (reads like a person).
  const scrollEditor = async (dir: number, ticks: number): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      wheel(660, 300, 34 * dir)
      await sleep(55)
    }
  }

  const grabbing = grab()

  // ---- warm-up (not captured) ---------------------------------------------
  // Let the workspace/editor/terminal restore and Vite boot, then force the
  // preview webview to (re)load so it shows the running app, not a cold-start
  // connection error.
  await sleep(6500)
  await js(`document.querySelector('.preview-webview')?.reload?.()`)
  await sleep(2600)
  // Make sure App.tsx is the focused editor tab and scrolled to the top.
  await js(`document.querySelectorAll('.file-tab')[0]?.click()`)
  await sleep(600)
  wheel(660, 300, -1600)
  await sleep(500)

  // ---- record --------------------------------------------------------------
  capturing = true
  await sleep(700) // brief hold on the composed workbench

  // 1) Read down through App.tsx — clean code, zero error squiggles.
  await scrollEditor(1, 22)
  await sleep(900)

  // 2) Peek at the API route table (second editor tab).
  await js(`document.querySelectorAll('.file-tab')[1]?.click()`)
  await sleep(1300)
  await scrollEditor(1, 8)
  await sleep(700)

  // 3) And the typed sample data (third tab).
  await js(`document.querySelectorAll('.file-tab')[2]?.click()`)
  await sleep(1400)

  // 4) Back to App.tsx and scroll up to the top — settle on the full workbench:
  //    editor + running dev server + live preview, all docked together.
  await js(`document.querySelectorAll('.file-tab')[0]?.click()`)
  await sleep(700)
  await scrollEditor(-1, 20)
  await sleep(1600)

  capturing = false
  await grabbing
  // eslint-disable-next-line no-console
  console.log(`[riven] demo captured ${frame} frames → ${outDir}`)
  app.quit()
}
