import { app, ipcMain, WebContents } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as pty from 'node-pty'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { ITerminalAddon } from '@xterm/headless'
import { mcpConfigJson, mcpSystemPrompt, implementedToolNames } from './mcpServer'
import { resolveBin } from './shellPath'
import { OutputCoalescer, realTimers } from './terminal/coalescer'
import { TerminalActivity, type AttentionReason } from './terminal/activity'
import { hookEnv, registerAgentHooks } from './agentHooks'

const pexec = promisify(execFile)

// PTY sessions live in the MAIN process, keyed by a stable sessionKey, and are
// NOT tied to the renderer lifetime (survive reloads; killed only on explicit
// kill).
//
// Main also owns the terminal MODEL: a headless xterm ingests every byte the
// PTY produces, so the authoritative screen + scrollback exist here whether or
// not a renderer is looking. That is what makes hidden panes free (their bytes
// are simply not delivered), reattach exact (the renderer gets a snapshot of the
// model, not a stale copy it once uploaded), and reconnection race-free: every
// delivered chunk carries a model revision, a snapshot carries the revision it
// reflects, and the renderer drops any chunk at or below it. Same design as
// paseo's worker-owned headless terminal and orca's main-owned model.

interface Session {
  key: string
  proc: pty.IPty
  sender: WebContents
  cwd: string
  term: HeadlessTerminal
  serialize: SerializeAddon
  // Chunks handed to the model (assigned on write) vs. chunks it has parsed
  // (assigned in the write callback, in order). A snapshot reflects `parsed`.
  written: number
  parsed: number
  coalescer: OutputCoalescer
  // Renderer has a live, sized xterm that wants bytes. While false nothing is
  // delivered; the first flush dropped sets needsSnapshot so the next reveal
  // restores from the model.
  visible: boolean
  needsSnapshot: boolean
  // Flow control, TCP-style: the renderer reports the cumulative chars it has
  // parsed for the current epoch; in-flight = sent - acked. A lost ack cannot
  // become permanent debt, and a snapshot starts a new epoch so stale acks are
  // simply ignored.
  epoch: number
  sentChars: number
  ackedChars: number
  paused: boolean
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
// Model scrollback: what a reattach/reveal can restore. The renderer keeps its
// own (larger) scrollback for what it has already seen.
const MODEL_SCROLLBACK = 2000
const SNAPSHOT_SCROLLBACK = 2000
// Flow-control water marks (chars in flight to the renderer, per terminal).
// xterm parses ~100MB/s, so 2MB is ~20ms of backlog — enough to stream, small
// enough that a flood cannot balloon main. Wide hysteresis so a draining queue
// does not flap pause/resume on every batch.
const HIGH_WATER = 2 * 1024 * 1024
const LOW_WATER = 256 * 1024
const POLL_MS = 1500
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

function resumeIfPaused(s: Session): void {
  if (!s.paused) return
  s.paused = false
  try {
    s.proc.resume()
  } catch {
    /* resume unsupported — best effort */
  }
}

// The last few content lines of the model, for a notification preview. Reading
// the parsed grid beats scraping ANSI out of the raw stream: box drawing and
// cursor games are already resolved.
function bufferTail(term: HeadlessTerminal, lines: number): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = buf.length - 1; y >= 0 && out.length < lines; y--) {
    const line = buf.getLine(y)?.translateToString(true).trim()
    if (line) out.unshift(line.replace(/[─-╿▀-▟]/g, '').replace(/\s+/g, ' ').trim())
  }
  const tail = out.filter(Boolean).join('\n')
  return tail.length > 240 ? '…' + tail.slice(-240) : tail
}

// Deliver a model snapshot and start a fresh flow-control epoch. Anything the
// coalescer still holds is flushed first so it precedes the snapshot on the
// wire (the renderer drops it by revision anyway).
function sendSnapshot(s: Session): void {
  s.coalescer.flush()
  s.epoch += 1
  s.sentChars = 0
  s.ackedChars = 0
  resumeIfPaused(s)
  let data = ''
  try {
    data = s.serialize.serialize({ scrollback: SNAPSHOT_SCROLLBACK })
  } catch (e) {
    console.error('[pty] serialize failed', e)
  }
  s.needsSnapshot = false
  send(s, `pty:snapshot:${s.key}`, {
    data,
    rev: s.parsed,
    epoch: s.epoch,
    cols: s.cols,
    rows: s.rows
  })
  s.coalescer.markFlushed()
}

function publishActivity(s: Session, notify: AttentionReason): void {
  const snap = s.activity.snapshot()
  send(s, 'pty:status', { key: s.key, busy: snap.state === 'working', attention: snap.attention })
  if (notify && Date.now() >= s.startupUntil) {
    send(s, 'pty:done', { key: s.key, reason: notify, summary: bufferTail(s.term, 8) })
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

function dispose(s: Session): void {
  if (s.poll) clearInterval(s.poll)
  if (s.activeTimer) clearTimeout(s.activeTimer)
  s.coalescer.dispose()
  try {
    s.term.dispose()
  } catch {
    /* already disposed */
  }
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
      try {
        s.proc.kill()
      } catch {
        /* already exited */
      }
      dispose(s)
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
        // Reattach after a reload / remount: the renderer's xterm is fresh, so
        // the next time it says it is visible it gets the model.
        existing.sender = event.sender
        existing.visible = false
        existing.needsSnapshot = true
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

      let proc: pty.IPty
      try {
        proc = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: opts.cwd || os.homedir(),
          env: ptyEnv(opts.configDir, key)
        })
      } catch (e) {
        // A bad shell / cwd shouldn't reject the invoke and break the pane.
        console.error('[riven] pty spawn failed', e)
        return { id: key, existed: false, error: e instanceof Error ? e.message : String(e) }
      }

      const term = new HeadlessTerminal({
        cols,
        rows,
        scrollback: MODEL_SCROLLBACK,
        allowProposedApi: true
      })
      const serialize = new SerializeAddon()
      term.loadAddon(serialize as unknown as ITerminalAddon)

      const s: Session = {
        key,
        proc,
        sender: event.sender,
        cwd: opts.cwd,
        term,
        serialize,
        written: 0,
        parsed: 0,
        coalescer: null as unknown as OutputCoalescer,
        visible: false,
        needsSnapshot: false,
        epoch: 0,
        sentChars: 0,
        ackedChars: 0,
        paused: false,
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
      s.coalescer = new OutputCoalescer(realTimers, ({ data, rev }) => {
        if (!s.visible) {
          // Nobody is looking: the model has it, and the reveal restores from
          // the model. Dropping here is what keeps a background agent free.
          s.needsSnapshot = true
          return
        }
        s.sentChars += data.length
        send(s, `pty:data:${key}`, { data, rev, epoch: s.epoch })
        // Above the high-water mark of un-acked data: pause the source so main
        // memory can't grow unbounded while the renderer catches up.
        if (!s.paused && s.sentChars - s.ackedChars >= HIGH_WATER) {
          s.paused = true
          try {
            s.proc.pause()
          } catch {
            /* pause unsupported — best effort */
          }
        }
      })
      sessions.set(key, s)

      // The model reports what the parser resolved: a real BEL (never an OSC
      // terminator — the parser knows the difference) and title changes.
      term.onBell(() => send(s, 'pty:bell', { key }))
      term.onTitleChange((title) => send(s, 'pty:title', { key, title }))

      proc.onData((data) => {
        s.lastData = Date.now()
        // Revision is assigned on write and confirmed (in order) on parse: a
        // snapshot taken between the two reflects exactly the confirmed ones,
        // so a chunk delivered with a higher revision is never inside it.
        const rev = ++s.written
        term.write(data, () => {
          s.parsed = rev
        })
        s.coalescer.handle(data, rev)
        // Ignore output that's just an echo of the user's own keystrokes; only
        // agent-generated output (not right after typing) counts as "working".
        if (Date.now() - s.lastInput > INPUT_ECHO_MS) markActive(s)
      })

      // Track whether an agent is the foreground child (tab title, context
      // routing, and the heuristic's gate).
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

      proc.onExit(({ exitCode }) => {
        s.coalescer.flush()
        send(s, `pty:exit:${key}`, exitCode)
        dispose(s)
      })

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
    s.proc.write(data)
  })

  // Cumulative ack for the current epoch (chars the renderer has parsed).
  ipcMain.on('pty:ack', (_event, key: string, epoch: number, processed: number) => {
    const s = sessions.get(key)
    if (!s || epoch !== s.epoch) return
    s.ackedChars = Math.min(s.sentChars, Math.max(s.ackedChars, processed))
    if (s.paused && s.sentChars - s.ackedChars <= LOW_WATER) resumeIfPaused(s)
  })

  // The renderer says whether a live, sized xterm wants this terminal's bytes.
  // Hidden: stop delivering and stop counting — a hidden pane must never be
  // the reason a shell blocks on write. Visible: restore from the model if
  // anything was dropped in the meantime.
  ipcMain.on('pty:visible', (_event, key: string, visible: boolean) => {
    const s = sessions.get(key)
    if (!s) return
    s.visible = visible
    if (!visible) {
      s.epoch += 1
      s.sentChars = 0
      s.ackedChars = 0
      resumeIfPaused(s)
      // Chunks already on the wire when the renderer went hidden are lost to
      // it (it discards its queue), so the reveal must come from the model.
      s.needsSnapshot = true
      return
    }
    if (s.needsSnapshot) sendSnapshot(s)
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
    // not make every TUI redraw itself.
    if (cols === s.cols && rows === s.rows) return
    s.cols = cols
    s.rows = rows
    try {
      s.term.resize(cols, rows)
      s.proc.resize(cols, rows)
    } catch {
      /* pty may have exited */
    }
  })

  ipcMain.on('pty:kill', (_event, key: string) => {
    const s = sessions.get(key)
    if (!s) return
    try {
      s.proc.kill()
    } catch {
      /* already dead */
    }
    dispose(s)
  })
}
