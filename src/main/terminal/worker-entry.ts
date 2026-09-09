// Terminal worker: runs in an Electron `utilityProcess`, owns every PTY and the
// authoritative terminal MODEL.
//
// Why a separate process at all: the model parses every byte a PTY produces, and
// main's event loop is shared with the chat CLI stream, the language servers,
// the MCP server and git. A terminal flood used to compete with all of that, and
// the model's scrollback grew inside main's heap. Here it is isolated: main only
// routes, so main's RSS no longer tracks terminal output.
//
// This file must not import anything from main's modules — it is a second entry
// point (see electron.vite.config.ts) and only shares the protocol types.

import * as pty from 'node-pty'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { ITerminalAddon } from '@xterm/headless'
import { OutputCoalescer, realTimers } from './coalescer'
import {
  HIDDEN_ACTIVITY_PING_MS,
  type MainToWorker,
  type WorkerSpawnOptions,
  type WorkerToMain
} from './worker-protocol'

// Model scrollback: what a reattach/reveal can restore. The renderer keeps its
// own (larger) scrollback for what it has already seen.
const MODEL_SCROLLBACK = 2000
const SNAPSHOT_SCROLLBACK = 2000
// Flow-control water marks (chars in flight to the renderer, per terminal).
// xterm parses ~100MB/s, so 2MB is ~20ms of backlog — enough to stream, small
// enough that a flood cannot balloon this process. Wide hysteresis so a draining
// queue does not flap pause/resume on every batch.
const HIGH_WATER = 2 * 1024 * 1024
const LOW_WATER = 256 * 1024

interface WorkerSession {
  key: string
  proc: pty.IPty
  term: HeadlessTerminal
  serialize: SerializeAddon
  coalescer: OutputCoalescer
  // Chunks handed to the model (assigned on write) vs. chunks it has parsed
  // (assigned in the write callback, in order). A snapshot reflects `parsed`.
  written: number
  parsed: number
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
  lastActivityPing: number
}

const sessions = new Map<string, WorkerSession>()

let ipcClosing = false

function send(msg: WorkerToMain): void {
  if (ipcClosing) return
  try {
    process.parentPort.postMessage(msg)
  } catch {
    // Parent is gone; nothing left to talk to.
    ipcClosing = true
  }
}

// node-pty completes a Windows conpty spawn asynchronously on a separate conout
// thread. When that spawn fails (bad cwd, missing shell) it throws there, where
// the call site cannot catch it — unhandled, it would take down this worker and
// sever every OTHER terminal with it. Same reason paseo keeps its worker alive
// (terminal-worker-process.ts:34).
let inFlightSpawnKey: string | null = null
process.on('uncaughtException', (error) => {
  console.error('[terminal-worker] uncaught exception (kept alive):', error)
  if (inFlightSpawnKey) {
    const key = inFlightSpawnKey
    inFlightSpawnKey = null
    send({ type: 'spawnError', key, error: error instanceof Error ? error.message : String(error) })
  }
})

function resumeIfPaused(s: WorkerSession): void {
  if (!s.paused) return
  s.paused = false
  try {
    s.proc.resume()
  } catch {
    /* resume unsupported — best effort */
  }
}

// The last few content lines of the model. Reading the parsed grid beats
// scraping ANSI out of the raw stream: box drawing and cursor games are already
// resolved.
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
// coalescer still holds is flushed FIRST so it precedes the snapshot on the wire
// (the renderer drops it by revision anyway) — order here is what keeps dedup
// honest.
function sendSnapshot(s: WorkerSession): void {
  s.coalescer.flush()
  s.epoch += 1
  s.sentChars = 0
  s.ackedChars = 0
  resumeIfPaused(s)
  let data = ''
  try {
    data = s.serialize.serialize({ scrollback: SNAPSHOT_SCROLLBACK })
  } catch (e) {
    console.error('[terminal-worker] serialize failed', e)
  }
  s.needsSnapshot = false
  send({
    type: 'snapshot',
    key: s.key,
    data,
    rev: s.parsed,
    epoch: s.epoch,
    cols: s.cols,
    rows: s.rows
  })
  s.coalescer.markFlushed()
}

function disposeSession(s: WorkerSession): void {
  s.coalescer.dispose()
  try {
    s.term.dispose()
  } catch {
    /* already disposed */
  }
  sessions.delete(s.key)
}

function spawnSession(opts: WorkerSpawnOptions): void {
  const { key } = opts
  if (sessions.has(key)) return

  let proc: pty.IPty
  inFlightSpawnKey = key
  try {
    proc = pty.spawn(opts.shell, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env
    })
  } catch (e) {
    inFlightSpawnKey = null
    send({ type: 'spawnError', key, error: e instanceof Error ? e.message : String(e) })
    return
  }
  inFlightSpawnKey = null

  const term = new HeadlessTerminal({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: MODEL_SCROLLBACK,
    allowProposedApi: true
  })
  const serialize = new SerializeAddon()
  term.loadAddon(serialize as unknown as ITerminalAddon)

  const s: WorkerSession = {
    key,
    proc,
    term,
    serialize,
    coalescer: null as unknown as OutputCoalescer,
    written: 0,
    parsed: 0,
    visible: false,
    needsSnapshot: false,
    epoch: 0,
    sentChars: 0,
    ackedChars: 0,
    paused: false,
    cols: opts.cols,
    rows: opts.rows,
    lastActivityPing: 0
  }

  s.coalescer = new OutputCoalescer(realTimers, ({ data, rev }) => {
    if (!s.visible) {
      // Nobody is looking: the model has it, and the reveal restores from the
      // model. Dropping here is what keeps a background agent free. Main still
      // gets a data-less ping so its output heuristic keeps working.
      s.needsSnapshot = true
      const now = Date.now()
      if (now - s.lastActivityPing >= HIDDEN_ACTIVITY_PING_MS) {
        s.lastActivityPing = now
        send({ type: 'outputActivity', key })
      }
      return
    }
    s.sentChars += data.length
    send({ type: 'output', key, data, rev, epoch: s.epoch })
    // Above the high-water mark of un-acked data: pause the source so this
    // process's memory can't grow unbounded while the renderer catches up.
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
  // terminator — the parser knows the difference) and title changes. Both flush
  // first so they cannot overtake output already sitting in the coalescer.
  term.onBell(() => {
    s.coalescer.flush()
    send({ type: 'bell', key })
  })
  term.onTitleChange((title) => {
    s.coalescer.flush()
    send({ type: 'title', key, title })
  })

  proc.onData((data) => {
    // Revision is assigned on write and confirmed (in order) on parse: a
    // snapshot taken between the two reflects exactly the confirmed ones, so a
    // chunk delivered with a higher revision is never inside it.
    const rev = ++s.written
    term.write(data, () => {
      s.parsed = rev
    })
    s.coalescer.handle(data, rev)
  })

  proc.onExit(({ exitCode }) => {
    s.coalescer.flush()
    send({ type: 'exit', key, exitCode })
    disposeSession(s)
  })

  send({ type: 'spawned', key, pid: proc.pid })
}

function killSession(s: WorkerSession): void {
  try {
    s.proc.kill()
  } catch {
    /* already dead */
  }
  disposeSession(s)
}

function handle(msg: MainToWorker): void {
  switch (msg.type) {
    case 'spawn':
      spawnSession(msg.options)
      return
    case 'write': {
      const s = sessions.get(msg.key)
      if (!s) return
      try {
        s.proc.write(msg.data)
      } catch {
        /* pty may have exited between the renderer's keystroke and here */
      }
      return
    }
    case 'resize': {
      const s = sessions.get(msg.key)
      if (!s || !(msg.cols > 0 && msg.rows > 0)) return
      // Same size = no SIGWINCH. A refit after a font load or a tab switch must
      // not make every TUI redraw itself.
      if (msg.cols === s.cols && msg.rows === s.rows) return
      s.cols = msg.cols
      s.rows = msg.rows
      try {
        s.term.resize(msg.cols, msg.rows)
        s.proc.resize(msg.cols, msg.rows)
      } catch {
        /* pty may have exited */
      }
      return
    }
    case 'kill': {
      const s = sessions.get(msg.key)
      if (s) killSession(s)
      return
    }
    case 'visible': {
      const s = sessions.get(msg.key)
      if (!s) return
      s.visible = msg.visible
      if (!msg.visible) {
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
      return
    }
    case 'ack': {
      const s = sessions.get(msg.key)
      if (!s || msg.epoch !== s.epoch) return
      s.ackedChars = Math.min(s.sentChars, Math.max(s.ackedChars, msg.processed))
      if (s.paused && s.sentChars - s.ackedChars <= LOW_WATER) resumeIfPaused(s)
      return
    }
    case 'tail': {
      const s = sessions.get(msg.key)
      send({
        type: 'tailResult',
        requestId: msg.requestId,
        text: s ? bufferTail(s.term, msg.lines) : ''
      })
      return
    }
    case 'shutdown': {
      for (const [, s] of sessions) killSession(s)
      sessions.clear()
      return
    }
  }
}

process.parentPort.on('message', (e) => {
  try {
    handle(e.data as MainToWorker)
  } catch (err) {
    console.error('[terminal-worker] message handler failed', err)
  }
})
