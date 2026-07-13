import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'

const pexec = promisify(execFile)

export interface GitInfo {
  repoName: string
  branch: string | null
  isRepo: boolean
}

let headWatcher: fs.FSWatcher | null = null

async function gitInfo(folder: string): Promise<GitInfo> {
  try {
    const { stdout: top } = await pexec('git', ['-C', folder, 'rev-parse', '--show-toplevel'])
    const repoRoot = top.trim()
    const { stdout: br } = await pexec('git', ['-C', folder, 'rev-parse', '--abbrev-ref', 'HEAD'])
    return { repoName: path.basename(repoRoot), branch: br.trim(), isRepo: true }
  } catch {
    return { repoName: path.basename(folder), branch: null, isRepo: false }
  }
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:info', (_e, folder: string) => gitInfo(folder))

  // The committed (HEAD) version of a file, used as a diff baseline for agent
  // edits when we have no in-app baseline. Returns null if not tracked.
  ipcMain.handle('git:showFile', async (_e, folder: string, relPath: string): Promise<string | null> => {
    try {
      const { stdout } = await pexec('git', ['-C', folder, 'show', `HEAD:./${relPath}`], {
        maxBuffer: 20 * 1024 * 1024
      })
      return stdout
    } catch {
      return null
    }
  })

  ipcMain.handle('git:status', async (_e, folder: string) => {
    try {
      const { stdout: br } = await pexec('git', ['-C', folder, 'rev-parse', '--abbrev-ref', 'HEAD'])
      const { stdout } = await pexec('git', ['-C', folder, 'status', '--porcelain=v1'], {
        maxBuffer: 10 * 1024 * 1024
      })
      const files = stdout
        .split('\n')
        .filter((l) => l.length > 3)
        .map((line) => {
          const x = line[0]
          const y = line[1]
          let p = line.slice(3)
          if (p.includes(' -> ')) p = p.split(' -> ')[1]
          p = p.replace(/^"|"$/g, '')
          const untracked = x === '?' && y === '?'
          return {
            path: p,
            x,
            y,
            staged: !untracked && x !== ' ',
            unstaged: untracked || y !== ' ',
            untracked
          }
        })
      return { branch: br.trim(), files, isRepo: true }
    } catch {
      return { branch: null, files: [], isRepo: false }
    }
  })

  ipcMain.handle('git:stage', async (_e, folder: string, relPath: string) => {
    await pexec('git', ['-C', folder, 'add', '--', relPath])
  })

  ipcMain.handle('git:unstage', async (_e, folder: string, relPath: string) => {
    await pexec('git', ['-C', folder, 'reset', '-q', 'HEAD', '--', relPath])
  })

  ipcMain.handle('git:stageAll', async (_e, folder: string) => {
    await pexec('git', ['-C', folder, 'add', '-A'])
  })

  ipcMain.handle('git:commit', async (_e, folder: string, message: string) => {
    try {
      await pexec('git', ['-C', folder, 'commit', '-m', message])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as { stderr?: string; message?: string }).stderr || (e as Error).message }
    }
  })

  ipcMain.handle('git:watch', (event, folder: string) => {
    headWatcher?.close()
    headWatcher = null
    const gitDir = path.join(folder, '.git')
    if (!fs.existsSync(gitDir)) return
    try {
      // Non-recursive watch of .git catches branch switches (HEAD) and commits.
      headWatcher = fs.watch(gitDir, (_ev, fn) => {
        if (fn === 'HEAD' || fn === 'ORIG_HEAD' || fn === 'index') {
          if (!event.sender.isDestroyed()) event.sender.send('git:changed')
        }
      })
    } catch {
      /* watch may fail on some fs; branch just won't auto-refresh */
    }
  })
}
