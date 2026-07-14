import { ipcMain, WebContents } from 'electron'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as pty from 'node-pty'

const pexec = promisify(execFile)

// PTY sessions live in the MAIN process, keyed by a stable sessionKey, and are
// NOT tied to the renderer lifetime (survive reloads; killed only on explicit
// kill). "Running" means an AGENT is actually running in the terminal — detected
// by inspecting the shell's child process command lines (not raw output, and not
// generic commands), so typing / ls / dev-servers don't read as an agent.

interface Session {
  key: string
  proc: pty.IPty
  sender: WebContents
  snapshot: string // serialized screen (from renderer), replayed on reconnect
  busy: boolean
  busyStart: number
  startupUntil: number
  agentPresent: boolean
  agentName: string | null
  lastInput: number
  poll: ReturnType<typeof setInterval> | null
  polling: boolean
  activeTimer: ReturnType<typeof setTimeout> | null
}

const sessions = new Map<string, Session>()
const BUFFER_CAP = 200_000
const POLL_MS = 900
const ACTIVE_MS = 800 // output must flow within this window to count as "working"
const INPUT_ECHO_MS = 350 // output within this long after a keystroke = echo, ignore
const NOTIFY_MIN_BUSY_MS = 1200

// Known AI coding agents. claude ships as a native binary named by version, so we
// also match its install path.
const AGENT_RE =
  /(?:^|\/|\s)(claude|codex|aider|gemini|opencode|cursor-agent|ollama|goose|crush|cline|amp)(?:\s|$)|[\\/](?:share|bin)[\\/]claude[\\/]/i

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

// Returns the name of the agent running as the shell's foreground child, or null.
async function agentRunning(shellPid: number): Promise<string | null> {
  try {
    const { stdout: kidsOut } = await pexec('pgrep', ['-P', String(shellPid)], { timeout: 1500 })
    const kids = kidsOut.split('\n').filter(Boolean)
    if (!kids.length) return null
    const { stdout: args } = await pexec('ps', ['-o', 'args=', '-p', kids.join(',')], {
      timeout: 1500
    })
    const m = args.match(AGENT_RE)
    if (!m) return null
    return m[1] ?? 'claude' // the path-based branch (no capture group) is claude
  } catch {
    return null
  }
}

function send(s: Session, channel: string, ...args: unknown[]): void {
  if (!s.sender.isDestroyed()) s.sender.send(channel, ...args)
}

// "Working" = an agent is the foreground child AND output is actively flowing.
// Output activity (onData) drives busy on; a gap of ACTIVE_MS drives it off, so
// an agent sitting idle at its input prompt does not read as running.
function markActive(s: Session): void {
  if (!s.agentPresent) return
  if (!s.busy) {
    s.busy = true
    s.busyStart = Date.now()
    send(s, 'pty:status', { key: s.key, busy: true })
  }
  if (s.activeTimer) clearTimeout(s.activeTimer)
  s.activeTimer = setTimeout(() => {
    s.busy = false
    const duration = Date.now() - s.busyStart
    send(s, 'pty:status', { key: s.key, busy: false })
    if (duration > NOTIFY_MIN_BUSY_MS && Date.now() >= s.startupUntil) {
      send(s, 'pty:done', { key: s.key, duration })
    }
  }, ACTIVE_MS)
}

export function registerPtyHandlers(): void {
  ipcMain.handle(
    'pty:open',
    (
      event,
      opts: {
        sessionKey: string
        cwd: string
        initialCommand?: string
        cols?: number
        rows?: number
      }
    ) => {
      const key = opts.sessionKey
      const existing = sessions.get(key)
      if (existing) {
        existing.sender = event.sender
        return { id: key, existed: true, buffer: existing.snapshot }
      }

      const shell = defaultShell()
      // For a launch command, have the (login/interactive) shell run it directly,
      // then drop back to an interactive shell — reliable vs. typing into stdin.
      const args = opts.initialCommand
        ? ['-i', '-l', '-c', `${opts.initialCommand}; exec ${shell} -il`]
        : []

      const proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: opts.cwd || os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
      })

      const s: Session = {
        key,
        proc,
        sender: event.sender,
        snapshot: '',
        busy: false,
        busyStart: 0,
        startupUntil: Date.now() + 3000,
        agentPresent: false,
        agentName: null,
        lastInput: 0,
        poll: null,
        polling: false,
        activeTimer: null
      }
      sessions.set(key, s)

      proc.onData((data) => {
        send(s, `pty:data:${key}`, data)
        if (data.includes('\x07')) send(s, 'pty:bell', { key })
        // Ignore output that's just an echo of the user's own keystrokes; only
        // agent-generated output (not right after typing) counts as "working".
        if (Date.now() - s.lastInput > INPUT_ECHO_MS) markActive(s)
      })

      // Track whether an agent is the foreground child.
      s.poll = setInterval(async () => {
        if (s.polling) return
        s.polling = true
        const was = s.agentPresent
        const wasName = s.agentName
        const name = await agentRunning(proc.pid)
        s.agentPresent = !!name
        s.agentName = name
        s.polling = false
        // Notify the renderer when an LLM agent appears/disappears (or changes) in
        // this pane — used for context routing + auto tab titles.
        if (s.agentPresent !== was || name !== wasName)
          send(s, 'pty:agent', { key, agent: s.agentPresent, name })
        // Agent gone → definitely not running.
        if (!s.agentPresent && s.busy) {
          s.busy = false
          if (s.activeTimer) clearTimeout(s.activeTimer)
          send(s, 'pty:status', { key, busy: false })
        }
      }, POLL_MS)

      proc.onExit(({ exitCode }) => {
        send(s, `pty:exit:${key}`, exitCode)
        if (s.poll) clearInterval(s.poll)
        if (s.activeTimer) clearTimeout(s.activeTimer)
        sessions.delete(key)
      })

      return { id: key, existed: false, buffer: '' }
    }
  )

  ipcMain.on('pty:write', (_event, key: string, data: string) => {
    const s = sessions.get(key)
    if (!s) return
    s.lastInput = Date.now() // mark keystroke time so its echo isn't seen as work
    s.proc.write(data)
  })

  ipcMain.on('pty:snapshot', (_event, key: string, data: string) => {
    const s = sessions.get(key)
    if (s) s.snapshot = data
  })

  ipcMain.on('pty:resize', (_event, key: string, cols: number, rows: number) => {
    const s = sessions.get(key)
    if (s && cols > 0 && rows > 0) {
      try {
        s.proc.resize(cols, rows)
      } catch {
        /* pty may have exited */
      }
    }
  })

  ipcMain.on('pty:kill', (_event, key: string) => {
    const s = sessions.get(key)
    if (s) {
      if (s.poll) clearInterval(s.poll)
      if (s.activeTimer) clearTimeout(s.activeTimer)
      try {
        s.proc.kill()
      } catch {
        /* already dead */
      }
      sessions.delete(key)
    }
  })
}
