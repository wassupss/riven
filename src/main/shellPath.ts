import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fsp, constants as fsc } from 'fs'
import * as path from 'path'

const pexec = promisify(execFile)

// macOS GUI apps launch with a minimal PATH that omits Homebrew / language
// toolchains. Ask the user's login shell for the real PATH so we can find CLIs
// (language servers, dev tools) the same way a terminal would.
// Cache the in-flight promise, not just the resolved value: at startup the LSP
// and terminal subsystems call this concurrently, and caching only the result
// would spawn the (slow) login shell once per caller before the first resolves.
let pathDirsPromise: Promise<string[]> | null = null
export function getPathDirs(): Promise<string[]> {
  if (pathDirsPromise) return pathDirsPromise
  pathDirsPromise = (async () => {
    try {
      const loginShell = process.env.SHELL || '/bin/zsh'
      const { stdout } = await pexec(loginShell, ['-lic', 'echo $PATH'], { timeout: 5000 })
      return stdout.trim().split(':').filter(Boolean)
    } catch {
      return (process.env.PATH || '').split(':').filter(Boolean)
    }
  })()
  return pathDirsPromise
}

// Agent CLIs cost the user money every time one starts a turn, and an e2e run
// mounts panes by the dozen. Under RIVEN_E2E these resolve to nothing, so every
// path that would have spawned one reports "not found" — the failure it already
// knows how to show — instead of billing a test run. Everything else (git, the
// shell, language servers) resolves normally: the tests need those.
const BILLED = new Set(['claude', 'codex'])

// Resolve an executable name to an absolute path across the login-shell PATH.
export async function resolveBin(cmd: string): Promise<string | null> {
  if (process.env.RIVEN_E2E && BILLED.has(cmd)) return null
  const dirs = await getPathDirs()
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

/**
 * Which installed build `cmd` is: its real path (symlinks followed) plus that
 * file's modification time. The native installer re-points ~/.local/bin/claude
 * at …/versions/<version> on update, so the path changes; an npm install keeps
 * the path and rewrites the file, so the time does. Either way, a different
 * answer means a different CLI. Null when it cannot be read.
 */
export async function binIdentity(cmd: string | null): Promise<string | null> {
  if (!cmd) return null
  try {
    const real = await fsp.realpath(cmd)
    const st = await fsp.stat(real)
    return `${real}#${Math.round(st.mtimeMs)}`
  } catch {
    return null
  }
}
