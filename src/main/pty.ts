import { app, ipcMain, WebContents } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mcpConfigJson, mcpSystemPrompt, implementedToolNames } from './mcpServer'
import { resolveBin } from './shellPath'
import { TerminalActivity, type AttentionReason } from './terminal/activity'
import { hookEnv, registerAgentHooks } from './agentHooks'
import { TerminalWorkerHost } from './terminal/worker-host'
import type { WorkerToMain } from './terminal/worker-protocol'

const pexec = promisify(execFile)

// PTY sessions are keyed by a stable sessionKey and are NOT tied to the renderer
// lifetime (they survive reloads; they die only on explicit kill).
//
// The PTYs themselves, and the terminal MODEL, live in a separate
// `utilityProcess` worker (src/main/terminal/worker-entry.ts). A headless xterm
// there ingests every byte the PTY produces, so the authoritative screen +
// scrollback exist whether or not a renderer is looking. That is what makes
// hidden panes free (their bytes are simply not delivered), reattach exact (the
// renderer gets a snapshot of the model, not a stale copy it once uploaded), and
// reconnection race-free: every delivered chunk carries a model revision, a
// snapshot carries the revision it reflects, and the renderer drops any chunk at
// or below it.
//
// Main's job here is routing only: the session registry, renderer IPC, agent
// hooks, the activity state machine and notifications. Keeping the parser and
// its scrollback out of this process is why main's memory no longer tracks
// terminal output. Same structure as paseo's forked terminal worker and orca's
// terminal daemon.

interface Session {
  key: string
  sender: WebContents
  cwd: string
  // Reported by the worker once the shell is up; used for the agent probe.
  pid: number
  cols: number
  rows: number
  activity: TerminalActivity
  agentPresent: boolean
  agentName: string | null
  poll: ReturnType<typeof setInterval> | null
  polling: boolean
  activeTimer: ReturnType<typeof setTimeout> | null
  busyStart: number
  lastInput: number
  lastData: number
  startupUntil: number
  // Heuristic-only: "the user pressed Enter and we're waiting for the reply",
  // so an idle TUI redraw never counts as a finished turn.
  awaitingReply: boolean
}

const sessions = new Map<string, Session>()
const POLL_MS = 1500
const IDLE_POLL_MS = 5000 // skip the pgrep/ps child-process probe after this much silence
const ACTIVE_MS = 800 // output must flow within this window to count as "working"
const INPUT_ECHO_MS = 350 // output within this long after a keystroke = echo, ignore
const NOTIFY_MIN_BUSY_MS = 1200
const TAIL_TIMEOUT_MS = 1000

// Known AI coding agents. claude ships as a native binary named by version, so we
// also match its install path.
const AGENT_RE =
  /(?:^|\/|\s)(claude|codex|aider|gemini|opencode|cursor-agent|ollama|goose|crush|cline|amp)(?:\s|$)|[\\/](?:share|bin)[\\/]claude[\\/]/i

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

// A zsh startup dir riven owns, sourced INSTEAD of the user's (it sources theirs
// first, so nothing of theirs is lost). Its .zshrc defines a `claude` function
// that injects riven's own MCP server and its agent hooks, so a hand-typed
// `claude` in a riven terminal can drive the IDE exactly like the native chat
// pane — without writing anything into the user's global Claude config. Ported
// from the native app (main.swift `setupShellShim`).
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
# panels / browser / notes) and its lifecycle hooks, like the native chat pane.
if [ -n "$RIVEN_MCP_CONFIG" ]; then
  claude() {
    # Build flags in a zsh array — NOT via \${VAR:+--flag "$VAR"}: zsh does not
    # field-split parameter expansions, so that form passes '--flag value' to
    # claude as a single argv word and it rejects it.
    local -a rv
    rv+=(--mcp-config "$RIVEN_MCP_CONFIG")
    [ -n "$RIVEN_MCP_PROMPT" ] && rv+=(--append-system-prompt "$RIVEN_MCP_PROMPT")
    # Lifecycle hooks (deep-merged by the CLI, so the user's own hooks still fire).
    [ -n "$RIVEN_HOOKS_SETTINGS" ] && rv+=(--settings "$RIVEN_HOOKS_SETTINGS")
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

// Build the PTY environment, guaranteeing a UTF-8 locale (issue #5). When the app
// is launched from the macOS GUI (Finder/Dock) the shell's LANG/LC_* are usually
// absent, so the shell + readline + CLIs fall back to the C/ASCII locale and
// mangle multibyte input — typing Korean/CJK via an IME comes out corrupted.
// If no UTF-8 locale is already present we set one (without clobbering a locale
// the user has deliberately configured, e.g. ko_KR.UTF-8).
//
// Built HERE, not in the worker: it needs the MCP server's live port/token and
// the hook settings path, which only main knows.
function ptyEnv(configDir: string | undefined, key: string): Record<string, string> {
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
  // Only when the workspace pins a Claude account profile, so a terminal and the
  // native chat in the same workspace run as the same account. Without a profile
  // we set nothing and the user's shell rc stays in charge.
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  // zsh only: ZDOTDIR is what makes the shim possible, and bash/fish have no
  // equivalent that survives a login shell. Their terminals just run unshimmed.
  // The pane key on the URL is how a hand-typed `claude` is attributed to THIS
  // terminal's workspace, whatever directory the user has cd'd to since.
  const mcpConfig =
    shimReady && /zsh$/.test(defaultShell()) ? mcpConfigJson(implementedToolNames(), key) : null
  if (mcpConfig) {
    env.ZDOTDIR = shimDir()
    env.RIVEN_MCP_CONFIG = mcpConfig
    env.RIVEN_MCP_PROMPT = mcpSystemPrompt()
    // The shim runs `command claude`, which is resolved against the shell's PATH.
    // That is usually right, but riven knows the absolute path it found itself.
    if (realClaude) env.RIVEN_REAL_CLAUDE = realClaude
  }
  Object.assign(env, hookEnv(key))
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

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

let tailSeq = 0
const tailWaiters = new Map<string, (text: string) => void>()
// Resolved when the worker answers `spawn` with `spawned` or `spawnError`, so
// the renderer's `pty:open` invoke can still return {id, existed, error} exactly
// as it did when the spawn was synchronous.
const spawnWaiters = new Map<string, (result: { error?: string }) => void>()

const worker = new TerminalWorkerHost({
  onMessage: (msg) => handleWorkerMessage(msg),
  onCrash: () => handleWorkerCrash()
})

// The model lives in the worker, so a notification preview has to be asked for.
// Only on an actual done-transition, so this stays rare.
function requestTail(key: string, lines: number): Promise<string> {
  return new Promise((resolve) => {
    const requestId = String(++tailSeq)
    const timer = setTimeout(() => {
      tailWaiters.delete(requestId)
      resolve('')
    }, TAIL_TIMEOUT_MS)
    tailWaiters.set(requestId, (text) => {
      clearTimeout(timer)
      resolve(text)
    })
    worker.post({ type: 'tail', key, requestId, lines })
  })
}

function handleWorkerMessage(msg: WorkerToMain): void {
  if (msg.type === 'tailResult') {
    const waiter = tailWaiters.get(msg.requestId)
    if (waiter) {
      tailWaiters.delete(msg.requestId)
      waiter(msg.text)
    }
    return
  }

  if (msg.type === 'spawned') {
    const s = sessions.get(msg.key)
    if (s) s.pid = msg.pid
    spawnWaiters.get(msg.key)?.({})
    spawnWaiters.delete(msg.key)
    return
  }

  if (msg.type === 'spawnError') {
    const s = sessions.get(msg.key)
    if (s) dispose(s)
    spawnWaiters.get(msg.key)?.({ error: msg.error })
    spawnWaiters.delete(msg.key)
    return
  }

  const s = sessions.get(msg.key)
  if (!s) return

  switch (msg.type) {
    case 'output':
      s.lastData = Date.now()
      send(s, `pty:data:${msg.key}`, { data: msg.data, rev: msg.rev, epoch: msg.epoch })
      // Ignore output that's just an echo of the user's own keystrokes; only
      // agent-generated output (not right after typing) counts as "working".
      if (Date.now() - s.lastInput > INPUT_ECHO_MS) markActive(s)
      return
    case 'outputActivity':
      // Hidden pane: no bytes to deliver, but the heuristic still runs.
      s.lastData = Date.now()
      if (Date.now() - s.lastInput > INPUT_ECHO_MS) markActive(s)
      return
    case 'snapshot':
      send(s, `pty:snapshot:${msg.key}`, {
        data: msg.data,
        rev: msg.rev,
        epoch: msg.epoch,
        cols: msg.cols,
        rows: msg.rows
      })
      return
    case 'exit':
      send(s, `pty:exit:${msg.key}`, msg.exitCode)
      dispose(s)
      return
    case 'bell':
      send(s, 'pty:bell', { key: msg.key })
      return
    case 'title':
      send(s, 'pty:title', { key: msg.key, title: msg.title })
      return
  }
}

// The worker died on its own. Its PTYs went with it, so every session is gone:
// tell each renderer its terminal exited (the pane shows it as dead rather than
// silently freezing) and drop our state. The next `pty:open` forks a new worker.
function handleWorkerCrash(): void {
  for (const [key, s] of [...sessions]) {
    send(s, `pty:exit:${key}`, -1)
    dispose(s)
  }
  sessions.clear()
  for (const [, resolve] of spawnWaiters) resolve({ error: 'terminal worker stopped' })
  spawnWaiters.clear()
  for (const [, resolve] of tailWaiters) resolve('')
  tailWaiters.clear()
}

function publishActivity(s: Session, notify: AttentionReason): void {
  const snap = s.activity.snapshot()
  send(s, 'pty:status', { key: s.key, busy: snap.state === 'working', attention: snap.attention })
  if (notify && Date.now() >= s.startupUntil) {
    // The preview comes from the worker's model, so this lands a tick later than
    // the status above. Only the notification body depends on it.
    void requestTail(s.key, 8).then((summary) => {
      send(s, 'pty:done', { key: s.key, reason: notify, summary })
    })
  }
}

// Output-flow heuristic for agents without hooks: bytes flowing from an agent
// process = working; ACTIVE_MS of silence = idle. A finished turn only counts
// (and notifies) if the user kicked it off with Enter and it ran a while.
function markActive(s: Session): void {
  if (!s.agentPresent || s.activity.hookDriven) return
  if (s.activity.snapshot().state !== 'working') {
    s.busyStart = Date.now()
    publishActivity(s, s.activity.heuristic('working'))
  }
  if (s.activeTimer) clearTimeout(s.activeTimer)
  s.activeTimer = setTimeout(() => {
    s.activeTimer = null
    const duration = Date.now() - s.busyStart
    const reason = s.activity.heuristic('idle')
    const notify = reason && s.awaitingReply && duration > NOTIFY_MIN_BUSY_MS ? reason : null
    if (!notify) s.activity.clearAttention()
    s.awaitingReply = false
    publishActivity(s, notify)
  }, ACTIVE_MS)
}

// Main-side teardown only. The worker owns the pty and the model and disposes
// its own half when it exits or is told to kill.
function dispose(s: Session): void {
  if (s.poll) clearInterval(s.poll)
  if (s.activeTimer) clearTimeout(s.activeTimer)
  sessions.delete(s.key)
}

export function registerPtyHandlers(): void {
  // Agent hooks arrive on the loopback server tagged with the pane they ran in.
  registerAgentHooks((pane, event) => {
    const s = sessions.get(pane)
    if (!s) return
    if (s.activeTimer) {
      clearTimeout(s.activeTimer)
      s.activeTimer = null
    }
    s.awaitingReply = false
    publishActivity(s, s.activity.hook(event))
  })

  // Clean quit. The PTYs live in the worker now, so the worker is what has to
  // go: left running, its shells/agents would be orphaned when main SIGKILLs
  // itself. Tell it to kill its terminals, then kill it.
  let quitting = false
  app.on('before-quit', () => {
    if (quitting) return
    quitting = true
    worker.shutdown()
    for (const [, s] of sessions) dispose(s)
    sessions.clear()
    // NOTE: the hard SIGKILL backstop is registered LAST in index.ts (after the
    // LSP handlers), not here — killing our own process from this handler would
    // pre-empt lsp.ts's before-quit and orphan the language servers.
  })

  ipcMain.handle(
    'pty:open',
    async (
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
        // Reattach after a reload / remount: the renderer's xterm is fresh, so
        // the next time it says it is visible it gets the model. Telling the
        // worker it is hidden is what arms that snapshot.
        existing.sender = event.sender
        worker.post({ type: 'visible', key, visible: false })
        return { id: key, existed: true }
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
      const cols = opts.cols && opts.cols > 0 ? opts.cols : 80
      const rows = opts.rows && opts.rows > 0 ? opts.rows : 24

      const s: Session = {
        key,
        sender: event.sender,
        cwd: opts.cwd,
        pid: 0,
        cols,
        rows,
        activity: new TerminalActivity(),
        agentPresent: false,
        agentName: null,
        poll: null,
        polling: false,
        activeTimer: null,
        busyStart: 0,
        lastInput: 0,
        lastData: Date.now(),
        startupUntil: Date.now() + 3000,
        awaitingReply: false
      }
      sessions.set(key, s)

      // Spawn is a round trip now: node-pty can fail asynchronously (Windows
      // conpty throws on its own thread), so the worker reports the outcome.
      const spawned = new Promise<{ error?: string }>((resolve) => {
        spawnWaiters.set(key, resolve)
      })
      worker.post({
        type: 'spawn',
        options: {
          key,
          shell,
          args,
          cwd: opts.cwd || os.homedir(),
          env: ptyEnv(opts.configDir, key),
          cols,
          rows
        }
      })
      const result = await spawned
      if (result.error) {
        // A bad shell / cwd shouldn't reject the invoke and break the pane.
        console.error('[riven] pty spawn failed', result.error)
        return { id: key, existed: false, error: result.error }
      }

      // Track whether an agent is the foreground child (tab title, context
      // routing, and the heuristic's gate). Stays in main: it is just a pgrep on
      // a pid, and the activity state machine that consumes it lives here.
      s.poll = setInterval(async () => {
        if (s.polling || !s.pid) return
        // When no agent is present and the terminal has been silent, skip the
        // pgrep/ps probe entirely — an agent can only appear after output flows
        // (its startup banner / the echoed command), which refreshes lastData.
        if (!s.agentPresent && Date.now() - s.lastData > IDLE_POLL_MS) return
        s.polling = true
        const was = s.agentPresent
        const wasName = s.agentName
        const name = await agentRunning(s.pid)
        s.agentPresent = !!name
        s.agentName = name
        s.polling = false
        if (s.agentPresent !== was || name !== wasName)
          send(s, 'pty:agent', { key, agent: s.agentPresent, name })
        // Agent gone → definitely not running, and its hooks are gone with it.
        if (!s.agentPresent && was) {
          if (s.activeTimer) clearTimeout(s.activeTimer)
          s.activeTimer = null
          s.activity.reset()
          publishActivity(s, null)
        }
      }, POLL_MS)

      return { id: key, existed: false }
    }
  )

  ipcMain.on('pty:write', (_event, key: string, data: string) => {
    const s = sessions.get(key)
    if (!s) return
    s.lastInput = Date.now() // mark keystroke time so its echo isn't seen as work
    // A carriage return = the user submitted a line. If an agent without hooks
    // is running, arm the one-shot "reply done" notification.
    if (s.agentPresent && !s.activity.hookDriven && data.includes('\r')) s.awaitingReply = true
    worker.post({ type: 'write', key, data })
  })

  // Cumulative ack for the current epoch (chars the renderer has parsed). The
  // worker owns the water marks, so this is a straight relay.
  ipcMain.on('pty:ack', (_event, key: string, epoch: number, processed: number) => {
    if (!sessions.has(key)) return
    worker.post({ type: 'ack', key, epoch, processed })
  })

  // The renderer says whether a live, sized xterm wants this terminal's bytes.
  // Hidden: the worker stops delivering and stops counting — a hidden pane must
  // never be the reason a shell blocks on write, and its model keeps ingesting.
  // Visible: the worker restores from the model if anything was dropped.
  ipcMain.on('pty:visible', (_event, key: string, visible: boolean) => {
    if (!sessions.has(key)) return
    worker.post({ type: 'visible', key, visible })
  })

  // The user looked at the terminal: its attention flag is delivered.
  ipcMain.on('pty:seen', (_event, key: string) => {
    const s = sessions.get(key)
    if (s && s.activity.clearAttention()) publishActivity(s, null)
  })

  ipcMain.on('pty:resize', (_event, key: string, cols: number, rows: number) => {
    const s = sessions.get(key)
    if (!s || !(cols > 0 && rows > 0)) return
    // Same size = no SIGWINCH. A refit after a font load or a tab switch must
    // not make every TUI redraw itself. The worker checks this too (it owns the
    // model + pty); tracking it here keeps the pointless message off the wire.
    if (cols === s.cols && rows === s.rows) return
    s.cols = cols
    s.rows = rows
    worker.post({ type: 'resize', key, cols, rows })
  })

  ipcMain.on('pty:kill', (_event, key: string) => {
    const s = sessions.get(key)
    if (!s) return
    worker.post({ type: 'kill', key })
    dispose(s)
  })
}
