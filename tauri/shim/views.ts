// WebContentsView (the browser panel's tabs) over child webviews of a Tauri
// window. src-tauri/src/browser.rs is the native side.
//
// Rust reports the page's state as WebKit has it (url, title, isLoading,
// back/forward) after every hook; this turns the differences into the events
// Electron raises (did-start-loading, did-navigate, page-title-updated, ...),
// and keeps the last state for the synchronous getters.
//
// TODO(tauri): a browser panel popped out into its own window. browser.ts finds
// the pop-out among BrowserWindow.getAllWindows(), but dockview's pop-outs here
// are Tauri windows Node never made (pop-<id>, main.rs popout()), so the view
// stays in riven's window, hidden, while the panel is popped out.
import { EventEmitter } from 'events'
import * as path from 'path'
import * as vm from 'vm'
import { call, fire, onEvent } from './rust'
import type { BrowserWindow, Rect } from './windows'
// Cyclic, touched at call time only.
import { nativeImage, type NativeImage } from './electron-main'

type State = { url: string; title: string; loading: boolean; back: boolean; fwd: boolean }
type Ev = { preventDefault: () => void; defaultPrevented: boolean }
const ev = (): Ev => ({
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true
  }
})

// ---- sessions (only will-download is real) ------------------------------------

export class DownloadItem extends EventEmitter {
  constructor(
    readonly url: string,
    private savePath: string
  ) {
    super()
  }
  getFilename(): string {
    return path.basename(this.savePath)
  }
  getSavePath(): string {
    return this.savePath
  }
  getURL(): string {
    return this.url
  }
  _done(ok: boolean, p: string | null): void {
    if (p) this.savePath = p
    this.emit('done', ev(), ok ? 'completed' : 'interrupted')
  }
}

export class Session extends EventEmitter {
  constructor(readonly partition: string) {
    super()
    this.setMaxListeners(0)
  }
  setPermissionRequestHandler(): void {}
  setPermissionCheckHandler(): void {}
  setUserAgent(): void {}
  getUserAgent(): string {
    return ''
  }
  // TODO(tauri): WKWebsiteDataStore removal for these.
  clearCache(): Promise<void> {
    return Promise.resolve()
  }
  clearStorageData(): Promise<void> {
    return Promise.resolve()
  }
  readonly cookies = {
    get: async (): Promise<unknown[]> => [],
    set: async (): Promise<void> => {},
    remove: async (): Promise<void> => {}
  }
  readonly webRequest = { onBeforeSendHeaders: (): void => {}, onHeadersReceived: (): void => {} }
}
const sessions = new Map<string, Session>()
export const session = {
  fromPartition(p: string): Session {
    let s = sessions.get(p)
    if (!s) sessions.set(p, (s = new Session(p)))
    return s
  },
  get defaultSession(): Session {
    return session.fromPartition('')
  }
}

// ---- the view's webContents -----------------------------------------------------

let nextView = 1
const byLabel = new Map<string, ViewContents>()

// Whether `code` parses as an expression: then it is awaited in the page, as
// Electron awaits a promise result. Otherwise it runs as a script.
function isExpression(code: string): boolean {
  try {
    new vm.Script(`(async () => (\n${code}\n))`)
    return true
  } catch {
    return false
  }
}

export class ViewContents extends EventEmitter {
  readonly id = 100000 + nextView
  readonly label = `bv-${nextView++}`
  readonly session: Session
  private st: State = { url: '', title: '', loading: false, back: false, fwd: false }
  private zoom = 1
  private destroyed = false
  // Nothing is reported until the first loadURL: the about:blank the view is
  // created with is not a page anyone asked for.
  private started = false
  private poll: ReturnType<typeof setInterval> | null = null
  private loadWaiters: Array<(err?: Error) => void> = []
  _openHandler: ((d: { url: string }) => { action: 'allow' | 'deny' }) | null = null
  host: BrowserWindow | null = null

  constructor(partition: string) {
    super()
    this.setMaxListeners(0)
    this.session = session.fromPartition(partition)
    byLabel.set(this.label, this)
  }

  // Created in Rust when first attached to a window.
  _attach(w: BrowserWindow): void {
    if (this.destroyed || this.host === w) return
    if (!this.host) fire('bv.create', { label: this.label, host: w.label, partition: this.session.partition })
    else fire('bv.reparent', { label: this.label, host: w.label })
    this.host = w
  }
  private cmd(cmd: string, args: Record<string, unknown> = {}): void {
    if (!this.destroyed && this.host) fire(cmd, { label: this.label, ...args })
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isLoading(): boolean {
    return this.st.loading
  }
  isCrashed(): boolean {
    return false
  }
  getURL(): string {
    return this.st.url
  }
  getTitle(): string {
    return this.st.title || this.st.url
  }

  loadURL(url: string): Promise<void> {
    if (this.destroyed || !this.host) return Promise.reject(new Error('view is not attached'))
    this.started = true
    this.cmd('bv.navigate', { url })
    // Electron resolves when the load is done, and rejects when it fails.
    return new Promise((resolve, reject) => {
      const t = setTimeout(done, 30000)
      const self = this
      function done(err?: Error): void {
        clearTimeout(t)
        self.loadWaiters = self.loadWaiters.filter((w) => w !== done)
        if (err) reject(err)
        else resolve()
      }
      this.loadWaiters.push(done)
    })
  }
  reload(): void {
    this.cmd('bv.go', { action: 'reload' })
  }
  reloadIgnoringCache(): void {
    this.reload()
  }
  stop(): void {
    this.cmd('bv.go', { action: 'stop' })
  }
  get navigationHistory(): {
    canGoBack: () => boolean
    canGoForward: () => boolean
    goBack: () => void
    goForward: () => void
  } {
    return {
      canGoBack: () => this.st.back,
      canGoForward: () => this.st.fwd,
      goBack: () => this.cmd('bv.go', { action: 'back' }),
      goForward: () => this.cmd('bv.go', { action: 'forward' })
    }
  }
  canGoBack(): boolean {
    return this.st.back
  }
  canGoForward(): boolean {
    return this.st.fwd
  }
  goBack(): void {
    this.navigationHistory.goBack()
  }
  goForward(): void {
    this.navigationHistory.goForward()
  }
  focus(): void {
    this.cmd('bv.focus')
  }

  async executeJavaScript(code: string, _userGesture?: boolean): Promise<unknown> {
    if (this.destroyed || !this.host) throw new Error('view is not attached')
    const text = await call<string>('wv.exec', { label: this.label, code, expr: isExpression(code) })
    const r = JSON.parse(text) as { v?: unknown; u?: 1 }
    return 'u' in r ? undefined : r.v
  }

  // rect is in CSS px of the page; the snapshot wants the view's points.
  async capturePage(rect?: Rect): Promise<NativeImage> {
    const z = this.zoom
    const r = rect && { x: rect.x * z, y: rect.y * z, width: rect.width * z, height: rect.height * z }
    const b64 = await call<string>('wv.capture', { label: this.label, rect: r ?? null })
    return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
  }

  getZoomFactor(): number {
    return this.zoom
  }
  setZoomFactor(f: number): void {
    this.zoom = f
    this.cmd('bv.zoom', { factor: f })
  }

  // WebKit has no find bar API worth the trouble here; window.find selects and
  // scrolls to the next match (wrapping), which is what the panel needs.
  findInPage(text: string): number {
    void this.executeJavaScript(`window.find(${JSON.stringify(text)}, false, false, true)`).catch(() => {})
    return 0
  }
  stopFindInPage(): void {
    void this.executeJavaScript('void (getSelection() && getSelection().removeAllRanges())').catch(() => {})
  }

  openDevTools(_o?: unknown): void {
    this.cmd('bv.devtools')
  }
  toggleDevTools(): void {
    this.openDevTools()
  }
  // TODO(tauri): WebKit's inspector has no public "inspect at point"; it opens
  // on the page instead.
  inspectElement(_x: number, _y: number): void {
    this.openDevTools()
  }
  setWindowOpenHandler(fn: (d: { url: string }) => { action: 'allow' | 'deny' }): void {
    this._openHandler = fn
  }
  setAudioMuted(): void {}
  setBackgroundThrottling(): void {}
  invalidate(): void {}

  close(): void {
    if (this.destroyed) return
    this.cmd('bv.close')
    this._destroy()
  }
  _destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopPoll()
    for (const w of this.loadWaiters.splice(0)) w()
    byLabel.delete(this.label)
    this.emit('destroyed')
  }

  // ---- from Rust ----

  _state(st: State, hint: string): void {
    if (!this.started || this.destroyed) return
    const prev = this.st
    this.st = st
    if (st.loading && !prev.loading) this.emit('did-start-loading')
    if (hint === 'commit') this.emit('did-navigate', ev(), st.url, 200, 'OK')
    else if (st.url !== prev.url) {
      if (hint === 'nav') this.emit('did-navigate-in-page', ev(), st.url, true)
      else this.emit('did-navigate', ev(), st.url, 200, 'OK')
    }
    if (st.title !== prev.title) this.emit('page-title-updated', ev(), st.title, true)
    if (!st.loading && prev.loading) {
      this.emit('did-finish-load')
      this.emit('did-stop-loading')
      for (const w of this.loadWaiters.splice(0)) w()
    }
    // A load that fails never says it finished: ask while one is going.
    if (st.loading) this.startPoll()
    else this.stopPoll()
  }
  // Rust's navigation delegate saw the load fail (browser.rs NavProxy), with
  // Chromium's net error code and name. Electron's order: the failure, then
  // the load stopping (from the state that comes with it).
  _fail(m: Record<string, unknown>, st: State | null): void {
    if (!this.started || this.destroyed) return
    const code = Number(m.code) || -2
    const desc = String(m.desc ?? 'ERR_FAILED')
    const url = String(m.url ?? '')
    console.log(`[browser] load failed: ${desc} (${code}) ${url}`)
    if (m.provisional) this.emit('did-fail-provisional-load', ev(), code, desc, url, true, 0, 0)
    this.emit('did-fail-load', ev(), code, desc, url, true, 0, 0)
    const err = Object.assign(new Error(`${desc} (${code}) loading '${url}'`), { errno: code, code: desc, url })
    for (const w of this.loadWaiters.splice(0)) w(err)
    // A load that never reached the page is followed at once by the error page
    // Rust shows at the failed URL; WebKit's state here still names the old
    // page for a moment, which would flash it into the address bar. The error
    // page's own load brings the state.
    const errorPage = !!m.provisional && code !== -3
    if (st && !errorPage) this._state(st, 'fail')
  }
  private startPoll(): void {
    if (this.poll) return
    this.poll = setInterval(() => {
      if (this.destroyed || !this.host) return this.stopPoll()
      call<State>('bv.state', { label: this.label })
        .then((st) => this._state(st, 'poll'))
        .catch(() => {})
    }, 700)
  }
  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  _msg(m: Record<string, unknown>, st: State | null): void {
    if (this.destroyed) return
    switch (m.t) {
      case 'nav':
        if (st) this._state(st, 'nav')
        // The page's script can tell before WKWebView's URL does (a fragment
        // change, measured): look again once it has caught up.
        setTimeout(() => {
          if (this.destroyed) return
          call<State>('bv.state', { label: this.label })
            .then((s) => this._state(s, 'nav'))
            .catch(() => {})
        }, 120)
        break
      case 'key':
        this.emit('before-input-event', ev(), {
          type: 'keyDown',
          key: String(m.key ?? ''),
          code: String(m.code ?? ''),
          meta: !!m.meta,
          control: !!m.control,
          alt: !!m.alt,
          shift: !!m.shift,
          isAutoRepeat: false
        })
        break
      case 'ctx':
        if (st) this._state(st, 'ctx')
        this.emit('context-menu', ev(), {
          x: Number(m.x) || 0,
          y: Number(m.y) || 0,
          linkURL: String(m.linkURL ?? ''),
          srcURL: String(m.srcURL ?? ''),
          mediaType: String(m.mediaType ?? 'none'),
          selectionText: String(m.selectionText ?? ''),
          isEditable: !!m.isEditable
        })
        break
      case 'favicon':
        if (this.started && typeof m.url === 'string') this.emit('page-favicon-updated', ev(), [m.url])
        break
    }
  }

  _newWindow(url: string): void {
    const r = this._openHandler?.({ url }) ?? { action: 'deny' }
    // TODO(tauri): 'allow' would need a real popup window; the panel always denies.
    void r
  }
}

// ---- the view -----------------------------------------------------------------

export class WebContentsView extends EventEmitter {
  readonly webContents: ViewContents
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private visible = true
  private sent = ''

  constructor(opts: { webPreferences?: { partition?: string } } = {}) {
    super()
    this.webContents = new ViewContents(opts.webPreferences?.partition || '')
  }

  _attachTo(w: BrowserWindow): void {
    this.webContents._attach(w)
    // A new host has never seen where or whether the view is.
    this.sent = ''
    this.push()
  }
  setBounds(r: Rect): void {
    this.bounds = { ...r }
    this.push()
  }
  getBounds(): Rect {
    return { ...this.bounds }
  }
  setVisible(on: boolean): void {
    this.visible = on
    this.push()
  }
  getVisible(): boolean {
    return this.visible
  }
  setBackgroundColor(): void {}
  setBorderRadius(): void {}

  // browser:sync re-sends the same bounds on every layout tick; only changes
  // cross to Rust.
  private push(): void {
    const wc = this.webContents
    if (!wc.host || wc.isDestroyed()) return
    const b = this.bounds
    // Never shown before it has somewhere to be.
    const on = this.visible && b.width > 0 && b.height > 0
    const key = `${on ? 1 : 0}:${b.x},${b.y},${b.width},${b.height}`
    if (key === this.sent) return
    const first = this.sent === ''
    const was = this.sent.startsWith('1')
    this.sent = key
    if (on) fire('bv.bounds', { label: wc.label, ...b })
    if (first || on !== was) fire('bv.visible', { label: wc.label, on })
  }
}

onEvent((m) => {
  if (m.ev !== 'bv') return
  const wc = byLabel.get(String(m.label))
  if (!wc) return
  const st = (m.state as State | null) ?? null
  switch (m.kind) {
    case 'state':
      if (st) wc._state(st, String(m.hint))
      break
    case 'msg':
      wc._msg((m.msg as Record<string, unknown>) ?? {}, st)
      break
    case 'fail':
      wc._fail(m, st)
      break
    case 'newwindow':
      wc._newWindow(String(m.url))
      break
    case 'download': {
      const item = new DownloadItem(String(m.url), String(m.path ?? ''))
      downloads.set(String(m.url), item)
      wc.session.emit('will-download', ev(), item, wc)
      break
    }
    case 'download-done': {
      const item = downloads.get(String(m.url))
      if (!item) break
      downloads.delete(String(m.url))
      item._done(!!m.success, typeof m.path === 'string' ? m.path : null)
      break
    }
  }
})
const downloads = new Map<string, DownloadItem>()

// The window went away and took its child webviews with it.
export function hostClosed(w: BrowserWindow): void {
  for (const wc of byLabel.values()) if (wc.host === w) wc._destroy()
}
