import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const pexec = promisify(execFile)

export interface PortInfo {
  port: number
  pid: number
  name: string // owning command, e.g. "node", "next-server"
}

// Listening TCP ports whose owning process's working directory is inside the
// workspace — i.e. "servers running for this repo". Each entry carries the owning
// process so the UI can say WHAT is running on a port, not just its number.
async function listPorts(folder: string): Promise<PortInfo[]> {
  {
    try {
      // -Fpcn ⇒ p<pid> c<command> n<name>
      const { stdout } = await pexec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], {
        timeout: 4000
      })
      const byPid = new Map<string, Set<number>>()
      const nameByPid = new Map<string, string>()
      let pid = ''
      for (const line of stdout.split('\n')) {
        if (line[0] === 'p') pid = line.slice(1)
        else if (line[0] === 'c' && pid) nameByPid.set(pid, line.slice(1))
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

      const out: PortInfo[] = []
      const seen = new Set<number>()
      for (const [p, set] of byPid) {
        const cwd = cwdByPid.get(p)
        if (!cwd || !(cwd === folder || cwd.startsWith(folder + '/'))) continue
        for (const port of set) {
          if (seen.has(port)) continue
          seen.add(port)
          out.push({ port, pid: Number(p), name: nameByPid.get(p) || 'unknown' })
        }
      }
      return out.sort((a, b) => a.port - b.port)
    } catch {
      return []
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function registerPortsHandlers(): void {
  ipcMain.handle('ports:list', async (_e, folder: string): Promise<PortInfo[]> => listPorts(folder))

  // Stop whatever is listening on one of THIS workspace's ports.
  //
  // The pid is re-derived from the same lsof scan rather than trusted from the
  // renderer: an ipc handler that kills whatever number it is handed is a way to
  // kill anything on the machine, including processes with nothing to do with
  // riven. Only a pid that is, right now, listening on that port with its cwd
  // inside the workspace is eligible — the exact set the status bar shows.
  //
  // SIGTERM first so a dev server can shut its own sockets down; SIGKILL only if
  // it is still there afterwards.
  ipcMain.handle(
    'ports:kill',
    async (
      _e,
      folder: string,
      port: number,
      pid: number
    ): Promise<{ ok: boolean; forced?: boolean; error?: string }> => {
      const current = await listPorts(folder)
      const match = current.find((p) => p.port === port && p.pid === pid)
      if (!match) return { ok: false, error: 'that port is no longer held by that process' }
      // riven's own loopback MCP server listens too, and in a dev checkout its
      // cwd is inside the workspace — killing it would take the app down.
      if (pid === process.pid) return { ok: false, error: 'that is riven itself' }
      try {
        process.kill(pid, 'SIGTERM')
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      for (let i = 0; i < 12 && alive(pid); i++) await sleep(250)
      if (!alive(pid)) return { ok: true }
      try {
        process.kill(pid, 'SIGKILL')
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      await sleep(200)
      return alive(pid) ? { ok: false, error: 'process would not exit' } : { ok: true, forced: true }
    }
  )
}
