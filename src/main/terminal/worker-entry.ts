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
import { OutputCoalescer, realTimers } from './coalescer'
import { loadVtModel, VtModel } from './vt-model'
import {
  HIDDEN_ACTIVITY_PING_MS,
  type MainToWorker,
  type WorkerSpawnOptions,
  type WorkerToMain
} from './worker-protocol'

// Model scrollback: what a reattach/reveal can restore. The renderer keeps its
// own (larger) scrollback for what it has already seen.
const MODEL_SCROLLBACK = 2000
// Flow-control water marks (chars in flight to the renderer, per terminal).
// The renderer parses ~100MB/s, so 2MB is ~20ms of backlog, enough to stream, small
// enough that a flood cannot balloon this process. Wide hysteresis so a draining
// queue does not flap pause/resume on every batch.
const HIGH_WATER = 2 * 1024 * 1024
const LOW_WATER = 256 * 1024

interface WorkerSession {
  key: string
  proc: pty.IPty
  model: VtModel
  coalescer: OutputCoalescer
  // Chunks the model has parsed. Writes are synchronous, so a snapshot always
  // reflects exactly this revision.
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
  let data: Uint8Array = new Uint8Array(0)
  try {
    data = s.model.snapshot()
  } catch (e) {
    console.error('[terminal-worker] snapshot failed', e)
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
  s.model.dispose()
  sessions.delete(s.key)
}

function spawnSession(opts: WorkerSpawnOptions): void {
  const { key } = opts
  if (sessions.has(key)) return

  // The model reports what the parser resolved: a real BEL (never an OSC
  // terminator, the parser knows the difference) and title changes. Both flush
  // first so they cannot overtake output already sitting in the coalescer.
  // Built before the pty so a model failure cannot leak a running shell.
  let model: VtModel
  try {
    model = new VtModel(opts.cols, opts.rows, MODEL_SCROLLBACK, {
      bell: () => {
        s.coalescer.flush()
        send({ type: 'bell', key })
      },
      title: (title) => {
        s.coalescer.flush()
        send({ type: 'title', key, title })
      }
    })
  } catch (e) {
    send({ type: 'spawnError', key, error: e instanceof Error ? e.message : String(e) })
    return
  }

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
    model.dispose()
    send({ type: 'spawnError', key, error: e instanceof Error ? e.message : String(e) })
    return
  }
  inFlightSpawnKey = null

  const s: WorkerSession = {
    key,
    proc,
    model,
    coalescer: null as unknown as OutputCoalescer,
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

  proc.onData((data) => {
    // Queue the chunk before parsing it, so a bell/title it contains is sent
    // after the chunk's own output, never ahead of it.
    const rev = s.parsed + 1
    s.coalescer.handle(data, rev)
    s.model.write(data)
    s.parsed = rev
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
        s.model.resize(msg.cols, msg.rows)
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
        text: s ? s.model.tail(msg.lines) : ''
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

function safeHandle(msg: MainToWorker): void {
  try {
    handle(msg)
  } catch (err) {
    console.error('[terminal-worker] message handler failed', err)
  }
}

// The wasm model loads asynchronously (a few ms). Messages that arrive first
// wait, in order: a spawn cannot run without its model.
let early: MainToWorker[] | null = []
loadVtModel().then(
  () => {
    const q = early ?? []
    early = null
    for (const m of q) safeHandle(m)
  },
  (err) => {
    console.error('[terminal-worker] ghostty-vt failed to load', err)
    for (const m of early ?? []) {
      if (m.type === 'spawn') send({ type: 'spawnError', key: m.options.key, error: 'terminal engine failed to load' })
    }
    early = null
  }
)

process.parentPort.on('message', (e) => {
  const msg = e.data as MainToWorker
  if (early) early.push(msg)
  else safeHandle(msg)
})
