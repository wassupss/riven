import { ipcMain, WebContents, Notification, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import chokidar, { FSWatcher } from 'chokidar'

// The AI <-> context bridge, main-process half:
//  - capture:save   persists a preview screenshot the renderer hands us
//  - watch:start    watches the workspace so agent edits reflect back into the UI

let watcher: FSWatcher | null = null
let shotSeq = 0
const CAPTURE_CAP = 40 // keep only the newest N preview screenshots on disk

export function registerBridgeHandlers(): void {
  ipcMain.handle('capture:save', async (_event, folder: string, dataUrl: string): Promise<string> => {
    const dir = path.join(folder, '.riven', 'captures')
    await fs.mkdir(dir, { recursive: true })
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    const file = path.join(dir, `shot-${Date.now()}-${++shotSeq}.png`)
    await fs.writeFile(file, Buffer.from(base64, 'base64'))
    // Retention: prune old shots so .riven/captures never grows unbounded.
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

  ipcMain.handle('watch:start', (event, folder: string) => {
    const sender: WebContents = event.sender
    if (watcher) {
      watcher.close()
      watcher = null
    }
    watcher = chokidar.watch(folder, {
      // Build/cache/vcs dirs churn constantly (esp. Next/turbopack, which
      // rewrites .next/**/*.sst thousands of times/sec) — never watch them, or
      // AgentWatch drowns opening transient files and pins the CPU. Also skip
      // macOS home noise (Library/Trash) so opening ~ doesn't peg the CPU.
      // Also ignore our own atomic-write temp files (…​.riven-tmp) so a source
      // save's transient temp doesn't fire add/unlink churn or a spurious git
      // refresh mid-rename.
      ignored:
        /(\.riven-tmp$)|(^|[/\\])(\.git|node_modules|out|dist|\.riven|\.cache|\.next|\.turbo|\.svelte-kit|\.nuxt|\.output|\.vercel|\.vite|\.parcel-cache|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|target|Library|\.Trash|\.Trashes)([/\\]|$)/,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 }
    })
    const emit = (type: string) => (p: string) => {
      // No per-event log here: during agent bulk edits this fires thousands of
      // times/sec and floods the main-process console.
      if (!sender.isDestroyed()) sender.send('fs:changed', { type, path: p })
    }
    watcher.on('change', emit('change'))
    watcher.on('add', emit('add'))
    watcher.on('unlink', emit('unlink'))
    watcher.on('ready', () => console.log(`[watch] ready: ${folder}`))
  })

  ipcMain.on('watch:stop', () => {
    watcher?.close()
    watcher = null
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

  ipcMain.on(
    'notify:show',
    (e, opts: { title: string; body: string; force?: boolean; paneId?: string }) => {
      // Default: only when the app is unfocused. `force` (renderer already decided
      // the relevant pane isn't the one being viewed) shows even while focused, so a
      // completion in a BACKGROUND workspace/pane still notifies.
      if (!opts.force && BrowserWindow.getAllWindows().some((w) => w.isFocused())) return
      if (!Notification.isSupported()) return
      const n = new Notification({ title: opts.title, body: opts.body, silent: false })
      n.on('click', () => {
        const win =
          BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
        if (opts.paneId) e.sender.send('notify:click', opts.paneId)
      })
      n.show()
    }
  )
}
