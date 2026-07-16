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

  ipcMain.on('notify:show', (_e, opts: { title: string; body: string }) => {
    // Only notify when the app is NOT focused (reliable main-process check —
    // renderer document.hasFocus() is flaky in Electron).
    if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) return
    if (Notification.isSupported()) {
      new Notification({ title: opts.title, body: opts.body, silent: false }).show()
    }
  })
}
