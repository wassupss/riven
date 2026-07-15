import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

const IGNORED = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'out',
  'dist',
  '.cache',
  '.next',
  '.turbo',
  '.svelte-kit',
  '.nuxt',
  '.output',
  '.vercel',
  '.vite',
  '.parcel-cache',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'target'
])

// Currently-open workspace roots, kept in sync by the renderer. File mutations
// are confined to these so a bad path (buggy code / agent output) can't write or
// recursively delete arbitrary files outside an open project (defense-in-depth).
const roots = new Set<string>()

function assertConfined(target: string): void {
  if (roots.size === 0) return // nothing open yet — no confinement to enforce
  const resolved = path.resolve(target)
  for (const root of roots) {
    const r = path.resolve(root)
    if (resolved === r || resolved.startsWith(r + path.sep)) return
  }
  throw new Error(`refused: path is outside any open workspace: ${target}`)
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:setRoots', (_e, list: string[]) => {
    roots.clear()
    for (const r of list) if (typeof r === 'string' && r) roots.add(r)
  })

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
    assertConfined(file)
    await fs.writeFile(file, content, 'utf8')
  })

  ipcMain.handle('workspace:createFile', async (_e, filePath: string): Promise<void> => {
    assertConfined(filePath)
    await fs.writeFile(filePath, '', { flag: 'wx' }) // fails if exists
  })

  ipcMain.handle('workspace:createFolder', async (_e, dir: string): Promise<void> => {
    assertConfined(dir)
    await fs.mkdir(dir)
  })

  ipcMain.handle('workspace:rename', async (_e, oldPath: string, newPath: string): Promise<void> => {
    assertConfined(oldPath)
    assertConfined(newPath)
    await fs.rename(oldPath, newPath)
  })

  ipcMain.handle('workspace:delete', async (_e, target: string): Promise<void> => {
    assertConfined(target)
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

  // Import a local font file → return a family name + data URL for @font-face.
  ipcMain.handle(
    'font:import',
    async (): Promise<{ family: string; dataUrl: string } | null> => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win, {
        title: '폰트 파일 가져오기',
        properties: ['openFile'],
        filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }]
      })
      if (res.canceled || !res.filePaths[0]) return null
      const file = res.filePaths[0]
      const ext = path.extname(file).slice(1).toLowerCase()
      const mime =
        ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : ext === 'otf' ? 'font/otf' : 'font/ttf'
      const buf = await fs.readFile(file)
      const family = path.basename(file, path.extname(file))
      return { family, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    }
  )

  // package.json scripts + detected package manager, for the run-script launcher.
  ipcMain.handle(
    'scripts:list',
    async (_e, folder: string): Promise<{ manager: string; scripts: string[] }> => {
      let manager = 'npm'
      try {
        if (await fs.stat(path.join(folder, 'pnpm-lock.yaml')).catch(() => null)) manager = 'pnpm'
        else if (await fs.stat(path.join(folder, 'yarn.lock')).catch(() => null)) manager = 'yarn'
        else if (await fs.stat(path.join(folder, 'bun.lockb')).catch(() => null)) manager = 'bun'
      } catch {
        /* default npm */
      }
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>
        }
        return { manager, scripts: Object.keys(pkg.scripts ?? {}) }
      } catch {
        return { manager, scripts: [] }
      }
    }
  )

  // Fast flat list of workspace-relative file paths (no content) for quick-open.
  ipcMain.handle('workspace:listFiles', async (_e, folder: string): Promise<string[]> => {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= 20000) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= 20000) return
        if (IGNORED.has(e.name)) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) out.push(path.relative(folder, full))
      }
    }
    await walk(folder)
    return out
  })
}
