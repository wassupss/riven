import { ipcMain } from 'electron'
import { getPathDirs, resolveBin } from './shellPath'

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

export function registerCliHandlers(): void {
  ipcMain.handle('cli:list', async () => {
    await getPathDirs() // warm the login-shell PATH cache once
    const results = await Promise.all(
      CANDIDATES.map(async (c) => ({ ...c, path: await resolveBin(c.cmd) }))
    )
    return results.filter((r) => r.path)
  })
}
