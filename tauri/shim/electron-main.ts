// What `import ... from 'electron'` resolves to in the Tauri build's main
// process (see tauri/build.mjs). Every name src/main uses is here with the
// shape src/main relies on; native work goes to the Rust shell (rust.ts) or to
// a macOS command-line tool.
import { EventEmitter } from 'events'
import { execFile, execFileSync, fork, spawn, type ChildProcess } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { call, callSync, connect, fire, onEvent } from './rust'
import { BrowserWindow, WebContents, setAppEmitter, type Rect } from './windows'
import { serverReady } from './server'
import { session, WebContentsView } from './views'

export { ipcMain } from './ipc'
export { BrowserWindow, WebContents }
export type { IpcMainEvent, IpcMainInvokeEvent } from './ipc'

connect()

// ---- app ---------------------------------------------------------------------

const APP_NAME = 'riven-tauri'
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
  version: string
}
let ready = false
let quitting = false

type QuitEvent = { preventDefault: () => void; defaultPrevented: boolean }

class App extends EventEmitter {
  readonly isPackaged = false
  readonly commandLine = { appendSwitch: (): void => {}, hasSwitch: (): boolean => false }
  readonly dock = {
    setIcon: (img: NativeImage): void => {
      const png = img.toPNG()
      if (png.length) fire('app.dockIcon', { png: png.toString('base64') })
    },
    setBadge: (): void => {},
    bounce: (): number => 0,
    show: (): Promise<void> => Promise.resolve(),
    hide: (): void => {}
  }
  private readyP: Promise<void>

  constructor() {
    super()
    this.setMaxListeners(0)
    this.readyP = Promise.all([serverReady(), call('app.ready')]).then(() => {
      ready = true
      this.emit('ready')
    })
  }

  get name(): string {
    return APP_NAME
  }
  // The real app sets 'riven' / 'riven-dev'. Whatever it asks for, this build
  // keeps its own name so its data directory never touches the real app's.
  setName(): void {}
  getName(): string {
    return APP_NAME
  }
  getVersion(): string {
    return pkg.version
  }
  getLocale(): string {
    return Intl.DateTimeFormat().resolvedOptions().locale
  }
  isReady(): boolean {
    return ready
  }
  whenReady(): Promise<void> {
    return this.readyP
  }
  getPath(name: string): string {
    const home = os.homedir()
    const support = path.join(home, 'Library', 'Application Support')
    switch (name) {
      case 'home':
        return home
      case 'appData':
        return support
      case 'userData':
      case 'sessionData':
        return path.join(support, APP_NAME)
      case 'temp':
        return os.tmpdir()
      case 'logs':
        return path.join(home, 'Library', 'Logs', APP_NAME)
      case 'desktop':
      case 'documents':
      case 'downloads':
      case 'music':
      case 'pictures':
      case 'videos':
        return path.join(home, name[0].toUpperCase() + name.slice(1))
      case 'exe':
        return process.execPath
      default:
        return path.join(support, APP_NAME)
    }
  }
  setActivationPolicy(p: string): void {
    fire('app.activationPolicy', { policy: p })
  }
  focus(_o?: { steal?: boolean }): void {
    fire('app.focus')
  }
  hide(): void {
    fire('app.hide')
  }
  getAppMetrics(): Array<{
    pid: number
    type: string
    serviceName?: string
    name?: string
    cpu: { percentCPUUsage: number }
  }> {
    const out = [{ pid: process.pid, type: 'Browser', name: 'node', cpu: { percentCPUUsage: mainCpu() } }]
    for (const c of children) {
      if (c.pid) out.push({ pid: c.pid, type: 'Utility', name: 'utility', cpu: { percentCPUUsage: 0 } })
    }
    return out
  }
  setAboutPanelOptions(): void {}
  requestSingleInstanceLock(): boolean {
    return true
  }
  setAsDefaultProtocolClient(): boolean {
    return false
  }
  relaunch(): void {}

  quit(): void {
    if (quitting) return
    const ev: QuitEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    quitting = true
    try {
      this.emit('before-quit', ev)
    } finally {
      quitting = false
    }
    if (ev.defaultPrevented) return
    this.exit(0)
  }
  exit(code = 0): void {
    this.emit('will-quit', { preventDefault: () => {} })
    this.emit('quit', { preventDefault: () => {} }, code)
    process.exit(code)
  }
}

let lastCpu = process.cpuUsage()
let lastAt = Date.now()
function mainCpu(): number {
  const now = Date.now()
  const d = process.cpuUsage(lastCpu)
  const pct = ((d.user + d.system) / 1000 / Math.max(1, now - lastAt)) * 100
  lastCpu = process.cpuUsage()
  lastAt = now
  return pct
}

export const app = new App()
setAppEmitter(app)

onEvent((m) => {
  switch (m.ev) {
    // Cmd+Q from the system (Dock menu, logout) or the last window closing.
    case 'quit-requested':
      app.quit()
      break
    case 'activate':
      app.emit('activate', { preventDefault: () => {} }, !!m.hasVisibleWindows)
      break
    case 'menu':
      menuClick(String(m.id))
      break
    case 'display':
      screen.emit(String(m.kind))
      break
    case 'power':
      powerMonitor.emit(String(m.kind))
      break
  }
})

// ---- dialog ------------------------------------------------------------------

type FileFilter = { name: string; extensions: string[] }
type OpenOpts = {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: FileFilter[]
  properties?: string[]
  message?: string
}
type SaveOpts = Omit<OpenOpts, 'properties'> & { nameFieldLabel?: string }
type BoxOpts = {
  type?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  title?: string
  message: string
  detail?: string
}

function winArg<T>(a: BrowserWindow | T | undefined, b?: T): [string | null, T] {
  if (a instanceof BrowserWindow) return [a.isDestroyed() ? null : a.label, b as T]
  return [null, a as T]
}

export const dialog = {
  async showOpenDialog(
    a: BrowserWindow | OpenOpts,
    b?: OpenOpts
  ): Promise<{ canceled: boolean; filePaths: string[] }> {
    const [label, o] = winArg<OpenOpts>(a, b)
    const paths = await call<string[] | null>('dialog.open', { label, opts: o ?? {} })
    return { canceled: !paths || paths.length === 0, filePaths: paths ?? [] }
  },
  async showSaveDialog(
    a: BrowserWindow | SaveOpts,
    b?: SaveOpts
  ): Promise<{ canceled: boolean; filePath: string }> {
    const [label, o] = winArg<SaveOpts>(a, b)
    const p = await call<string | null>('dialog.save', { label, opts: o ?? {} })
    return { canceled: !p, filePath: p ?? '' }
  },
  showMessageBoxSync(a: BrowserWindow | BoxOpts, b?: BoxOpts): number {
    const [label, o] = winArg<BoxOpts>(a, b)
    return callSync<number>('dialog.message', { label, opts: o }, Infinity)
  },
  async showMessageBox(a: BrowserWindow | BoxOpts, b?: BoxOpts): Promise<{ response: number; checkboxChecked: boolean }> {
    const [label, o] = winArg<BoxOpts>(a, b)
    const response = await call<number>('dialog.message', { label, opts: o })
    return { response, checkboxChecked: false }
  },
  showErrorBox(title: string, content: string): void {
    void call('dialog.message', { label: null, opts: { type: 'error', message: title, detail: content } })
  }
}

// ---- shell / clipboard -------------------------------------------------------

export const shell = {
  openExternal(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/open', [url], (e) => (e ? reject(e) : resolve()))
    })
  },
  showItemInFolder(p: string): void {
    execFile('/usr/bin/open', ['-R', p], () => {})
  },
  openPath(p: string): Promise<string> {
    return new Promise((resolve) => execFile('/usr/bin/open', [p], (e) => resolve(e ? e.message : '')))
  },
  trashItem(p: string): Promise<void> {
    const script = `tell application "Finder" to delete POSIX file ${JSON.stringify(p)}`
    return new Promise((resolve, reject) =>
      execFile('/usr/bin/osascript', ['-e', script], (e) => (e ? reject(e) : resolve()))
    )
  },
  beep(): void {}
}

export const clipboard = {
  writeText(text: string): void {
    execFileSync('/usr/bin/pbcopy', { input: text, env: { ...process.env, LANG: 'en_US.UTF-8' } })
  },
  readText(): string {
    return execFileSync('/usr/bin/pbpaste', { env: { ...process.env, LANG: 'en_US.UTF-8' } }).toString('utf8')
  }
}

// ---- screen ------------------------------------------------------------------

type Display = { id: number; bounds: Rect; workArea: Rect; scaleFactor: number }

class Screen extends EventEmitter {
  getAllDisplays(): Display[] {
    return callSync<Display[]>('screen.displays')
  }
  getPrimaryDisplay(): Display {
    return this.getAllDisplays()[0]
  }
  getCursorScreenPoint(): { x: number; y: number } {
    return callSync<{ x: number; y: number }>('screen.cursor')
  }
  getDisplayMatching(r: Rect): Display {
    const all = this.getAllDisplays()
    let best = all[0]
    let bestArea = -1
    for (const d of all) {
      const b = d.bounds
      const w = Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x)
      const h = Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y)
      const area = w > 0 && h > 0 ? w * h : 0
      if (area > bestArea) {
        best = d
        bestArea = area
      }
    }
    return best
  }
  getDisplayNearestPoint(p: { x: number; y: number }): Display {
    return this.getDisplayMatching({ x: p.x, y: p.y, width: 1, height: 1 })
  }
}
export const screen = new Screen()

export const powerMonitor = new EventEmitter()

// ---- power save blocker: caffeinate for as long as the block lasts -----------

let nextBlocker = 1
const blockers = new Map<number, ChildProcess>()
export const powerSaveBlocker = {
  start(_type: string): number {
    const id = nextBlocker++
    // -w ties caffeinate to us: it ends by itself if this process dies.
    const c = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    blockers.set(id, c)
    return id
  },
  stop(id: number): void {
    blockers.get(id)?.kill()
    blockers.delete(id)
  },
  isStarted(id: number): boolean {
    return blockers.has(id)
  }
}

// ---- safeStorage: AES-256-GCM with a key kept in the login keychain -----------

const KEYCHAIN_SERVICE = 'riven-tauri Safe Storage'
let storageKey: Buffer | null = null
function key(): Buffer {
  if (storageKey) return storageKey
  let b64 = ''
  try {
    b64 = execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    b64 = crypto.randomBytes(32).toString('base64')
    execFileSync(
      '/usr/bin/security',
      ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', APP_NAME, '-w', b64, '-U'],
      { stdio: 'ignore' }
    )
  }
  storageKey = Buffer.from(b64, 'base64')
  if (storageKey.length !== 32) throw new Error('safeStorage: bad key in keychain')
  return storageKey
}
const MAGIC = Buffer.from('rt1')
export const safeStorage = {
  isEncryptionAvailable(): boolean {
    try {
      key()
      return true
    } catch {
      return false
    }
  },
  getSelectedStorageBackend(): string {
    return 'keychain'
  },
  encryptString(s: string): Buffer {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv)
    const body = Buffer.concat([c.update(s, 'utf8'), c.final()])
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), body])
  },
  decryptString(b: Buffer): string {
    if (!b.subarray(0, 3).equals(MAGIC)) throw new Error('safeStorage: unknown format')
    const iv = b.subarray(3, 15)
    const tag = b.subarray(15, 31)
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(b.subarray(31)), d.final()]).toString('utf8')
  }
}

// ---- Notification: osascript (a click on it can't be observed) ---------------

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return true
  }
  constructor(private readonly o: { title?: string; subtitle?: string; body?: string; silent?: boolean } = {}) {
    super()
  }
  show(): void {
    const q = (s: string): string => JSON.stringify(s)
    let script = `display notification ${q(this.o.body ?? '')} with title ${q(this.o.title ?? APP_NAME)}`
    if (this.o.subtitle) script += ` subtitle ${q(this.o.subtitle)}`
    if (!this.o.silent) script += ' sound name "default"'
    execFile('/usr/bin/osascript', ['-e', script], () => {})
    this.emit('show')
  }
  close(): void {}
}

// ---- nativeImage ---------------------------------------------------------------

export class NativeImage {
  template = false
  constructor(private png: Buffer) {}
  isEmpty(): boolean {
    return this.png.length === 0
  }
  toPNG(): Buffer {
    return this.png
  }
  toDataURL(): string {
    return `data:image/png;base64,${this.png.toString('base64')}`
  }
  getSize(): { width: number; height: number } {
    if (this.png.length < 24) return { width: 0, height: 0 }
    return { width: this.png.readUInt32BE(16), height: this.png.readUInt32BE(20) }
  }
  // The tray wants the sharpest one; keep the largest representation.
  addRepresentation(r: { scaleFactor?: number; buffer?: Buffer }): void {
    if (r.buffer && (r.scaleFactor ?? 1) > 1) this.png = r.buffer
  }
  setTemplateImage(on: boolean): void {
    this.template = on
  }
  isTemplateImage(): boolean {
    return this.template
  }
  resize(): NativeImage {
    return this
  }
}
export const nativeImage = {
  createFromPath(p: string): NativeImage {
    try {
      return new NativeImage(fs.readFileSync(p))
    } catch {
      return new NativeImage(Buffer.alloc(0))
    }
  },
  createFromBuffer(b: Buffer): NativeImage {
    return new NativeImage(b)
  },
  createFromDataURL(u: string): NativeImage {
    return new NativeImage(Buffer.from(u.replace(/^data:[^,]*,/, ''), 'base64'))
  },
  createEmpty(): NativeImage {
    return new NativeImage(Buffer.alloc(0))
  }
}

// ---- net.fetch: Node's fetch, plus file: URLs (media.ts serves files with it) --

async function fetchFile(url: string, init?: { headers?: unknown; method?: string }): Promise<Response> {
  const file = decodeURIComponent(new URL(url).pathname)
  const st = await fs.promises.stat(file)
  const headers = new Headers(init?.headers as HeadersInit | undefined)
  const range = headers.get('range')
  const type = mimeOf(file)
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      let start = m[1] ? Number(m[1]) : NaN
      let end = m[2] ? Number(m[2]) : st.size - 1
      if (Number.isNaN(start)) {
        start = Math.max(0, st.size - end)
        end = st.size - 1
      }
      end = Math.min(end, st.size - 1)
      if (start > end || start >= st.size) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${st.size}` } })
      }
      return new Response(streamOf(file, start, end), {
        status: 206,
        headers: {
          'content-type': type,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'accept-ranges': 'bytes'
        }
      })
    }
  }
  return new Response(streamOf(file, 0, st.size - 1), {
    status: 200,
    headers: { 'content-type': type, 'content-length': String(st.size), 'accept-ranges': 'bytes' }
  })
}

function streamOf(file: string, start: number, end: number): ReadableStream | null {
  if (end < start) return null
  const s = fs.createReadStream(file, { start, end })
  return new ReadableStream({
    start(ctl) {
      s.on('data', (c) => ctl.enqueue(new Uint8Array(c as Buffer)))
      s.on('end', () => ctl.close())
      s.on('error', (e) => ctl.error(e))
    },
    cancel() {
      s.destroy()
    }
  })
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8'
}
export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export const net = {
  fetch(url: string, init?: { headers?: unknown; method?: string }): Promise<Response> {
    if (url.startsWith('file:')) return fetchFile(url, init)
    return fetch(url, init as RequestInit)
  }
}

// ---- protocol: media.ts registers one handler; server.ts serves it ------------

type ProtoHandler = (req: Request) => Promise<Response> | Response
const protoHandlers = new Map<string, ProtoHandler>()
export const protocol = {
  registerSchemesAsPrivileged(): void {},
  handle(scheme: string, fn: ProtoHandler): void {
    protoHandlers.set(scheme, fn)
  },
  unhandle(scheme: string): void {
    protoHandlers.delete(scheme)
  },
  isProtocolHandled(scheme: string): boolean {
    return protoHandlers.has(scheme)
  }
}
export function protocolHandler(scheme: string): ProtoHandler | undefined {
  return protoHandlers.get(scheme)
}

// ---- Menu ----------------------------------------------------------------------

export type MenuItemConstructorOptions = {
  label?: string
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  role?: string
  accelerator?: string
  enabled?: boolean
  checked?: boolean
  visible?: boolean
  click?: (...a: unknown[]) => void
  submenu?: MenuItemConstructorOptions[] | Menu
  [k: string]: unknown
}

// The wire form Rust builds from. A role Rust knows becomes a native item;
// everything with a click is a plain item whose id comes back as a 'menu' event.
type WireItem = {
  id?: string
  kind: 'item' | 'separator' | 'submenu' | 'predefined' | 'check'
  label?: string
  role?: string
  accelerator?: string
  enabled?: boolean
  checked?: boolean
  items?: WireItem[]
}

let nextMenu = 1
const liveMenus = new Map<number, Menu>()

function focusedWc(): WebContents | undefined {
  const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  return w?.webContents
}

const quitLabel = `Quit ${APP_NAME}`
function expandRole(it: MenuItemConstructorOptions): MenuItemConstructorOptions | null {
  switch (it.role) {
    case 'appMenu':
      return {
        label: APP_NAME,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          // Ours, not the native one: it has to run before-quit (the confirm
          // dialog, the pty teardown), which only Node can do.
          { label: quitLabel, accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
        ]
      }
    case 'editMenu':
      return {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      }
    case 'quit':
      return { label: quitLabel, accelerator: it.accelerator ?? 'CmdOrCtrl+Q', click: () => app.quit() }
    case 'reload':
      return { label: 'Reload', accelerator: it.accelerator ?? 'CmdOrCtrl+R', click: () => focusedWc()?.reload() }
    case 'forceReload':
      return {
        label: 'Force Reload',
        accelerator: it.accelerator ?? 'CmdOrCtrl+Shift+R',
        click: () => focusedWc()?.reload()
      }
    case 'toggleDevTools':
      return {
        label: 'Toggle Developer Tools',
        accelerator: it.accelerator ?? 'Alt+CmdOrCtrl+I',
        click: () => focusedWc()?.openDevTools()
      }
    default:
      return null
  }
}

export class Menu {
  readonly id = nextMenu++
  private clicks = new Map<string, () => void>()
  readonly wire: WireItem[]
  readonly items: MenuItemConstructorOptions[]

  static buildFromTemplate(t: MenuItemConstructorOptions[]): Menu {
    return new Menu(t)
  }
  static setApplicationMenu(m: Menu | null): void {
    if (appMenu) liveMenus.delete(appMenu.id)
    appMenu = m
    if (m) liveMenus.set(m.id, m)
    fire('menu.setApp', { items: m?.wire ?? [] })
  }
  static getApplicationMenu(): Menu | null {
    return appMenu
  }

  constructor(t: MenuItemConstructorOptions[] = []) {
    this.items = t
    let n = 0
    const conv = (list: MenuItemConstructorOptions[]): WireItem[] => {
      const out: WireItem[] = []
      for (const raw of list) {
        if (raw.visible === false) continue
        const it = expandRole(raw) ?? raw
        if (it.type === 'separator') {
          out.push({ kind: 'separator' })
          continue
        }
        const sub = it.submenu instanceof Menu ? it.submenu.items : it.submenu
        if (sub) {
          out.push({ kind: 'submenu', label: it.label ?? '', enabled: it.enabled !== false, items: conv(sub) })
          continue
        }
        if (it.role && !it.click) {
          out.push({ kind: 'predefined', role: it.role, label: it.label, accelerator: it.accelerator })
          continue
        }
        const id = `${this.id}:${n++}`
        if (it.click) {
          const click = it.click
          this.clicks.set(id, () => click(it, BrowserWindow.getFocusedWindow(), {}))
        }
        out.push({
          id,
          kind: it.type === 'checkbox' || it.type === 'radio' ? 'check' : 'item',
          label: it.label ?? '',
          accelerator: it.accelerator,
          enabled: it.enabled !== false,
          checked: !!it.checked
        })
      }
      return out
    }
    this.wire = conv(t)
  }

  _click(id: string): void {
    this.clicks.get(id)?.()
  }

  // At the cursor, over the given (or focused) window. Clicks come back as
  // 'menu' events like the app menu's; the newest popup stays live for them.
  popup(o: { window?: BrowserWindow } = {}): void {
    const w = o.window ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!w || w.isDestroyed()) return
    if (popupMenu && popupMenu !== appMenu) liveMenus.delete(popupMenu.id)
    popupMenu = this
    liveMenus.set(this.id, this)
    fire('menu.popup', { label: w.label, items: this.wire })
  }
  closePopup(): void {}
}
let appMenu: Menu | null = null
let popupMenu: Menu | null = null

function menuClick(id: string): void {
  const m = liveMenus.get(Number(id.split(':')[0]))
  m?._click(id)
}

// ---- Tray ----------------------------------------------------------------------

let nextTray = 1
export class Tray extends EventEmitter {
  private readonly id = nextTray++
  private menu: Menu | null = null
  private dead = false

  constructor(img: NativeImage) {
    super()
    fire('tray.create', { id: this.id, png: img.toPNG().toString('base64'), template: img.isTemplateImage() })
  }
  setIgnoreDoubleClickEvents(): void {}
  setTitle(t: string): void {
    if (!this.dead) fire('tray.setTitle', { id: this.id, title: t })
  }
  setToolTip(t: string): void {
    if (!this.dead) fire('tray.setTooltip', { id: this.id, tooltip: t })
  }
  setImage(img: NativeImage): void {
    if (!this.dead)
      fire('tray.setIcon', { id: this.id, png: img.toPNG().toString('base64'), template: img.isTemplateImage() })
  }
  setContextMenu(m: Menu | null): void {
    if (this.dead) return
    if (this.menu) liveMenus.delete(this.menu.id)
    this.menu = m
    if (m) liveMenus.set(m.id, m)
    fire('tray.setMenu', { id: this.id, items: m?.wire ?? [] })
  }
  destroy(): void {
    if (this.dead) return
    this.dead = true
    if (this.menu) liveMenus.delete(this.menu.id)
    fire('tray.destroy', { id: this.id })
  }
  isDestroyed(): boolean {
    return this.dead
  }
}

// ---- systemPreferences ---------------------------------------------------------

// A Node child of an unbundled shell has no TCC identity of its own to ask with.
export const systemPreferences = {
  getMediaAccessStatus(): string {
    return 'not-determined'
  },
  askForMediaAccess(): Promise<boolean> {
    return Promise.resolve(false)
  },
  isTrustedAccessibilityClient(): boolean {
    return false
  },
  getUserDefault(): unknown {
    return undefined
  },
  on(): void {}
}

// ---- session / WebContentsView: the browser panel (views.ts) -----------------

export { session, WebContentsView } from './views'

export const webContents = {
  getAllWebContents(): WebContents[] {
    return BrowserWindow.getAllWindows().map((w) => w.webContents)
  },
  fromId(id: number): WebContents | undefined {
    return BrowserWindow.fromId(id)?.webContents
  },
  getFocusedWebContents(): WebContents | undefined {
    return BrowserWindow.getFocusedWindow()?.webContents
  }
}

// ---- utilityProcess: a plain Node child; tauri/build.mjs gives it parentPort ---

const children = new Set<ChildProcess>()

export interface UtilityProcess extends EventEmitter {
  pid: number | undefined
  postMessage(m: unknown): void
  kill(): boolean
}

export const utilityProcess = {
  fork(
    modulePath: string,
    args: string[] = [],
    opts: { stdio?: 'inherit' | 'pipe' | 'ignore'; env?: NodeJS.ProcessEnv; cwd?: string } = {}
  ): UtilityProcess {
    const child = fork(modulePath, args, {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), RIVEN_UTILITY_PROCESS: '1' },
      // Advanced serialization keeps Buffers/typed arrays intact, as Electron's
      // structured clone did.
      serialization: 'advanced',
      stdio: opts.stdio === 'pipe' ? 'pipe' : opts.stdio === 'ignore' ? 'ignore' : 'inherit'
    })
    children.add(child)
    const up = new EventEmitter() as UtilityProcess
    Object.defineProperty(up, 'pid', { get: () => child.pid })
    up.postMessage = (m) => {
      if (child.connected) child.send(m as never)
    }
    up.kill = () => child.kill()
    child.on('message', (m) => up.emit('message', m))
    child.on('spawn', () => up.emit('spawn'))
    child.on('exit', (code) => {
      children.delete(child)
      up.emit('exit', code ?? 0)
    })
    child.on('error', (e) => up.emit('error', e))
    return up
  }
}
process.on('exit', () => {
  for (const c of children) c.kill('SIGKILL')
})

// ---- Electron's ambient namespace bits src/main names as types -----------------

export type Event = { preventDefault: () => void }
export type Input = { type: string; key: string }
export type OpenDialogOptions = OpenOpts
export type SaveDialogOptions = SaveOpts
export type MessageBoxOptions = BoxOpts
export type Rectangle = Rect
export type IpcMainEventT = import('./ipc').IpcMainEvent

export default {
  app,
  BrowserWindow,
  dialog,
  shell,
  clipboard,
  screen,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  Notification,
  nativeImage,
  net,
  protocol,
  Menu,
  Tray,
  systemPreferences,
  session,
  WebContentsView,
  webContents,
  utilityProcess
}
