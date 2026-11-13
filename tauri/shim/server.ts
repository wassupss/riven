// The renderer's side of the house. Electron loaded pages from file:// and spoke
// IPC through Chromium; here a loopback HTTP server serves the same renderer
// build and a WebSocket carries the same IPC channels.
//
//   GET  /<file>               the renderer build; HTML gets the token + preload
//   GET  /__riven/preload.js   the preload bundle (src/preload over the shim)
//   WS   /__riven/ws           ipcRenderer.invoke/send <-> ipcMain, webContents.send
//   POST /__riven/sync         ipcRenderer.sendSync (a sync XHR from the page)
//   GET  /__riven/media/<p>    the riven-media handler (media.ts), same origin
//
// Every request carries the token the HTML was given; the Host header must be
// ours (no DNS rebinding) and a socket's Origin must be ours.
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import type { Duplex } from 'stream'
import { call } from './rust'
import { decode, encode } from './codec'
import { ipcMain } from './ipc'
import { RUST_SYNC } from './rust-owned'
import { rendererDir, serverOrigin, setServerOrigin } from './server-info'
// A cycle (electron-main imports this file), but only functions, used at request time.
import { mimeOf, protocolHandler, screen } from './electron-main'
import { windowByLabel, type Sock, type WebContents } from './windows'
import { runningChatCount } from './moved/agentChat'
import { runningTerminalAgentCount } from './moved/pty'

const TOKEN = crypto.randomBytes(24).toString('hex')
const PRELOAD = path.join(__dirname, '../preload/index.js')

let readyP: Promise<void> | null = null
export function serverReady(): Promise<void> {
  if (!readyP) readyP = start()
  return readyP
}

function start(): Promise<void> {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[tauri] request failed', req.url, e)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.on('upgrade', upgrade)
  // A fixed port first: WebKit keys localStorage by origin, so a new port each
  // launch would forget every renderer setting. Any free port if it is taken.
  const preferred = Number(process.env.RIVEN_TAURI_HTTP_PORT || 47391)
  return new Promise((resolve) => {
    const ready = (): void => {
      const port = (server.address() as { port: number }).port
      setServerOrigin(`http://127.0.0.1:${port}`)
      void call('app.setOrigin', { origin: serverOrigin() }).then(() => resolve())
    }
    server.once('error', () => server.listen(0, '127.0.0.1', ready))
    server.listen(preferred, '127.0.0.1', ready)
  })
}

function hostOk(req: http.IncomingMessage): boolean {
  return req.headers.host === serverOrigin().slice('http://'.length)
}
function tokenOk(u: URL, req: http.IncomingMessage): boolean {
  const t = u.searchParams.get('t') ?? req.headers['x-riven-token']
  return typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN))
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!hostOk(req)) {
    res.writeHead(403).end()
    return
  }
  const u = new URL(req.url ?? '/', serverOrigin())

  if (u.pathname === '/__riven/preload.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    fs.createReadStream(PRELOAD).pipe(res)
    return
  }
  if (u.pathname === '/__riven/sync') {
    if (req.method !== 'POST' || !tokenOk(u, req)) return void res.writeHead(403).end()
    const body = await readBody(req)
    const { label, ch, args } = decode(body.toString('utf8')) as { label: string; ch: string; args: unknown[] }
    const wc = windowByLabel(label)?.webContents
    if (!wc) return void res.writeHead(404).end()
    // The preload's drop hook: file paths off the drag pasteboard.
    // A sendSync channel Rust owns: relay it and wait (the page is blocked on us).
    const v =
      ch === '__riven:dragPaths'
        ? await call('drag.paths').catch(() => [])
        : ch in RUST_SYNC
          ? await call('ipc.sync', { ch, args: args ?? [] }).catch((e) => {
              console.error(`[tauri] ${ch} failed:`, e)
              return false
            })
          : ipcMain._send(wc, ch, args ?? []).returnValue
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(encode({ v }))
    return
  }
  if (u.pathname.startsWith('/__riven/media/')) {
    if (!tokenOk(u, req)) return void res.writeHead(403).end()
    await media(u, req, res)
    return
  }
  if (u.pathname === '/__riven/test' && TEST_KEY) return void (await testHook(u, req, res))
  if (u.pathname.startsWith('/__riven/')) return void res.writeHead(404).end()

  await serveStatic(u, req, res)
}

// Dev-only driving hook, off unless RIVEN_TAURI_TEST_KEY is set when launching:
//   POST /__riven/test?k=KEY&w=w1&op=eval   body = JS, answers JSON {ok, val|err}
//   GET  /__riven/test?k=KEY&w=w1&op=shot   answers the window (or a pop-* popout) as PNG
//   GET  /__riven/test?k=KEY&w=w1&op=front  shows and focuses the window
//   GET  /__riven/test?k=KEY&w=LABEL&op=close  asks any window to close, as its close button does
//   GET  /__riven/test?k=KEY&op=busy    the counts the quit confirmation would show {chat, terminal}
//   POST /__riven/test?k=KEY&w=w1&op=wv  body = one JS expression, run by WKWebView itself
//   GET  /__riven/test?k=KEY&op=displays  what Node's screen module sees {count, primaryWorkArea}
const TEST_KEY = process.env.RIVEN_TAURI_TEST_KEY ?? ''
async function testHook(u: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const k = u.searchParams.get('k') ?? ''
  if (k.length !== TEST_KEY.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(TEST_KEY)))
    return void res.writeHead(403).end()
  const label = u.searchParams.get('w') ?? ''
  if (u.searchParams.get('op') === 'displays') {
    // What Node's screen module sees (the pet and window placement read it).
    const all = screen.getAllDisplays()
    const v = { count: all.length, primaryWorkArea: screen.getPrimaryDisplay()?.workArea ?? null }
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v))
  }
  if (u.searchParams.get('op') === 'busy') {
    const busy = { chat: runningChatCount(), terminal: runningTerminalAgentCount() }
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(busy))
  }
  if (u.searchParams.get('op') === 'close') {
    await call('win.close', { label }).catch(() => {})
    return void res.writeHead(204).end()
  }
  if (u.searchParams.get('op') === 'shot' && label.startsWith('pop-')) {
    const b64 = await call<string>('win.capture', { label }).catch(() => '')
    return void res.writeHead(b64 ? 200 : 404, { 'content-type': 'image/png' }).end(Buffer.from(b64, 'base64'))
  }
  const win = windowByLabel(u.searchParams.get('w') ?? 'w1')
  const wc = win?.webContents
  if (!win || !wc) return void res.writeHead(404).end()
  // op=wv: the same eval run by WKWebView itself (callAsyncJavaScript), not
  // over the page's socket. A background test window WebKit sees as occluded
  // can leave socket messages unanswered for a long time; this always runs.
  if (u.searchParams.get('op') === 'wv') {
    try {
      const code = (await readBody(req)).toString('utf8')
      const text = await call<string>('wv.exec', { label: label || 'w1', code, expr: true })
      const r = JSON.parse(text) as { v?: unknown; u?: 1 }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, val: 'u' in r ? undefined : r.v }))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, err: String(e) }))
    }
    return
  }
  try {
    if (u.searchParams.get('op') === 'front') {
      win.show()
      win.focus()
      res.writeHead(204).end()
    } else if (u.searchParams.get('op') === 'shot') {
      const png = (await wc.capturePage()).toPNG()
      res.writeHead(200, { 'content-type': 'image/png' }).end(png)
    } else {
      const val = await wc.executeJavaScript((await readBody(req)).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, val }))
    }
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, err: String(e) }))
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function media(u: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const fn = protocolHandler('riven-media')
  if (!fn) return void res.writeHead(404).end()
  const headers = new Headers()
  if (typeof req.headers.range === 'string') headers.set('range', req.headers.range)
  const enc = u.pathname.slice('/__riven/media/'.length)
  const r = await fn(new Request(`riven-media://local/${enc}`, { method: req.method, headers }))
  const out: Record<string, string> = {}
  r.headers.forEach((v, k) => (out[k] = v))
  res.writeHead(r.status, out)
  if (!r.body || req.method === 'HEAD') return void res.end()
  const reader = r.body.getReader()
  res.on('close', () => void reader.cancel().catch(() => {}))
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!res.write(value)) await new Promise((ok) => res.once('drain', ok))
  }
  res.end()
}

const HEAD_INJECT = (): string =>
  `<script>window.__RIVEN_T__=${JSON.stringify(TOKEN)}</script><script src="/__riven/preload.js"></script>`

async function serveStatic(u: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const root = rendererDir()
  let rel = decodeURIComponent(u.pathname)
  if (rel === '/') rel = '/index.html'
  const file = path.join(root, rel)
  if (file !== root && !file.startsWith(root + path.sep)) return void res.writeHead(403).end()
  let st: fs.Stats
  try {
    st = await fs.promises.stat(file)
  } catch {
    return void res.writeHead(404).end()
  }
  if (!st.isFile()) return void res.writeHead(404).end()
  const type = mimeOf(file)
  if (type.startsWith('text/html')) {
    // The preload has to run before the page's own scripts, as Electron's did.
    // popout.html is only a host for DOM dockview moves in from the opener; a
    // preload there would open a second bridge for nothing.
    let html = await fs.promises.readFile(file, 'utf8')
    if (rel !== '/popout.html') html = html.replace(/<head>/i, (h) => h + HEAD_INJECT())
    // Tauri's invoke fetches ipc://localhost/<cmd> (http://ipc.localhost on
    // Windows). The renderer's CSP (written for Electron) does not list it, so
    // WebKit refused the fetch and Tauri fell back to postMessage, which hands
    // every result back as a script string the shell evaluates in the page.
    // Those strings stayed charged to the shell process (owned, unmapped) and
    // a 12MB result grew it by about 12MB per call. Over the custom protocol a
    // result is a plain response body.
    html = html.replace(/connect-src 'self'/, "connect-src 'self' ipc: http://ipc.localhost")
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(html)
    return
  }
  res.writeHead(200, { 'content-type': type, 'content-length': String(st.size), 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') return void res.end()
  fs.createReadStream(file).pipe(res)
}

// ---- WebSocket (RFC 6455, server side, just what the preload speaks) ----------

function upgrade(req: http.IncomingMessage, socket: Duplex): void {
  const u = new URL(req.url ?? '/', serverOrigin())
  const keyH = req.headers['sec-websocket-key']
  if (
    !hostOk(req) ||
    req.headers.origin !== serverOrigin() ||
    u.pathname !== '/__riven/ws' ||
    !tokenOk(u, req) ||
    typeof keyH !== 'string'
  ) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  const wc = windowByLabel(u.searchParams.get('w') ?? '')?.webContents
  if (!wc) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  const accept = crypto.createHash('sha1').update(keyH + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  ;(socket as { setNoDelay?: (b: boolean) => void }).setNoDelay?.(true)
  new Peer(socket, wc)
}

type FromPage =
  | { t: 'invoke'; id: number; ch: string; args: unknown[] }
  | { t: 'send'; ch: string; args: unknown[] }
  | { t: 'evalres'; id: number; ok: boolean; val?: unknown; err?: string }

class Peer implements Sock {
  private buf = Buffer.alloc(0)
  private frags: Buffer[] = []
  private closed = false
  private nextEval = 1
  private evals = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(
    private readonly socket: Duplex,
    private readonly wc: WebContents
  ) {
    socket.on('data', (c: Buffer) => this.onData(c))
    socket.on('close', () => this.onClose())
    socket.on('error', () => this.onClose())
    wc._attach(this)
  }

  sendEv(channel: string, args: unknown[]): void {
    this.write({ t: 'ev', ch: channel, args })
  }
  evalJs(code: string): Promise<unknown> {
    const id = this.nextEval++
    return new Promise((resolve, reject) => {
      this.evals.set(id, { resolve, reject })
      this.write({ t: 'eval', id, code })
    })
  }
  close(): void {
    if (this.closed) return
    this.frame(0x8, Buffer.alloc(0))
    this.socket.end()
    this.onClose()
  }

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    for (const e of this.evals.values()) e.reject(new Error('page gone'))
    this.evals.clear()
    this.wc._detach(this)
  }

  private write(m: unknown): void {
    if (!this.closed) this.frame(0x1, Buffer.from(encode(m), 'utf8'))
  }

  private frame(op: number, payload: Buffer): void {
    const n = payload.length
    let head: Buffer
    if (n < 126) {
      head = Buffer.from([0x80 | op, n])
    } else if (n < 65536) {
      head = Buffer.alloc(4)
      head[0] = 0x80 | op
      head[1] = 126
      head.writeUInt16BE(n, 2)
    } else {
      head = Buffer.alloc(10)
      head[0] = 0x80 | op
      head[1] = 127
      head.writeBigUInt64BE(BigInt(n), 2)
    }
    this.socket.write(Buffer.concat([head, payload]))
  }

  private onData(c: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, c]) : c
    for (;;) {
      const b = this.buf
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0
      const op = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (b.length < 10) return
        len = Number(b.readBigUInt64BE(2))
        off = 10
      }
      // Browsers always mask; an unmasked frame is not from one.
      if (!masked) return this.close()
      if (b.length < off + 4 + len) return
      const mask = b.subarray(off, off + 4)
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      this.buf = b.subarray(off + 4 + len)

      if (op === 0x8) return this.close()
      if (op === 0x9) {
        this.frame(0xa, payload)
        continue
      }
      if (op === 0xa) continue
      this.frags.push(payload)
      if (!fin) continue
      const msg = Buffer.concat(this.frags).toString('utf8')
      this.frags = []
      this.onMessage(msg)
    }
  }

  private onMessage(s: string): void {
    let m: FromPage
    try {
      m = decode(s) as FromPage
    } catch {
      return
    }
    if (m.t === 'invoke') {
      ipcMain._invoke(this.wc, m.ch, m.args ?? []).then(
        (val) => this.write({ t: 'res', id: m.id, ok: true, val }),
        (e: unknown) => {
          const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
          this.write({ t: 'res', id: m.id, ok: false, err: `Error invoking remote method '${m.ch}': ${err}` })
        }
      )
    } else if (m.t === 'send') {
      if (m.ch === '__riven:open') return this.windowOpen(String((m.args ?? [])[0] ?? ''))
      if (m.ch === '__riven:closePopout') {
        const id = String((m.args ?? [])[0] ?? '')
        if (/^[\w-]+$/.test(id)) void call('win.destroy', { label: `pop-${id}` }).catch(() => {})
        return
      }
      if (m.ch === '__riven:popTheme') {
        const [color, mode] = (m.args ?? []).map(String)
        void call('pop.theme', { color, mode }).catch(() => {})
        return
      }
      try {
        ipcMain._send(this.wc, m.ch, m.args ?? [])
      } catch (e) {
        console.error(`[ipc] ${m.ch} handler threw`, e)
      }
    } else if (m.t === 'evalres') {
      const p = this.evals.get(m.id)
      if (!p) return
      this.evals.delete(m.id)
      if (m.ok) p.resolve(m.val)
      else p.reject(new Error(m.err))
    }
  }

  // window.open from the page. Electron asked setWindowOpenHandler first; the
  // handler opens real links itself. Allowed same-app windows (a dockview
  // pop-out) have no equivalent here yet.
  private windowOpen(url: string): void {
    const h = this.wc._openHandler
    if (h) {
      const r = h({ url })
      if (r.action === 'allow') console.warn('[tauri] window.open of an app page is not supported:', url)
    }
  }
}
