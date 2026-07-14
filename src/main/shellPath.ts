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

// Resolve an executable name to an absolute path across the login-shell PATH.
export async function resolveBin(cmd: string): Promise<string | null> {
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
