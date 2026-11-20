import { app, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { registerWatchHandlers } from './watch'

// The AI <-> context bridge, main-process half:
//  - capture:save   persists a preview screenshot the renderer hands us
//  - watch:start    watches the workspace so agent edits reflect back into the UI
//                   (./watch, its own module so the Tauri build can leave it out)

let shotSeq = 0
const CAPTURE_CAP = 40 // keep only the newest N preview screenshots on disk

export function registerBridgeHandlers(): void {
  registerWatchHandlers()
  ipcMain.handle('capture:save', async (_event, folder: string, dataUrl: string): Promise<string> => {
    // Under userData, NOT the workspace. These are riven's scratch files and the
    // user never asked for them to be in their repo — a `.riven/` appearing at
    // every workspace root just forces a .gitignore entry on them. Kept per
    // workspace so the retention cap below stays per workspace.
    const dir = path.join(
      app.getPath('userData'),
      'captures',
      folder.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
    )
    await fs.mkdir(dir, { recursive: true })
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    const file = path.join(dir, `shot-${Date.now()}-${++shotSeq}.png`)
    await fs.writeFile(file, Buffer.from(base64, 'base64'))
    // Retention: prune old shots so the capture dir never grows unbounded.
    // Names are shot-<ms>-<seq>.png, so a lexical sort is chronological.
    try {
      const shots = (await fs.readdir(dir))
        .filter((f) => f.startsWith('shot-') && f.endsWith('.png'))
        .sort()
      for (const old of shots.slice(0, -CAPTURE_CAP)) {
        await fs.unlink(path.join(dir, old)).catch(() => {})
      }
    } catch {
      /* best-effort cleanup */
    }
    return file
  })

  // Open a URL in the user's default browser (port chips, links).
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // Whole-UI zoom applied on the WebContents (authoritative). Doing it only via
  // the preload's webFrame was unreliable at startup: a setZoomFactor issued while
  // the page is still loading gets reset, so the restored uiScale silently fell
  // back to 100% on every launch.
  ipcMain.on('ui:setZoom', (e, factor: number) => {
    const f = Number(factor)
    if (!Number.isFinite(f) || f <= 0) return
    const wc = e.sender
    wc.setZoomFactor(f)
    // Re-apply once the load settles, in case this arrived mid-load.
    if (wc.isLoading()) wc.once('did-finish-load', () => wc.setZoomFactor(f))
  })

}
