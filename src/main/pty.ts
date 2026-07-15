import { app, ipcMain, WebContents } from 'electron'
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
  lastData: number
  poll: ReturnType<typeof setInterval> | null
  polling: boolean
  activeTimer: ReturnType<typeof setTimeout> | null
  // "A user submitted a line (Enter) and we're waiting for the agent's reply."
  // Gates the done-notification to one per user-initiated turn (so idle TUI
  // redraws don't fire it), and turnBuf accumulates that turn's output so we can
  // put a snippet of the reply in the notification.
  awaitingReply: boolean
  turnBuf: string
}

const sessions = new Map<string, Session>()
const BUFFER_CAP = 200_000
const POLL_MS = 900
const IDLE_POLL_MS = 5000 // skip the pgrep/ps child-process probe after this much silence
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

// Build the PTY environment, guaranteeing a UTF-8 locale (issue #5). When the app
// is launched from the macOS GUI (Finder/Dock) the shell's LANG/LC_* are usually
// absent, so the shell + readline + CLIs fall back to the C/ASCII locale and
// mangle multibyte input — typing Korean/CJK via an IME comes out corrupted.
// If no UTF-8 locale is already present we set one (without clobbering a locale
// the user has deliberately configured, e.g. ko_KR.UTF-8).
function ptyEnv(): Record<string, string> {
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
  if (process.platform !== 'win32') {
    const hasUtf8 = [env.LC_ALL, env.LC_CTYPE, env.LANG].some((v) => v && /utf-?8/i.test(v))
    if (!hasUtf8) {
      // en_US.UTF-8 exists on macOS and virtually all Linux installs; this fixes
      // the character encoding while leaving message language to the user's rc.
      env.LANG = env.LANG || 'en_US.UTF-8'
      env.LC_CTYPE = 'en_US.UTF-8'
    }
  }
  return env
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

// Best-effort plain-text snippet of an agent's reply, pulled from the raw PTY
// output of the turn. Terminal UIs are full of ANSI/cursor redraws, so this
// strips escapes + box-drawing and returns the tail few content lines — enough
// for a notification preview, not a faithful transcript.
function extractSummary(raw: string): string {
  if (!raw) return ''
  const noEsc = raw
    // OSC (title etc.): ESC ] ... BEL/ST
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI + other single escapes
    .replace(/\x1b[[\]()#;?=][0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    // remaining control chars except tab/newline/CR
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  const lines = noEsc.split('\n').map((ln) => {
    // A CR redraws the line; keep only what's after the last CR.
    const seg = ln.split('\r')
    return seg[seg.length - 1].replace(/[─-╿▀-▟]/g, '').trimEnd()
  })
  const content = lines.filter((l) => l.trim().length > 0)
  const tail = content.slice(-8).join('\n').replace(/[ \t]+/g, ' ').trim()
  return tail.length > 240 ? '…' + tail.slice(-240) : tail
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
    // Notify only for a turn the USER kicked off (Enter) — not idle TUI redraws —
    // and only once per turn. Include a snippet of the agent's reply.
    if (
      s.awaitingReply &&
      duration > NOTIFY_MIN_BUSY_MS &&
      Date.now() >= s.startupUntil
    ) {
      const summary = extractSummary(s.turnBuf)
      s.awaitingReply = false
      s.turnBuf = ''
      send(s, 'pty:done', { key: s.key, duration, summary })
    }
  }, ACTIVE_MS)
}

export function registerPtyHandlers(): void {
  // Kill every PTY on quit. node-pty child processes aren't tied to the renderer
  // and, left running, make Electron hang ("Not Responding") on quit while it
  // waits on the open pty handles. Tear down timers + processes so quit is clean.
  app.on('before-quit', () => {
    for (const [, s] of sessions) {
      if (s.poll) clearInterval(s.poll)
      if (s.activeTimer) clearTimeout(s.activeTimer)
      try {
        s.proc.kill()
      } catch {
        /* already exited */
      }
    }
    sessions.clear()
  })

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

      let proc: pty.IPty
      try {
        proc = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: opts.cols ?? 80,
          rows: opts.rows ?? 24,
          cwd: opts.cwd || os.homedir(),
          env: ptyEnv()
        })
      } catch (e) {
        // A bad shell / cwd shouldn't reject the invoke and break the pane.
        console.error('[riven] pty spawn failed', e)
        return { id: key, existed: false, buffer: '', error: e instanceof Error ? e.message : String(e) }
      }

      const s: Session = {
        key,
        proc,
        sender: event.sender,
        snapshot: '',
        busy: false,
        busyStart: 0,
        awaitingReply: false,
        turnBuf: '',
        startupUntil: Date.now() + 3000,
        agentPresent: false,
        agentName: null,
        lastInput: 0,
        lastData: Date.now(),
        poll: null,
        polling: false,
        activeTimer: null
      }
      sessions.set(key, s)

      proc.onData((data) => {
        s.lastData = Date.now()
        send(s, `pty:data:${key}`, data)
        if (data.includes('\x07')) send(s, 'pty:bell', { key })
        // While waiting for a reply, accumulate the turn's output (capped) so the
        // done-notification can preview it.
        if (s.awaitingReply) {
          s.turnBuf += data
          if (s.turnBuf.length > 16000) s.turnBuf = s.turnBuf.slice(-16000)
        }
        // Ignore output that's just an echo of the user's own keystrokes; only
        // agent-generated output (not right after typing) counts as "working".
        if (Date.now() - s.lastInput > INPUT_ECHO_MS) markActive(s)
      })

      // Track whether an agent is the foreground child.
      s.poll = setInterval(async () => {
        if (s.polling) return
        // When no agent is present and the terminal has been silent, skip the
        // pgrep/ps probe entirely — an agent can only appear after output flows
        // (its startup banner / the echoed command), which refreshes lastData.
        if (!s.agentPresent && Date.now() - s.lastData > IDLE_POLL_MS) return
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
    // A carriage return = the user submitted a line. If an agent is running, arm
    // the one-shot "reply done" notification and start capturing its output.
    if (s.agentPresent && data.includes('\r')) {
      s.awaitingReply = true
      s.turnBuf = ''
    }
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
