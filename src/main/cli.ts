import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fsp, constants as fsc } from 'fs'
import * as path from 'path'

const pexec = promisify(execFile)

interface CliDef {
  name: string
  cmd: string
  group: string
}

// Curated set of interesting dev / AI CLIs — we report which are installed.
const CANDIDATES: CliDef[] = [
  { name: 'Claude Code', cmd: 'claude', group: 'AI' },
  { name: 'Codex', cmd: 'codex', group: 'AI' },
  { name: 'Aider', cmd: 'aider', group: 'AI' },
  { name: 'Gemini', cmd: 'gemini', group: 'AI' },
  { name: 'opencode', cmd: 'opencode', group: 'AI' },
  { name: 'Cursor Agent', cmd: 'cursor-agent', group: 'AI' },
  { name: 'Ollama', cmd: 'ollama', group: 'AI' },
  { name: 'GitHub CLI', cmd: 'gh', group: 'Dev' },
  { name: 'lazygit', cmd: 'lazygit', group: 'Dev' },
  { name: 'Docker', cmd: 'docker', group: 'Dev' },
  { name: 'kubectl', cmd: 'kubectl', group: 'Dev' },
  { name: 'npm', cmd: 'npm', group: 'Dev' },
  { name: 'pnpm', cmd: 'pnpm', group: 'Dev' },
  { name: 'yarn', cmd: 'yarn', group: 'Dev' },
  { name: 'Node', cmd: 'node', group: 'Runtime' },
  { name: 'Bun', cmd: 'bun', group: 'Runtime' },
  { name: 'Deno', cmd: 'deno', group: 'Runtime' },
  { name: 'Python', cmd: 'python3', group: 'Runtime' },
  { name: 'cargo', cmd: 'cargo', group: 'Runtime' },
  { name: 'go', cmd: 'go', group: 'Runtime' },
  { name: 'psql', cmd: 'psql', group: 'DB' },
  { name: 'sqlite3', cmd: 'sqlite3', group: 'DB' },
  { name: 'redis-cli', cmd: 'redis-cli', group: 'DB' },
  { name: 'htop', cmd: 'htop', group: 'System' }
]

let pathDirs: string[] | null = null
async function getPathDirs(): Promise<string[]> {
  if (pathDirs) return pathDirs
  try {
    const loginShell = process.env.SHELL || '/bin/zsh'
    const { stdout } = await pexec(loginShell, ['-lic', 'echo $PATH'], { timeout: 5000 })
    pathDirs = stdout.trim().split(':').filter(Boolean)
  } catch {
    pathDirs = (process.env.PATH || '').split(':').filter(Boolean)
  }
  return pathDirs
}

async function resolve(cmd: string, dirs: string[]): Promise<string | null> {
  for (const d of dirs) {
    const p = path.join(d, cmd)
    try {
      await fsp.access(p, fsc.X_OK)
      return p
    } catch {
      /* not here */
    }
  }
  return null
}

export function registerCliHandlers(): void {
  ipcMain.handle('cli:list', async () => {
    const dirs = await getPathDirs()
    const results = await Promise.all(
      CANDIDATES.map(async (c) => ({ ...c, path: await resolve(c.cmd, dirs) }))
    )
    return results.filter((r) => r.path)
  })
}
