import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', 'out', 'dist', '.cache'])

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('workspace:readDir', async (_event, dir: string): Promise<DirEntry[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => ({
        name: e.name,
        path: path.join(dir, e.name),
        isDirectory: e.isDirectory()
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  })

  ipcMain.handle('workspace:readFile', async (_event, file: string): Promise<string> => {
    return fs.readFile(file, 'utf8')
  })

  ipcMain.handle('workspace:writeFile', async (_event, file: string, content: string): Promise<void> => {
    await fs.writeFile(file, content, 'utf8')
  })

  ipcMain.handle('workspace:createFile', async (_e, filePath: string): Promise<void> => {
    await fs.writeFile(filePath, '', { flag: 'wx' }) // fails if exists
  })

  ipcMain.handle('workspace:createFolder', async (_e, dir: string): Promise<void> => {
    await fs.mkdir(dir)
  })

  ipcMain.handle('workspace:rename', async (_e, oldPath: string, newPath: string): Promise<void> => {
    await fs.rename(oldPath, newPath)
  })

  ipcMain.handle('workspace:delete', async (_e, target: string): Promise<void> => {
    await fs.rm(target, { recursive: true, force: true })
  })

  ipcMain.handle('workspace:reveal', (_e, target: string) => {
    shell.showItemInFolder(target)
  })

  // Snapshot text-file contents under the workspace → baselines for agent-edit
  // diffs (works without git). Bounded to stay cheap.
  ipcMain.handle('workspace:snapshotContents', async (_e, folder: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    const NUL = String.fromCharCode(0)
    let count = 0
    const walk = async (dir: string): Promise<void> => {
      if (count >= 2000) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (count >= 2000) return
        if (IGNORED.has(e.name)) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) {
          try {
            const st = await fs.stat(full)
            if (st.size > 200_000) continue
            const content = await fs.readFile(full, 'utf8')
            if (content.includes(NUL)) continue
            out[full] = content
            count++
          } catch {
            /* skip unreadable */
          }
        }
      }
    }
    await walk(folder)
    return out
  })
}
