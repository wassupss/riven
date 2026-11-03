// BrowserWindow / WebContents over a Tauri window.
//
// One Tauri webview window per BrowserWindow, labelled "w<id>". Its page talks
// to main over a WebSocket (server.ts); every socket that says it belongs to
// window "w<id>" is that window's WebContents. Window state the old code reads
// synchronously (bounds, visibility, ...) is asked of Rust synchronously.
import { EventEmitter } from 'events'
import * as path from 'path'
import { call, callSync, fire, onEvent } from './rust'
import { serverOrigin, rendererDir } from './server-info'
// Cyclic (electron-main imports this file), but only touched at call time.
import { nativeImage, type NativeImage } from './electron-main'

export type Rect = { x: number; y: number; width: number; height: number }

let nextId = 1
const windows = new Map<number, BrowserWindow>()
const byLabel = new Map<string, BrowserWindow>()
let focusedLabel: string | null = null

export interface Sock {
  sendEv: (channel: string, args: unknown[]) => void
  evalJs: (code: string) => Promise<unknown>
  close: () => void
}

export class WebContents extends EventEmitter {
  readonly id: number
  private socks = new Set<Sock>()
  private destroyed = false
  private loading = true
  private zoom = 1
  private url = ''
  _openHandler: ((d: { url: string }) => { action: 'allow' | 'deny' }) | null = null

  constructor(readonly owner: BrowserWindow) {
    super()
    this.id = owner.id
    this.setMaxListeners(0)
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) return
    for (const s of this.socks) s.sendEv(channel, args)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isLoading(): boolean {
    return this.loading
  }
  isCrashed(): boolean {
    return false
  }
  getURL(): string {
    return this.url
  }
  getTitle(): string {
    return this.owner.getTitle()
  }
  getOSProcessId(): number {
    return process.pid
  }

  getZoomFactor(): number {
    return this.zoom
  }
  setZoomFactor(f: number): void {
    this.zoom = f
    if (!this.destroyed) fire('win.zoom', { label: this.owner.label, factor: f })
  }
  _zoomChanged(f: number): void {
    this.zoom = f
  }

  async loadURL(url: string): Promise<void> {
    this.url = mapUrl(url)
    this.loading = true
    await call('win.navigate', { label: this.owner.label, url: this.url })
  }
  loadFile(file: string): Promise<void> {
    return this.loadURL(file)
  }
  reload(): void {
    fire('win.reload', { label: this.owner.label })
  }
  reloadIgnoringCache(): void {
    this.reload()
  }
  openDevTools(): void {
    fire('win.devtools', { label: this.owner.label })
  }
  toggleDevTools(): void {
    this.openDevTools()
  }
  focus(): void {
    this.owner.focus()
  }
  // Chromium repaint after sleep: WebKit has no such stale-tile problem to fix.
  invalidate(): void {}
  setWindowOpenHandler(fn: (d: { url: string }) => { action: 'allow' | 'deny' }): void {
    this._openHandler = fn
  }
  async executeJavaScript(code: string): Promise<unknown> {
    const s = [...this.socks][0]
    if (!s) throw new Error('no page')
    return s.evalJs(code)
  }
  // The whole visible page; a rect is ignored (only the browser panel, which
  // this build lacks, asked for one).
  async capturePage(): Promise<NativeImage> {
    const b64 = await call<string>('win.capture', { label: this.owner.label })
    return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
  }
  sendInputEvent(): void {}
  setBackgroundThrottling(): void {}
  setAudioMuted(): void {}
  get navigationHistory(): { canGoBack: () => boolean; canGoForward: () => boolean } {
    return { canGoBack: () => false, canGoForward: () => false }
  }
  get session(): unknown {
    return {}
  }

  // ---- server.ts ----

  _attach(s: Sock): void {
    const reloaded = this.socks.size === 0 && !this.loading
    this.socks.add(s)
    if (this.socks.size > 1) return
    if (reloaded) this.emit('did-start-navigation', { isSameDocument: false, url: this.url })
    const first = this.loading
    this.loading = false
    this.emit('dom-ready')
    this.emit('did-finish-load')
    if (first) this.owner._pageReady()
  }

  _detach(s: Sock): void {
    this.socks.delete(s)
  }

  _destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const s of this.socks) s.close()
    this.socks.clear()
    this.emit('destroyed')
  }
}

// A renderer path (…/out-tauri/renderer/x.html) or an electron-vite dev URL
// becomes a page on our server; anything else (an OAuth page) is left alone.
function mapUrl(u: string): string {
  if (/^https?:\/\//.test(u) || u.startsWith('about:')) return u
  const rel = path.relative(rendererDir(), u.replace(/^file:\/\//, ''))
  return `${serverOrigin()}/${rel.split(path.sep).join('/')}`
}

type WinOpts = {
  width?: number
  height?: number
  x?: number
  y?: number
  minWidth?: number
  minHeight?: number
  show?: boolean
  frame?: boolean
  transparent?: boolean
  hasShadow?: boolean
  resizable?: boolean
  maximizable?: boolean
  minimizable?: boolean
  skipTaskbar?: boolean
  alwaysOnTop?: boolean
  focusable?: boolean
  title?: string
  titleBarStyle?: string
  backgroundColor?: string
  parent?: BrowserWindow
  modal?: boolean
  [k: string]: unknown
}

export class BrowserWindow extends EventEmitter {
  readonly id: number
  readonly label: string
  readonly webContents: WebContents
  private destroyed = false
  private visible = false
  private focusable: boolean
  private title: string
  private parent: BrowserWindow | null
  private minimized = false
  // browser.ts floats WebContentsViews here; there are none in this build.
  readonly contentView = { addChildView: (): void => {}, removeChildView: (): void => {}, children: [] as unknown[] }

  static getAllWindows(): BrowserWindow[] {
    // Electron lists the newest first.
    return [...windows.values()].reverse()
  }
  static fromWebContents(wc: WebContents | null | undefined): BrowserWindow | null {
    return wc?.owner && !wc.owner.destroyed ? wc.owner : null
  }
  static getFocusedWindow(): BrowserWindow | null {
    const w = focusedLabel ? byLabel.get(focusedLabel) : undefined
    return w && !w.destroyed ? w : null
  }
  static fromId(id: number): BrowserWindow | null {
    return windows.get(id) ?? null
  }

  constructor(opts: WinOpts = {}) {
    super()
    this.setMaxListeners(0)
    this.id = nextId++
    this.label = `w${this.id}`
    this.webContents = new WebContents(this)
    this.focusable = opts.focusable !== false
    this.title = opts.title ?? 'riven'
    this.parent = opts.parent ?? null
    windows.set(this.id, this)
    byLabel.set(this.label, this)
    const { parent, webPreferences: _wp, ...rest } = opts
    callSync('win.create', {
      label: this.label,
      opts: { ...rest, title: this.title, parent: parent?.label ?? null }
    })
    this.visible = false
  }

  _pageReady(): void {
    this.emit('ready-to-show')
  }

  _event(kind: string, m: Record<string, unknown>): void {
    switch (kind) {
      case 'focus':
        focusedLabel = this.label
        this.emit('focus')
        app_emit('browser-window-focus', this)
        break
      case 'blur':
        if (focusedLabel === this.label) focusedLabel = null
        this.emit('blur')
        break
      case 'moved':
        this.emit('move')
        this.emit('moved')
        break
      case 'resized':
        this.emit('resize')
        this.emit('resized')
        break
      case 'minimize':
        this.minimized = true
        this.emit('minimize')
        break
      case 'restore':
        this.minimized = false
        this.emit('restore')
        break
      case 'zoom':
        this.webContents._zoomChanged(Number(m.factor) || 1)
        break
      case 'closed':
        this._closed()
        break
      // Rust's navigation guard: a top-level load leaving our origin (app
      // windows, already blocked) or any load in an external window (auth,
      // allowed). Electron's handlers decide what to do with the URL.
      case 'navigate': {
        const url = String(m.url)
        const ev = { preventDefault: (): void => {}, url }
        this.webContents.emit('will-navigate', ev, url)
        if (!this.destroyed) this.webContents.emit('will-redirect', ev, url)
        break
      }
    }
  }

  private _closed(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.visible = false
    if (focusedLabel === this.label) focusedLabel = null
    windows.delete(this.id)
    byLabel.delete(this.label)
    this.emit('close', { preventDefault: () => {} })
    this.webContents._destroy()
    this.emit('closed')
    if (windows.size === 0) app_emit('window-all-closed')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  private cmd(cmd: string, args: Record<string, unknown> = {}): void {
    if (!this.destroyed) fire(cmd, { label: this.label, ...args })
  }
  private sync<T>(cmd: string, args: Record<string, unknown> = {}): T | undefined {
    if (this.destroyed) return undefined
    try {
      return callSync<T>(cmd, { label: this.label, ...args })
    } catch (e) {
      console.error(`[tauri] ${cmd}:`, (e as Error).message)
      return undefined
    }
  }

  loadURL(url: string): Promise<void> {
    return this.webContents.loadURL(url)
  }
  loadFile(file: string): Promise<void> {
    return this.webContents.loadFile(file)
  }
  reload(): void {
    this.webContents.reload()
  }

  show(): void {
    this.visible = true
    this.sync('win.show', { focus: true })
    this.emit('show')
  }
  showInactive(): void {
    this.visible = true
    this.sync('win.show', { focus: false })
    this.emit('show')
  }
  hide(): void {
    this.visible = false
    this.sync('win.hide')
    this.emit('hide')
  }
  close(): void {
    this.cmd('win.close')
  }
  destroy(): void {
    this.cmd('win.close')
  }
  focus(): void {
    this.cmd('win.focus')
  }
  blur(): void {}
  minimize(): void {
    this.cmd('win.minimize')
  }
  restore(): void {
    this.cmd('win.restore')
  }
  maximize(): void {
    this.cmd('win.maximize')
  }
  isMinimized(): boolean {
    return this.sync<boolean>('win.isMinimized') ?? this.minimized
  }
  isMaximized(): boolean {
    return false
  }
  isFullScreen(): boolean {
    return false
  }
  isVisible(): boolean {
    return this.sync<boolean>('win.isVisible') ?? this.visible
  }
  isFocused(): boolean {
    return focusedLabel === this.label
  }
  isFocusable(): boolean {
    return this.focusable
  }
  setFocusable(on: boolean): void {
    this.focusable = on
    this.sync('win.setFocusable', { on })
  }
  getParentWindow(): BrowserWindow | null {
    return this.parent
  }
  getChildWindows(): BrowserWindow[] {
    return [...windows.values()].filter((w) => w.parent === this)
  }
  setTitle(t: string): void {
    this.title = t
    this.cmd('win.setTitle', { title: t })
  }
  getTitle(): string {
    return this.title
  }
  getBounds(): Rect {
    return this.sync<Rect>('win.getBounds') ?? { x: 0, y: 0, width: 0, height: 0 }
  }
  getContentBounds(): Rect {
    return this.getBounds()
  }
  getNormalBounds(): Rect {
    return this.getBounds()
  }
  setBounds(b: Partial<Rect>): void {
    this.sync('win.setBounds', { bounds: b })
  }
  getPosition(): [number, number] {
    const b = this.getBounds()
    return [b.x, b.y]
  }
  setPosition(x: number, y: number): void {
    this.sync('win.setBounds', { bounds: { x, y } })
  }
  getSize(): [number, number] {
    const b = this.getBounds()
    return [b.width, b.height]
  }
  setSize(width: number, height: number): void {
    this.sync('win.setBounds', { bounds: { width, height } })
  }
  getContentSize(): [number, number] {
    return this.getSize()
  }
  center(): void {
    this.cmd('win.center')
  }
  setAlwaysOnTop(on: boolean): void {
    this.sync('win.setAlwaysOnTop', { on })
  }
  isAlwaysOnTop(): boolean {
    return this.sync<boolean>('win.isAlwaysOnTop') ?? false
  }
  setVisibleOnAllWorkspaces(on: boolean): void {
    this.cmd('win.setVisibleOnAllWorkspaces', { on })
  }
  setBackgroundColor(c: string): void {
    this.cmd('win.setBackgroundColor', { color: c })
  }
  setIgnoreMouseEvents(on: boolean): void {
    this.cmd('win.setIgnoreCursorEvents', { on })
  }
  setMenuBarVisibility(): void {}
  setAutoHideMenuBar(): void {}
  setSkipTaskbar(): void {}
  setHasShadow(on: boolean): void {
    this.cmd('win.setShadow', { on })
  }
  setOpacity(): void {}
  flashFrame(): void {}
  setProgressBar(): void {}
  moveTop(): void {
    this.focus()
  }
}

// app's event emitter lives in electron-main.ts; it registers itself here so
// window events that Electron raises on `app` reach it.
let appEmitter: EventEmitter | null = null
export function setAppEmitter(e: EventEmitter): void {
  appEmitter = e
}
function app_emit(ev: string, ...args: unknown[]): void {
  appEmitter?.emit(ev, { preventDefault: () => {} }, ...args)
}

export function windowByLabel(label: string): BrowserWindow | undefined {
  return byLabel.get(label)
}

onEvent((m) => {
  if (m.ev !== 'win') return
  const w = byLabel.get(String(m.label))
  if (w) w._event(String(m.kind), m)
})
