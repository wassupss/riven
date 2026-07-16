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

// Resolve the current branch name. `symbolic-ref --short HEAD` works on an
// unborn branch (fresh `git init`, no commits yet) where `rev-parse HEAD` would
// error; on a detached HEAD it falls back to the short SHA.
async function currentBranch(folder: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', folder, 'symbolic-ref', '--short', 'HEAD'])
    return stdout.trim()
  } catch {
    try {
      const { stdout } = await pexec('git', ['-C', folder, 'rev-parse', '--short', 'HEAD'])
      return stdout.trim()
    } catch {
      return null
    }
  }
}

async function gitInfo(folder: string): Promise<GitInfo> {
  try {
    // --show-toplevel succeeds even on an unborn branch, so a brand-new
    // `git init` repo is still recognized as a repo.
    const { stdout: top } = await pexec('git', ['-C', folder, 'rev-parse', '--show-toplevel'])
    return { repoName: path.basename(top.trim()), branch: await currentBranch(folder), isRepo: true }
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
      _folder: string,
      filePath: string
    ): Promise<{
      ok: boolean
      lines?: Record<number, { author: string; time: number; summary: string; hash: string }>
      error?: string
    }> => {
      try {
        // Resolve the repo from the FILE's own directory (not the workspace
        // root), so a nested repo — e.g. collection/a under a workspace opened at
        // collection — still gets inline blame. filePath is absolute.
        const { stdout } = await pexec(
          'git',
          ['-C', path.dirname(filePath), 'blame', '--line-porcelain', '--', path.basename(filePath)],
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
      // --is-inside-work-tree succeeds on an unborn branch, so a fresh `git init`
      // repo still reports isRepo:true (and its untracked files show up below).
      await pexec('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'])
      const br = await currentBranch(folder)
      // -z: NUL-delimited records, and git emits raw (unquoted, un-escaped) paths
      // — the only reliable way to read non-ASCII / spaced filenames. (Plain
      // porcelain octal-escapes them, e.g. Korean → "\355\225\234...", which never
      // matches the renderer's real UTF-8 path.)
      const { stdout } = await pexec('git', ['-C', folder, 'status', '--porcelain=v1', '-z'], {
        maxBuffer: 10 * 1024 * 1024
      })
      const records = stdout.split('\0')
      const files: Array<{
        path: string
        x: string
        y: string
        staged: boolean
        unstaged: boolean
        untracked: boolean
      }> = []
      for (let i = 0; i < records.length; i++) {
        const entry = records[i]
        if (entry.length < 4) continue // need at least "XY p"
        const x = entry[0]
        const y = entry[1]
        const p = entry.slice(3) // skip "XY " → destination path (raw, unquoted)
        // Rename/copy entries carry a second field (the source path) in the next
        // NUL token; consume it so it isn't parsed as its own entry.
        if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++
        const untracked = x === '?' && y === '?'
        files.push({
          path: p,
          x,
          y,
          staged: !untracked && x !== ' ',
          unstaged: untracked || y !== ' ',
          untracked
        })
      }
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
      return { branch: br, files, isRepo: true, ahead, behind, hasUpstream }
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
