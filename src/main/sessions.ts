import { app, ipcMain } from 'electron'
import { promises as fs, writeFileSync, renameSync } from 'fs'
import * as path from 'path'
import { atomicWriteJson, TMP_SUFFIX } from './atomicWrite'

// Persists the whole multi-workspace session snapshot (open workspaces, per-ws
// tabs / active file / preview / agent-grid layout) so restarting restores where
// each project was left off.

function storeFile(): string {
  return path.join(app.getPath('userData'), 'sessions.json')
}

export function registerSessionsHandlers(): void {
  ipcMain.handle('sessions:load', async () => {
    try {
      return JSON.parse(await fs.readFile(storeFile(), 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('sessions:save', (_e, data: unknown) => atomicWriteJson(storeFile(), data))

  // Synchronous exit-flush: on beforeunload (renderer reload / window close) the
  // renderer must persist the latest snapshot before it tears down, and an async
  // invoke may not complete in time. sendSync blocks until the file is written.
  ipcMain.on('sessions:save-sync', (e, data: unknown) => {
    try {
      const file = storeFile()
      const tmp = `${file}${TMP_SUFFIX}`
      writeFileSync(tmp, JSON.stringify(data, null, 2))
      renameSync(tmp, file)
      e.returnValue = true
    } catch {
      e.returnValue = false
    }
  })
}
