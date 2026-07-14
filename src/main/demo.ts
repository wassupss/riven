import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

// Dev-only: RIVEN_DEMO=<frameDir> drives a scripted tour of the real UI while
// grabbing frames off the actual renderer (capturePage — no screen-recording
// permission needed). The frames are later encoded to a web video for the
// landing page. Gated by env; never runs in normal use.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runDemo(win: BrowserWindow): Promise<void> {
  const outDir = process.env.RIVEN_DEMO as string
  await fs.mkdir(outDir, { recursive: true })

  let frame = 0
  let capturing = true
  const grab = async (): Promise<void> => {
    while (capturing) {
      const t = Date.now()
      try {
        const img = (await win.webContents.capturePage()).resize({ width: 1280 })
        await fs.writeFile(path.join(outDir, `f-${String(frame).padStart(4, '0')}.png`), img.toPNG())
        frame++
      } catch {
        /* window busy — skip this frame */
      }
      await sleep(Math.max(0, 100 - (Date.now() - t))) // ~10 fps
    }
  }

  const js = (code: string): Promise<unknown> =>
    win.webContents.executeJavaScript(code, true).catch(() => undefined)
  const wheel = (x: number, y: number, deltaY: number): void =>
    win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY, canScroll: true } as never)

  const grabbing = grab()

  // Let the workspace, terminal and editor finish restoring/painting.
  await sleep(3000)

  // 1) Scroll through the code in the editor pane (right half of the window).
  for (let i = 0; i < 7; i++) {
    wheel(1200, 520, 120)
    await sleep(190)
  }
  await sleep(700)

  // 2) Open Settings (status-bar gear).
  await js(
    `((document.querySelector('.status-item .lucide-settings')||{}).closest?.('.status-item') || [...document.querySelectorAll('.status-item.click')].pop())?.click()`
  )
  await sleep(1300)

  // 3) Cycle a few themes — the whole UI recolours live.
  await js(`document.querySelectorAll('.theme-swatch')[2]?.click()`)
  await sleep(1100)
  await js(`document.querySelectorAll('.theme-swatch')[4]?.click()`)
  await sleep(1100)
  await js(`document.querySelectorAll('.theme-swatch')[1]?.click()`)
  await sleep(1100)

  // 4) Show the Account tab — GitHub login + settings sync.
  await js(`[...document.querySelectorAll('.kb-tab')].find(b=>/계정|Account/.test(b.textContent||''))?.click()`)
  await sleep(2000)

  // 5) Back to General, restore the default theme, close Settings.
  await js(`[...document.querySelectorAll('.kb-tab')].find(b=>/일반|General/.test(b.textContent||''))?.click()`)
  await sleep(600)
  await js(`document.querySelectorAll('.theme-swatch')[0]?.click()`)
  await sleep(900)
  await js(`document.querySelector('.settings-modal .modal-header .btn-small')?.click()`)
  await sleep(1500)

  capturing = false
  await grabbing
  // eslint-disable-next-line no-console
  console.log(`[riven] demo captured ${frame} frames → ${outDir}`)
  app.quit()
}
