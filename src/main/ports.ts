import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const pexec = promisify(execFile)

// Listening TCP ports whose owning process's working directory is inside the
// workspace — i.e. "servers running for this repo".
export function registerPortsHandlers(): void {
  ipcMain.handle('ports:list', async (_e, folder: string): Promise<number[]> => {
    try {
      const { stdout } = await pexec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], {
        timeout: 4000
      })
      const byPid = new Map<string, Set<number>>()
      let pid = ''
      for (const line of stdout.split('\n')) {
        if (line[0] === 'p') pid = line.slice(1)
        else if (line[0] === 'n' && pid) {
          const m = line.match(/:(\d+)$/)
          if (m) {
            if (!byPid.has(pid)) byPid.set(pid, new Set())
            byPid.get(pid)!.add(Number(m[1]))
          }
        }
      }
      if (byPid.size === 0) return []

      const pids = [...byPid.keys()]
      const { stdout: cwdOut } = await pexec('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], {
        timeout: 4000
      }).catch(() => ({ stdout: '' }))
      const cwdByPid = new Map<string, string>()
      let cp = ''
      for (const line of cwdOut.split('\n')) {
        if (line[0] === 'p') cp = line.slice(1)
        else if (line[0] === 'n' && cp) cwdByPid.set(cp, line.slice(1))
      }

      const ports = new Set<number>()
      for (const [p, set] of byPid) {
        const cwd = cwdByPid.get(p)
        if (cwd && (cwd === folder || cwd.startsWith(folder + '/'))) {
          set.forEach((port) => ports.add(port))
        }
      }
      return [...ports].sort((a, b) => a - b)
    } catch {
      return []
    }
  })
}
