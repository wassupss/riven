// The line to the Tauri shell (src-tauri). The Rust process starts this Node
// process and hands it a loopback port + token; everything Electron's main
// process did natively (windows, menus, dialogs, the tray, the screen) is a
// command sent over that line.
//
// Two connections:
//   async  - commands that return a promise, plus the events Rust pushes
//            (window moved/closed, menu clicks, before-quit, ...).
//   sync   - held by a worker thread so the main thread can block on an answer.
//            Electron's window getters (getBounds, isVisible, ...) and
//            screen.getCursorScreenPoint are synchronous and the code calling
//            them (the pet's 60Hz drag loop) relies on that.
//
// Wire format: newline-delimited JSON. The first line on each connection is
// {hello: token, role}. Requests {id, cmd, args} -> replies {id, ok, val|err}.
// Events {ev, ...}.
import * as net from 'net'
import { MessageChannel, receiveMessageOnPort, Worker } from 'worker_threads'

const PORT = Number(process.env.RIVEN_TAURI_CTL_PORT || 0)
const TOKEN = process.env.RIVEN_TAURI_CTL_TOKEN || ''

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
type EventMsg = { ev: string; [k: string]: unknown }

let sock: net.Socket | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const queue: string[] = []
const listeners: Array<(m: EventMsg) => void> = []
let connected = false

function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line) onLine(line)
    }
  }
}

export function connect(): void {
  if (sock) return
  if (!PORT) throw new Error('riven-tauri: RIVEN_TAURI_CTL_PORT is not set (run through the Tauri shell)')
  sock = net.connect({ host: '127.0.0.1', port: PORT })
  sock.setNoDelay(true)
  sock.on('connect', () => {
    connected = true
    sock!.write(JSON.stringify({ hello: TOKEN, role: 'async' }) + '\n')
    for (const q of queue.splice(0)) sock!.write(q)
  })
  sock.on(
    'data',
    lines((line) => {
      let m: { id?: number; ok?: boolean; val?: unknown; err?: string; ev?: string }
      try {
        m = JSON.parse(line)
      } catch {
        return
      }
      if (m.ev) {
        for (const l of listeners) {
          try {
            l(m as EventMsg)
          } catch (e) {
            console.error('[tauri] event handler failed', e)
          }
        }
        return
      }
      const p = m.id != null ? pending.get(m.id) : undefined
      if (!p) return
      pending.delete(m.id!)
      if (m.ok) p.resolve(m.val)
      else p.reject(new Error(m.err || 'tauri command failed'))
    })
  )
  // The shell is gone: nothing can show a window any more.
  const gone = (): void => {
    console.error('[tauri] control connection closed; exiting')
    process.exit(0)
  }
  sock.on('close', gone)
  sock.on('error', gone)
}

export function call<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  connect()
  const id = nextId++
  const line = JSON.stringify({ id, cmd, args }) + '\n'
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    if (connected) sock!.write(line)
    else queue.push(line)
  })
}

// Fire and forget (errors are logged, not thrown).
export function fire(cmd: string, args: Record<string, unknown> = {}): void {
  call(cmd, args).catch((e) => console.error(`[tauri] ${cmd} failed:`, e.message))
}

export function onEvent(fn: (m: EventMsg) => void): void {
  listeners.push(fn)
}

// ---- synchronous calls ------------------------------------------------------

const WORKER_SRC = `
const net = require('net')
const { workerData, parentPort } = require('worker_threads')
const { port, token } = workerData
let buf = ''
let current = null
const s = net.connect({ host: '127.0.0.1', port })
s.setNoDelay(true)
const ready = new Promise((r) => s.on('connect', () => { s.write(JSON.stringify({ hello: token, role: 'sync' }) + '\\n'); r() }))
s.on('data', (c) => {
  buf += c.toString('utf8')
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line || !current) continue
    let m; try { m = JSON.parse(line) } catch (e) { continue }
    // A late answer to a call the main thread already gave up on.
    if (m.id !== current.id) continue
    const { reply, flag } = current; current = null
    reply.postMessage(m)
    Atomics.store(flag, 0, 1); Atomics.notify(flag, 0)
  }
})
const fail = (err) => {
  if (current) { const { reply, flag } = current; current = null; reply.postMessage({ ok: false, err: String(err) }); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0) }
}
s.on('error', fail); s.on('close', () => fail('closed'))
parentPort.on('message', async ({ id, cmd, args, reply, sab }) => {
  await ready
  current = { id, reply, flag: new Int32Array(sab) }
  s.write(JSON.stringify({ id, cmd, args }) + '\\n')
})
`

let worker: Worker | null = null

// timeoutMs: Infinity for things a person answers (a modal message box).
export function callSync<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 5000
): T {
  if (!worker) {
    worker = new Worker(WORKER_SRC, { eval: true, workerData: { port: PORT, token: TOKEN } })
    worker.unref()
  }
  const sab = new SharedArrayBuffer(4)
  const flag = new Int32Array(sab)
  const { port1, port2 } = new MessageChannel()
  worker.postMessage({ id: nextId++, cmd, args, reply: port2, sab }, [port2])
  // 5s default: a blocked main thread is worse than a wrong answer.
  const r = Atomics.wait(flag, 0, 0, timeoutMs)
  const got = receiveMessageOnPort(port1)
  port1.close()
  if (r === 'timed-out' || !got) throw new Error(`tauri ${cmd}: no answer`)
  const m = got.message as { ok: boolean; val?: T; err?: string }
  if (!m.ok) throw new Error(m.err || `tauri ${cmd} failed`)
  return m.val as T
}
