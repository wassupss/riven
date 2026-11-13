import { ipcMain, WebContents } from 'electron'
import chokidar, { FSWatcher } from 'chokidar'

// watch:start / watch:stop: watches the workspace so agent edits reflect back
// into the UI (registered by bridge.ts).

let watcher: FSWatcher | null = null

export function registerWatchHandlers(): void {
  ipcMain.handle('watch:start', (event, folder: string) => {
    const sender: WebContents = event.sender
    if (watcher) {
      watcher.close()
      watcher = null
    }
    watcher = chokidar.watch(folder, {
      // Build/cache/vcs dirs churn constantly (esp. Next/turbopack, which
      // rewrites .next/**/*.sst thousands of times/sec), never watch them, or
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
    // Batched, not one IPC message per event: an agent's bulk edit or a build
    // fires thousands a second, and each message is a serialise + a hop + a
    // dispatch in the renderer. Events inside one 50ms window go as one list,
    // with repeats of the same (type, path) folded, the listeners only ever
    // ask "did this change", never "how many times". Order is kept.
    let batch: Array<{ type: string; path: string }> = []
    let seen = new Set<string>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      flushTimer = null
      const out = batch
      batch = []
      seen = new Set()
      if (out.length && !sender.isDestroyed()) sender.send('fs:changed', out)
    }
    const emit = (type: string) => (p: string) => {
      // No per-event log here: during agent bulk edits this fires thousands of
      // times/sec and floods the main-process console.
      const key = `${type}\u0000${p}`
      if (seen.has(key)) return
      seen.add(key)
      batch.push({ type, path: p })
      if (!flushTimer) flushTimer = setTimeout(flush, 50)
    }
    watcher.on('change', emit('change'))
    watcher.on('add', emit('add'))
    watcher.on('unlink', emit('unlink'))
    // Folders too: a folder an agent made (mkdir, or a file written into a new
    // one) never appeared in the explorer, only file events were forwarded, and
    // a file's event refreshes a folder that is not on screen yet.
    watcher.on('addDir', emit('addDir'))
    watcher.on('unlinkDir', emit('unlinkDir'))
    watcher.on('ready', () => console.log(`[watch] ready: ${folder}`))
  })

  ipcMain.on('watch:stop', () => {
    watcher?.close()
    watcher = null
  })
}
