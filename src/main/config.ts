import { app, ipcMain, shell } from 'electron'
import { promises as fs, renameSync, writeFileSync } from 'fs'
import * as path from 'path'
import { atomicWriteJson } from './atomicWrite'

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

  ipcMain.handle('config:save', (_e, name: string, data: unknown) => atomicWriteJson(fileFor(name), data))

  // The same escape hatch sessions has: saving is debounced, and quitting inside
  // that window used to drop the change — a setting toggled and then ⌘Q'd came
  // back off. sendSync blocks until the file is on disk, so a flush on unload
  // survives the teardown.
  ipcMain.on('config:save-sync', (e, name: string, data: unknown) => {
    try {
      const file = fileFor(name)
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2))
      renameSync(tmp, file)
      e.returnValue = true
    } catch {
      e.returnValue = false
    }
  })

  // Reveal a config file in Finder/Explorer (Settings → open settings.json).
  ipcMain.handle('config:reveal', (_e, name: string) => shell.showItemInFolder(fileFor(name)))
}
