import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { atomicWriteJson } from './atomicWrite'

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
}
