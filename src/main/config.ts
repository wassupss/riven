import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

// Generic JSON config store in userData (used for keybindings.json, etc).

function fileFor(name: string): string {
  return path.join(app.getPath('userData'), path.basename(name))
}

export function registerConfigHandlers(): void {
  ipcMain.handle('config:load', async (_e, name: string) => {
    try {
      return JSON.parse(await fs.readFile(fileFor(name), 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('config:save', async (_e, name: string, data: unknown) => {
    await fs.writeFile(fileFor(name), JSON.stringify(data, null, 2))
  })
}
