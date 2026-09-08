import { app, ipcMain, WebContents } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as pty from 'node-pty'
import { writeMcpConfig, mcpSystemPrompt, implementedToolNames } from './mcpServer'
import { resolveBin } from './shellPath'

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
  // Coalesce PTY output: a flood command (cat huge file, yes, a runaway build)
  // fires onData many times per frame; batching into one IPC per ~frame instead
  // of one-IPC-per-chunk keeps the main↔renderer channel from saturating.
  dataBuf: string
  flushTimer: ReturnType<typeof setTimeout> | null
  // Flow control: bytes sent to the renderer but not yet acked (xterm-processed).
  // A flood (yes / cat huge file / runaway build) produces data far faster than
  // xterm can render; without backpressure the un-drained IPC messages pile up in
  // the main process and RSS explodes (measured 14GB). We pause the PTY above a
  // high-water mark and resume once the renderer has caught up.
  outstanding: number
  paused: boolean
  // "A user submitted a line (Enter) and we're waiting for the agent's reply."
  // Gates the done-notification to one per user-initiated turn (so idle TUI
  // redraws don't fire it), and turnBuf accumulates that turn's output so we can
  // put a snippet of the reply in the notification.
  awaitingReply: boolean
  turnBuf: string
  // OSC scan state, carried across reads. See hasBell.
  // 0 = normal, 1 = saw ESC, 2 = inside an OSC string, 3 = inside an OSC, saw ESC.
  osc: 0 | 1 | 2 | 3
}

const sessions = new Map<string, Session>()
const BUFFER_CAP = 200_000
const FLUSH_MS = 8 // batch onData chunks into ~one IPC per frame
const FLUSH_MAX = 256 * 1024 // flush immediately once a batch reaches this size
// Flow-control water marks (bytes in-flight to the renderer). Pause the PTY above
// HIGH so main memory stays bounded under a flood; resume below LOW so throughput
// stays smooth. ~4MB/512KB keeps a healthy pipeline without stalling normal use.
const HIGH_WATER = 4 * 1024 * 1024
const LOW_WATER = 512 * 1024
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
// A zsh startup dir riven owns, sourced INSTEAD of the user's (it sources theirs
// first, so nothing of theirs is lost). Its .zshrc defines a `claude` function
// that injects riven's own MCP server, so a hand-typed `claude` in a riven
// terminal can drive the IDE exactly like the native chat pane — without writing
// anything into the user's global Claude config. Ported from the native app
// (main.swift `setupShellShim`).
//
// Interactive shells only (.zshrc is not sourced for scripts), so a script that
// calls `claude` is unaffected.
function shimDir(): string {
  return path.join(app.getPath('userData'), 'zdotdir')
}

let shimReady = false

// Single-quote a path for the shell. userData sits under "Application Support",
// so the space alone breaks an unquoted assignment.
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// 0700: everything here is SOURCED BY THE SHELL, so write access for another
// local user would be code execution in this user's terminal. The explicit chmod
// matters — mkdir's mode is ignored when the directory already exists, which it
// does on every launch after the first.
export function setupShellShim(): void {
  const dir = shimDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    const files: Record<string, string> = {
      // $HOME/.zshenv is the conventional place to set ZDOTDIR, and a user who
      // does that keeps their .zprofile/.zshrc THERE, not in $HOME. So hand it
      // the real default first, let it speak, then record where it pointed —
      // assuming $HOME would silently load none of their config in every riven
      // terminal. ZDOTDIR goes back to ours so zsh finds the two files below.
      // The dir is embedded, NOT derived from $0: zsh sets $0 to the shell name
      // (not the file path) while sourcing a startup file, so `${0:A:h}` resolves
      // against the CWD — verified, it clobbered ZDOTDIR and no user config loaded.
      '.zshenv': `ZDOTDIR="$HOME"
[ -r "$HOME/.zshenv" ] && source "$HOME/.zshenv"
export RIVEN_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"
ZDOTDIR=${sq(dir)}`,
      '.zprofile':
        '[ -r "$RIVEN_USER_ZDOTDIR/.zprofile" ] && source "$RIVEN_USER_ZDOTDIR/.zprofile"',
      '.zshrc': `[ -r "$RIVEN_USER_ZDOTDIR/.zshrc" ] && source "$RIVEN_USER_ZDOTDIR/.zshrc"
# riven: typing \`claude\` here gets riven's OWN tools (ask_user / open file /
# panels / browser / notes), like the native chat pane.
if [ -n "$RIVEN_MCP_CONFIG" ]; then
  claude() {
    # Build flags in a zsh array — NOT via \${VAR:+--flag "$VAR"}: zsh does not
    # field-split parameter expansions, so that form passes '--flag value' to
    # claude as a single argv word and it rejects it.
    local -a rv
    rv+=(--mcp-config "$RIVEN_MCP_CONFIG")
    [ -n "$RIVEN_MCP_PROMPT" ] && rv+=(--append-system-prompt "$RIVEN_MCP_PROMPT")
    command "\${RIVEN_REAL_CLAUDE:-claude}" "\${rv[@]}" "$@"
  }
fi
# Restore so .zlogin and any nested shell use the user's own dir, not ours.
export ZDOTDIR="$RIVEN_USER_ZDOTDIR"`
    }
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body + '\n', { mode: 0o600 })
    }
    shimReady = true
  } catch (e) {
    // A terminal without riven's tools still runs; a terminal that fails to
    // start does not. Never fatal.
    console.error('[riven] shell shim setup failed', e)
    shimReady = false
  }
}

// Resolved once: `resolveBin` walks the user's real PATH, and ptyEnv is sync.
let realClaude: string | null = null
export function primeShellShim(): void {
  setupShellShim()
  void resolveBin('claude').then((p) => {
    realClaude = p
  })
}

function ptyEnv(configDir?: string): Record<string, string> {
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
  // Only when the workspace pins a Claude account profile, so a terminal and the
  // native chat in the same workspace run as the same account. Without a profile
  // we set nothing and the user's shell rc stays in charge.
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  // zsh only: ZDOTDIR is what makes the shim possible, and bash/fish have no
  // equivalent that survives a login shell. Their terminals just run unshimmed.
  const mcpConfig = shimReady && /zsh$/.test(defaultShell()) ? writeMcpConfig(implementedToolNames()) : null
  if (mcpConfig) {
    env.ZDOTDIR = shimDir()
    env.RIVEN_MCP_CONFIG = mcpConfig
    env.RIVEN_MCP_PROMPT = mcpSystemPrompt()
    // The shim runs `command claude`, which is resolved against the shell's PATH.
    // That is usually right, but riven knows the absolute path it found itself.
    if (realClaude) env.RIVEN_REAL_CLAUDE = realClaude
  }
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

// Send any buffered PTY output as a single IPC message and clear the batch.
function flushData(s: Session): void {
  if (s.flushTimer) {
    clearTimeout(s.flushTimer)
    s.flushTimer = null
  }
  if (!s.dataBuf) return
  const data = s.dataBuf
  s.dataBuf = ''
  s.outstanding += data.length
  send(s, `pty:data:${s.key}`, data)
  // Above the high-water mark of un-acked data: pause the source so main memory
  // can't grow unbounded while the renderer catches up.
  if (!s.paused && s.outstanding >= HIGH_WATER) {
    s.paused = true
    try {
      s.proc.pause()
    } catch {
      /* pause unsupported — best effort */
    }
  }
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

// Does this chunk contain a REAL bell? A 0x07 that terminates an OSC string is
// not one. Every shell that sets the window title emits `ESC ] 2 ; <title> BEL`,
// and oh-my-zsh's auto-title does it TWICE per prompt (window + tab) — so
// treating any 0x07 as a bell fired two spurious notifications for every command
// the user ran. Verified against the user's own zsh in a real pty: 12 BEL bytes,
// all 12 OSC terminators, zero actual bells.
//
// A state machine, NOT a lookahead: node-pty hands us arbitrary chunks, so every
// boundary has to be resumable — including one falling BETWEEN the ESC and the
// `]` that introduce the OSC. A version of this that peeked at `data[i + 1]`
// looked correct and passed on realistic chunk sizes, but read `undefined` at
// such a split, missed the OSC entirely, and then counted its terminator as a
// bell: replaying a real capture one byte at a time fired all 16 times.
function hasBell(s: Session, data: string): boolean {
  let bell = false
  for (const c of data) {
    switch (s.osc) {
      case 1: // saw ESC outside an OSC
        if (c === ']') s.osc = 2
        else if (c === '\x1b') s.osc = 1
        else {
          s.osc = 0
          if (c === '\x07') bell = true
        }
        break
      case 2: // inside an OSC string: BEL and ST both just end it
        if (c === '\x07') s.osc = 0
        else if (c === '\x1b') s.osc = 3
        break
      case 3: // inside an OSC, saw ESC — ST is ESC \
        s.osc = c === '\\' ? 0 : c === '\x1b' ? 3 : 2
        break
      default:
        if (c === '\x1b') s.osc = 1
        else if (c === '\x07') bell = true
    }
  }
  return bell
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
  // Clean quit. PTYs live in the main process; left running they make Electron
  // hang ("Not Responding") on quit. Killing the child isn't enough — node-pty's
  // master-fd handle keeps the libuv loop alive after the child dies, so the
  // process still won't exit. Tear everything down, then force-exit as a backstop.
  let quitting = false
  app.on('before-quit', () => {
    if (quitting) return
    quitting = true
    // Kill terminals so no shell/agent is orphaned.
    for (const [, s] of sessions) {
      if (s.poll) clearInterval(s.poll)
      if (s.activeTimer) clearTimeout(s.activeTimer)
      if (s.flushTimer) clearTimeout(s.flushTimer)
      try {
        s.proc.kill()
      } catch {
        /* already exited */
      }
    }
    sessions.clear()
    // NOTE: the hard SIGKILL backstop is registered LAST in index.ts (after the
    // LSP handlers), not here — killing our own process from this handler would
    // pre-empt lsp.ts's before-quit and orphan the language servers.
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
        configDir?: string
      }
    ) => {
      const key = opts.sessionKey
      const existing = sessions.get(key)
      if (existing) {
        existing.sender = event.sender
        return { id: key, existed: true, buffer: existing.snapshot }
      }

      const shell = defaultShell()
      // Spawn a LOGIN + INTERACTIVE shell like every real terminal emulator
      // (ghostty/Terminal.app) so the full init runs (.zprofile + .zshrc): PATH,
      // homebrew, and prompt daemons such as powerlevel10k's gitstatusd. A bare
      // interactive shell (no -l) skipped enough of that init that gitstatusd
      // never came up, so p10k fell back to synchronous git and every prompt was
      // slow (the "lag / blank rows while holding Enter"). For a launch command,
      // run it in that login/interactive shell, then drop back to one.
      const loginInteractive = ['-l', '-i']
      const args = opts.initialCommand
        ? [...loginInteractive, '-c', `${opts.initialCommand}; exec ${shell} -il`]
        : loginInteractive

      let proc: pty.IPty
      try {
        proc = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: opts.cols ?? 80,
          rows: opts.rows ?? 24,
          cwd: opts.cwd || os.homedir(),
          env: ptyEnv(opts.configDir)
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
        osc: 0,
        turnBuf: '',
        startupUntil: Date.now() + 3000,
        agentPresent: false,
        agentName: null,
        lastInput: 0,
        lastData: Date.now(),
        poll: null,
        polling: false,
        activeTimer: null,
        dataBuf: '',
        flushTimer: null,
        outstanding: 0,
        paused: false
      }
      sessions.set(key, s)

      proc.onData((data) => {
        s.lastData = Date.now()
        // Coalesce output into one IPC per frame instead of one per chunk.
        s.dataBuf += data
        if (s.dataBuf.length >= FLUSH_MAX) flushData(s)
        else if (!s.flushTimer) s.flushTimer = setTimeout(() => flushData(s), FLUSH_MS)
        if (hasBell(s, data)) send(s, 'pty:bell', { key })
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
        flushData(s) // don't drop the final output batch
        send(s, `pty:exit:${key}`, exitCode)
        if (s.poll) clearInterval(s.poll)
        if (s.activeTimer) clearTimeout(s.activeTimer)
        if (s.flushTimer) clearTimeout(s.flushTimer)
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

  // The renderer acks bytes once xterm has parsed them; drain the in-flight count
  // and resume the PTY when we're back below the low-water mark.
  ipcMain.on('pty:ack', (_event, key: string, bytes: number) => {
    const s = sessions.get(key)
    if (!s) return
    s.outstanding = Math.max(0, s.outstanding - bytes)
    if (s.paused && s.outstanding <= LOW_WATER) {
      s.paused = false
      try {
        s.proc.resume()
      } catch {
        /* resume unsupported — best effort */
      }
    }
  })

  // The renderer became visible again (was buffering while hidden): clear the
  // in-flight count and resume the PTY unconditionally. Safe because on show the
  // pane replays its buffered screen and then fits, so main's outstanding estimate
  // can be reset without losing display state.
  ipcMain.on('pty:resume', (_event, key: string) => {
    const s = sessions.get(key)
    if (!s) return
    s.outstanding = 0
    if (s.paused) {
      s.paused = false
      try {
        s.proc.resume()
      } catch {
        /* best effort */
      }
    }
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
      if (s.flushTimer) clearTimeout(s.flushTimer)
      try {
        s.proc.kill()
      } catch {
        /* already dead */
      }
      sessions.delete(key)
    }
  })
}
