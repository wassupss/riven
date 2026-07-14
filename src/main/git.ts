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

  // Per-line blame for the inline (GitLens-style) annotation. Returns a map of
  // 1-based line number → { author, time (epoch seconds), summary, hash }.
  // Uncommitted lines (all-zero hash) are omitted.
  ipcMain.handle(
    'git:blame',
    async (
      _e,
      folder: string,
      relPath: string
    ): Promise<{
      ok: boolean
      lines?: Record<number, { author: string; time: number; summary: string; hash: string }>
      error?: string
    }> => {
      try {
        const { stdout } = await pexec(
          'git',
          ['-C', folder, 'blame', '--line-porcelain', '--', relPath],
          { maxBuffer: 50 * 1024 * 1024 }
        )
        const meta: Record<string, { author: string; time: number; summary: string }> = {}
        const lines: Record<number, { author: string; time: number; summary: string; hash: string }> =
          {}
        let hash = ''
        let finalLine = 0
        for (const raw of stdout.split('\n')) {
          const header = raw.match(/^([0-9a-f]{40}) \d+ (\d+)/)
          if (header) {
            hash = header[1]
            finalLine = parseInt(header[2], 10)
            if (!meta[hash]) meta[hash] = { author: '', time: 0, summary: '' }
            continue
          }
          if (raw.startsWith('author ')) meta[hash].author = raw.slice(7)
          else if (raw.startsWith('author-time ')) meta[hash].time = parseInt(raw.slice(12), 10)
          else if (raw.startsWith('summary ')) meta[hash].summary = raw.slice(8)
          else if (raw.startsWith('\t')) {
            // Content line — commit the annotation for this final line.
            if (!/^0{40}$/.test(hash)) {
              lines[finalLine] = { hash, ...meta[hash] }
            }
          }
        }
        return { ok: true, lines }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

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
      let ahead = 0
      let behind = 0
      let hasUpstream = false
      try {
        const { stdout: lr } = await pexec('git', [
          '-C',
          folder,
          'rev-list',
          '--left-right',
          '--count',
          '@{upstream}...HEAD'
        ])
        const [b, a] = lr.trim().split(/\s+/).map(Number)
        behind = b || 0
        ahead = a || 0
        hasUpstream = true
      } catch {
        /* no upstream configured */
      }
      return { branch: br.trim(), files, isRepo: true, ahead, behind, hasUpstream }
    } catch {
      return { branch: null, files: [], isRepo: false, ahead: 0, behind: 0, hasUpstream: false }
    }
  })

  const run = async (folder: string, args: string[]): Promise<{ ok: boolean; error?: string }> => {
    try {
      await pexec('git', ['-C', folder, ...args], { maxBuffer: 10 * 1024 * 1024 })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as { stderr?: string; message?: string }).stderr || (e as Error).message }
    }
  }

  ipcMain.handle('git:push', (_e, folder: string) => run(folder, ['push']))
  ipcMain.handle('git:pull', (_e, folder: string) => run(folder, ['pull', '--ff-only']))

  // Discard local changes to a file: revert tracked files to HEAD; delete
  // untracked files.
  ipcMain.handle('git:discard', async (_e, folder: string, relPath: string, untracked: boolean) => {
    if (untracked) {
      try {
        await fs.promises.rm(path.join(folder, relPath), { force: true })
      } catch {
        /* ignore */
      }
      return { ok: true }
    }
    await run(folder, ['reset', '-q', 'HEAD', '--', relPath]) // unstage if staged
    return run(folder, ['checkout', '--', relPath])
  })

  // Return {ok,error} (like git:commit) instead of throwing, so a failed stage
  // (e.g. a lock file, a vanished path) doesn't become an unhandled rejection in
  // the renderer.
  const gitOk = async (args: string[]): Promise<{ ok: boolean; error?: string }> => {
    try {
      await pexec('git', args)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as { stderr?: string; message?: string }).stderr || (e as Error).message }
    }
  }

  ipcMain.handle('git:stage', (_e, folder: string, relPath: string) =>
    gitOk(['-C', folder, 'add', '--', relPath])
  )

  ipcMain.handle('git:unstage', (_e, folder: string, relPath: string) =>
    gitOk(['-C', folder, 'reset', '-q', 'HEAD', '--', relPath])
  )

  ipcMain.handle('git:stageAll', (_e, folder: string) => gitOk(['-C', folder, 'add', '-A']))

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
