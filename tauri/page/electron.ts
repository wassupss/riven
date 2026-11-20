// 'electron' as src/preload sees it in the Tauri build. The preload bundle is
// loaded by a <script> Rust puts at the top of every app page (src-tauri/src/
// page.rs), so it runs before the page's own scripts, as Electron's preload
// did, but in the page's world (there is no isolated world to bridge from).
//
// Every channel is Rust's (rust-owned.ts): invoke/send become Tauri commands,
// and Rust's events arrive as the Tauri event 'riven:ipc'. There is no
// synchronous call: sendSync's two save channels start their async twin, and
// Rust waits for those before a window closes or the app quits
// (window.__rivenSettle, see lifecycle.rs FLUSH_JS).
import { ptyStream } from './pty-stream'
import { RUST_INVOKE, RUST_SYNC, rustCommand } from './rust-owned'

type W = Window & {
  __RIVEN_WIN__?: string
  __RIVEN_MEDIA__?: string
  __rivenSettle?: () => Promise<unknown>
  __rivenUnloading?: boolean
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: unknown) => Promise<unknown>
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number
    metadata?: { currentWindow?: { label?: string } }
  }
}
const w = window as W
const LABEL = w.__RIVEN_WIN__ ?? w.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? ''
// Workspace media, served by Rust on the page's own origin (page.rs).
w.__RIVEN_MEDIA__ = '/__riven/media/{}'

type Listener = (event: unknown, ...args: unknown[]) => void
const listeners = new Map<string, Listener[]>()

function deliver(ch: string, args: unknown[] | undefined): void {
  const ls = listeners.get(ch)
  if (!ls) return
  const evt = { sender: ipcRenderer }
  for (const l of [...ls]) {
    try {
      l(evt, ...(args ?? []))
    } catch (e) {
      console.error(`[ipc] listener for ${ch} threw`, e)
    }
  }
}

function tauriInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const t = w.__TAURI_INTERNALS__
  if (!t) return Promise.reject(new Error(`riven: Tauri is not available for '${cmd}'`))
  return t.invoke(cmd, args)
}

// ---- the Rust side ------------------------------------------------------------

// Positional ipc arguments -> the command's named ones. A rejection reads like
// Electron's ("Error invoking remote method 'ch': Error: ..."), as the Node
// path's did.
function rustInvoke(channel: string, names: readonly string[], args: unknown[]): Promise<unknown> {
  const t = w.__TAURI_INTERNALS__
  if (!t) return Promise.reject(new Error(`riven: Tauri is not available for '${channel}'`))
  const named: Record<string, unknown> = {}
  names.forEach((n, i) => {
    if (args[i] !== undefined) named[n] = args[i]
  })
  // A terminal's output comes back on the page's stream (pty-stream.ts); it
  // must be up before the terminal is.
  const call = (): Promise<unknown> => t.invoke(rustCommand(channel), named)
  const sent = channel === 'pty:open' ? ptyStream((c, a) => t.invoke(c, a), LABEL, deliver).then(call) : call()
  return sent.catch((e: unknown) => {
    throw new Error(`Error invoking remote method '${channel}': Error: ${e instanceof Error ? e.message : String(e)}`)
  })
}

// One listener for every event Rust sends this page: {ch, args}, delivered to
// ipcRenderer.on listeners like the socket's 'ev' messages. Targeted at this
// webview's label, so another window's events never arrive here.
function listenRust(): void {
  const t = w.__TAURI_INTERNALS__
  if (!t || !LABEL) return
  const handler = t.transformCallback((e) => {
    const p = (e as { payload?: { ch: string; args: unknown[] } }).payload
    if (p) deliver(p.ch, p.args)
  })
  t.invoke('plugin:event|listen', { event: 'riven:ipc', target: { kind: 'AnyLabel', label: LABEL }, handler }).catch((e) =>
    console.error('[ipc] listening for Rust events failed', e)
  )
}

// Saves started by sendSync that have not landed yet. Rust awaits them
// (__rivenSettle) before it lets a window close or the app quit.
const inFlight = new Set<Promise<unknown>>()
w.__rivenSettle = (): Promise<unknown> => Promise.allSettled([...inFlight])

type IpcR = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  sendSync(channel: string, ...args: unknown[]): unknown
  on(channel: string, fn: Listener): IpcR
  once(channel: string, fn: Listener): IpcR
  removeListener(channel: string, fn: Listener): IpcR
  off(channel: string, fn: Listener): IpcR
  removeAllListeners(channel?: string): IpcR
}

export const ipcRenderer: IpcR = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const names = RUST_INVOKE[channel]
    if (names) return rustInvoke(channel, names, args)
    return Promise.reject(
      new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`)
    )
  },
  send(channel: string, ...args: unknown[]): void {
    const names = RUST_INVOKE[channel]
    if (names) return void rustInvoke(channel, names, args).catch((e) => console.warn(`[ipc] ${channel}`, e))
    // Electron drops a send nobody listens for (browser:focusApp has no handler there either).
  },
  sendSync(channel: string, ...args: unknown[]): unknown {
    const twin = RUST_SYNC[channel]
    if (!twin) return undefined
    const p = rustInvoke(twin, RUST_INVOKE[twin], args).catch((e) => console.error(`[ipc] ${channel}`, e))
    inFlight.add(p)
    void p.finally(() => inFlight.delete(p))
    return true
  },
  on(channel: string, fn: Listener): typeof ipcRenderer {
    // The page that answers riven's MCP tool calls (App.tsx registers this
    // once, in the app window only) tells Rust where to send them, as
    // Electron's main was told with setAppWindow.
    if (channel === 'mcp:invoke') {
      w.__TAURI_INTERNALS__?.invoke('mcp_attach').catch((e) => console.error('[ipc] mcp_attach failed', e))
    }
    const ls = listeners.get(channel) ?? []
    ls.push(fn)
    listeners.set(channel, ls)
    return ipcRenderer
  },
  once(channel: string, fn: Listener): typeof ipcRenderer {
    const wrap: Listener = (e, ...a) => {
      ipcRenderer.removeListener(channel, wrap)
      fn(e, ...a)
    }
    return ipcRenderer.on(channel, wrap)
  },
  removeListener(channel: string, fn: Listener): typeof ipcRenderer {
    const ls = listeners.get(channel)
    if (ls) {
      const i = ls.indexOf(fn)
      if (i >= 0) ls.splice(i, 1)
      if (!ls.length) listeners.delete(channel)
    }
    return ipcRenderer
  },
  off(channel: string, fn: Listener): typeof ipcRenderer {
    return ipcRenderer.removeListener(channel, fn)
  },
  removeAllListeners(channel?: string): typeof ipcRenderer {
    if (channel) listeners.delete(channel)
    else listeners.clear()
    return ipcRenderer
  }
}

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    ;(window as unknown as Record<string, unknown>)[key] = api
  }
}

// The preload pairs this with ipc 'ui:setZoom', which main applies (and Rust
// sets on the webview); doing it twice would only race.
export const webFrame = {
  setZoomFactor(_f: number): void {},
  getZoomFactor(): number {
    return 1
  }
}

// WebKit gives a dropped File no path. The paths are on the macOS drag
// pasteboard for as long as the drag runs, so Rust reads them when a drag with
// files comes in (long before a person lets go), and at the drop we pair them
// with the Files: by order when the names line up, else by name.
const dropPaths = new WeakMap<File, string>()
let dropByName = new Map<string, string>()
let dragged: string[] = []
let asking = false
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1).normalize('NFC')

w.addEventListener(
  'dragenter',
  (e) => {
    if (asking || !e.dataTransfer?.types.includes('Files')) return
    asking = true
    tauriInvoke('riven_drag_paths')
      .then((v) => void (dragged = Array.isArray(v) ? (v as string[]) : []))
      .catch(() => void (dragged = []))
      .finally(() => void (asking = false))
  },
  true
)

w.addEventListener(
  'drop',
  (e) => {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!files.length) return
    const paths = dragged
    dropByName = new Map(paths.map((p) => [baseName(p), p]))
    const inOrder = paths.length === files.length && files.every((f, i) => baseName(paths[i]) === f.name.normalize('NFC'))
    files.forEach((f, i) => {
      const p = inOrder ? paths[i] : dropByName.get(f.name.normalize('NFC'))
      if (p) dropPaths.set(f, p)
    })
  },
  true
)

export const webUtils = {
  getPathForFile(f: File): string {
    return dropPaths.get(f) ?? dropByName.get(f.name.normalize('NFC')) ?? ''
  }
}

export default { ipcRenderer, contextBridge, webFrame, webUtils }

// ---- window.open / target=_blank -------------------------------------------

// Hand foreign URLs to main, whose setWindowOpenHandler sends real links to the
// browser. Our own pages (dockview's popout.html) go through the real
// window.open: the shell's on_new_window makes them opener-linked siblings, and
// dockview needs the Window it returns to move the group's DOM into.
// WKWebView ignores window.close() from script (wry has no webViewDidClose), so
// the window is tagged with an id in the fragment, which the shell uses as its
// label, and close() is routed to the shell by that id.
const nativeOpen = w.open.bind(w)
let popSeq = 0
// Popout pages get no preload; the test hook reaches them through these.
const pops = new Map<string, Window>()
;(w as W & { __rivenPops?: typeof pops }).__rivenPops = pops
w.open = ((url?: string | URL, target?: string, features?: string): Window | null => {
  const s = String(url ?? '')
  let u: URL | null = null
  try {
    u = new URL(s, location.href)
  } catch {
    /* not a url */
  }
  if (u?.origin !== location.origin) {
    // Electron's setWindowOpenHandler sent real links to the default browser.
    void tauriInvoke('shell_open_external', { url: s }).catch(() => {})
    return null
  }
  for (const [k, c] of pops) if (c.closed) pops.delete(k) // closed by the shell
  const id = `${LABEL}-${++popSeq}`
  u.hash = `riven-pop=${id}`
  const child = nativeOpen(u.href, target, features)
  if (child) {
    pops.set(id, child)
    sendPopTheme()
    child.close = (): void => {
      pops.delete(id)
      void tauriInvoke('riven_close_popout', { id }).catch(() => {})
    }
  }
  return child
}) as typeof window.open

// A popout's title bar is native and shows the window's background, so the
// shell is told the opener's theme: on open, and on every theme change while
// a popout is up (applyTheme restyles <html> inline and stamps the mode).
let themeQueued = false
function sendPopTheme(): void {
  if (themeQueued) return
  themeQueued = true
  queueMicrotask(() => {
    themeQueued = false
    const probe = document.createElement('i')
    probe.style.cssText = 'position:absolute;display:none;color:var(--bg)'
    document.documentElement.appendChild(probe)
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? []
    probe.remove()
    if (rgb.length < 3) return
    const hex = `#${rgb
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')}`
    const mode = document.documentElement.getAttribute('data-theme-mode') ?? 'dark'
    void tauriInvoke('riven_pop_theme', { color: hex, mode }).catch(() => {})
  })
}
new MutationObserver(() => {
  const o = document.documentElement
  for (const [k, c] of pops) {
    if (c.closed) {
      pops.delete(k)
      continue
    }
    // The popout copied the theme once when it loaded (the shell's
    // POPOUT_THEME); keep it in step.
    try {
      const d = c.document.documentElement
      d.style.cssText = o.style.cssText
      d.style.background = 'var(--bg)'
      const m = o.getAttribute('data-theme-mode')
      if (m) d.setAttribute('data-theme-mode', m)
      else d.removeAttribute('data-theme-mode')
    } catch {
      /* not loaded yet */
    }
  }
  if (pops.size) sendPopTheme()
}).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme-mode'] })

// ---- Observers across windows -------------------------------------------------

// dockview moves a popped-out group's DOM into the popout's document, but a
// WebKit IntersectionObserver or ResizeObserver only sees targets in its own
// document: one made here reports a moved terminal as never visible and never
// sized, so it never opens. Watch each target with an observer from the window
// it lives in, and follow it when it moves (the old observer reports it gone
// first).
type Entry = { target: Element }
type Obs<E> = { observe(el: Element, o?: unknown): void; unobserve(el: Element): void; disconnect(): void } & {
  takeRecords?(): E[]
}
type Ctor<E> = new (cb: (es: E[]) => void, opts?: unknown) => Obs<E>
class CrossWindow<E extends Entry> {
  private inner = new Map<Window, Obs<E>>()
  private where = new Map<Element, [Window, unknown]>()
  constructor(
    private native: Ctor<E>,
    private name: 'IntersectionObserver' | 'ResizeObserver',
    private cb: (es: E[], o: unknown) => void,
    private opts?: unknown
  ) {}
  realm(win: Window): Obs<E> {
    let o = this.inner.get(win)
    if (!o) {
      // This window's own constructor is the wrapper below; popouts have no preload.
      const C = win === w ? this.native : (((win as unknown as Record<string, Ctor<E>>)[this.name]) ?? this.native)
      o = new C((es) => this.fire(es), this.opts)
      this.inner.set(win, o)
    }
    return o
  }
  private fire(es: E[]): void {
    const out: E[] = []
    for (const e of es) {
      const now = e.target.ownerDocument.defaultView
      const was = this.where.get(e.target)
      if (!was) continue // unobserved since
      if (now && now !== was[0]) {
        this.inner.get(was[0])?.unobserve(e.target)
        if (was[0].closed) this.inner.delete(was[0])
        this.where.set(e.target, [now, was[1]])
        this.realm(now).observe(e.target, was[1]) // reports from where it is now
      } else out.push(e)
    }
    if (out.length) this.cb(out, this)
  }
  observe(el: Element, o?: unknown): void {
    const win = el.ownerDocument.defaultView ?? w
    const was = this.where.get(el)
    if (was && was[0] !== win) this.inner.get(was[0])?.unobserve(el)
    this.where.set(el, [win, o])
    this.realm(win).observe(el, o)
  }
  unobserve(el: Element): void {
    const was = this.where.get(el)
    if (was) this.inner.get(was[0])?.unobserve(el)
    this.where.delete(el)
  }
  disconnect(): void {
    for (const o of this.inner.values()) o.disconnect()
    this.inner.clear()
    this.where.clear()
  }
  takeRecords(): E[] {
    return [...this.inner.values()].flatMap((o) => o.takeRecords?.() ?? [])
  }
}

const NativeIO = window.IntersectionObserver
class CrossWindowIO extends CrossWindow<IntersectionObserverEntry> {
  readonly root = null
  readonly rootMargin: string
  readonly thresholds: ReadonlyArray<number>
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    super(NativeIO as unknown as Ctor<IntersectionObserverEntry>, 'IntersectionObserver', cb as never, opts)
    const probe = this.realm(w) as unknown as IntersectionObserver
    this.rootMargin = probe.rootMargin
    this.thresholds = probe.thresholds
  }
}
window.IntersectionObserver = function (cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
  // An explicit root pins the observer to that root's document anyway.
  return opts?.root ? new NativeIO(cb, opts) : new CrossWindowIO(cb, opts)
} as unknown as typeof IntersectionObserver
window.IntersectionObserver.prototype = NativeIO.prototype

const NativeRO = window.ResizeObserver
window.ResizeObserver = function (cb: ResizeObserverCallback) {
  return new CrossWindow(NativeRO as unknown as Ctor<ResizeObserverEntry>, 'ResizeObserver', cb as never)
} as unknown as typeof ResizeObserver
window.ResizeObserver.prototype = NativeRO.prototype

// ---- requestAnimationFrame while hidden ---------------------------------------

// Code running here schedules frames on this window, and WebKit stops this
// window's frames while it is hidden (covered, minimized), even when the work is
// for a popout on screen: a terminal popped out over a covered main window then
// never finishes opening. While hidden, take the frame from a popout that shows.
const nativeRaf = window.requestAnimationFrame.bind(window)
const nativeCaf = window.cancelAnimationFrame.bind(window)
let rafSeq = 0
const rafs = new Map<number, [Window, number]>()
window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  let host: Window = w
  if (document.hidden) {
    for (const p of pops.values()) {
      if (!p.closed && !p.document.hidden) {
        host = p
        break
      }
    }
  }
  if (host === w) return nativeRaf(cb)
  const id = --rafSeq // negative, never a native id
  // A popout's frame time counts from that popout's own time origin.
  const shift = host.performance.timeOrigin - performance.timeOrigin
  rafs.set(id, [
    host,
    host.requestAnimationFrame((t) => {
      rafs.delete(id)
      cb(t + shift)
    })
  ])
  return id
}
window.cancelAnimationFrame = (id: number): void => {
  const r = rafs.get(id)
  if (!r) return nativeCaf(id)
  rafs.delete(id)
  if (!r[0].closed) r[0].cancelAnimationFrame(r[1])
}

document.addEventListener(
  'click',
  (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || e.defaultPrevented) return
    const external = a.target === '_blank' || e.metaKey || a.origin !== location.origin
    if (external && /^https?:/.test(a.href)) {
      e.preventDefault()
      void tauriInvoke('shell_open_external', { url: a.href }).catch(() => {})
    }
  },
  false
)

// ---- drag regions -------------------------------------------------------------

// Electron reads `-webkit-app-region` from the stylesheet; WebKit drops the
// property while parsing, so it never reaches the CSSOM. Read the rules from
// the CSS source instead and drag the window ourselves on mousedown.
let dragSel = ''
let noDragSel = ''
const INTERACTIVE = 'button, input, textarea, select, a[href], [contenteditable=""], [contenteditable="true"]'

// Parsed once per <style>/<link>; lazily loaded chunks add theirs later.
const drag: string[] = []
const noDrag: string[] = []
const scanned = new WeakSet<Node>()

async function cssOf(el: Element): Promise<string> {
  if (el instanceof HTMLStyleElement) return el.textContent ?? ''
  try {
    return await (await fetch((el as HTMLLinkElement).href)).text()
  } catch {
    return '' // not ours
  }
}

async function loadRegions(els: Iterable<Element>): Promise<void> {
  const fresh = [...els].filter((el) => !scanned.has(el) && (el instanceof HTMLStyleElement || el.matches('link[rel="stylesheet"][href]')))
  if (!fresh.length) return
  for (const el of fresh) scanned.add(el)
  const rule = /([^{}]+)\{([^{}]*)\}/g
  let changed = false
  for (const t of await Promise.all(fresh.map(cssOf))) {
    if (!t.includes('-webkit-app-region')) continue
    const css = t.replace(/\/\*[\s\S]*?\*\//g, '')
    let m: RegExpExecArray | null
    while ((m = rule.exec(css))) {
      const v = /-webkit-app-region\s*:\s*(no-drag|drag)/.exec(m[2])
      if (!v) continue
      const sel = m[1].trim()
      if (!sel || sel.startsWith('@')) continue
      ;(v[1] === 'drag' ? drag : noDrag).push(sel)
      changed = true
    }
  }
  if (!changed) return
  dragSel = validSelectors(drag)
  noDragSel = validSelectors(noDrag)
}

function watchRegions(): void {
  void loadRegions(document.querySelectorAll('link[rel="stylesheet"][href], style'))
  new MutationObserver((recs) => {
    const added: Element[] = []
    for (const r of recs) for (const n of r.addedNodes) if (n instanceof Element) added.push(n)
    if (added.length) void loadRegions(added)
  }).observe(document.head, { childList: true })
}

function validSelectors(list: string[]): string {
  return list
    .filter((s) => {
      try {
        document.querySelector(s)
        return true
      } catch {
        return false
      }
    })
    .join(', ')
}

function regionAt(target: Element | null): boolean {
  // Electron: the innermost element with a region decides; buttons and fields
  // inside a drag region are still meant to be clicked.
  for (let el = target; el && el !== document.documentElement; el = el.parentElement) {
    if (noDragSel && el.matches(noDragSel)) return false
    if (el.matches(INTERACTIVE)) return false
    if (dragSel && el.matches(dragSel)) return true
  }
  return false
}

function tauri(cmd: string, args: Record<string, unknown> = {}): void {
  tauriInvoke(cmd, args).catch((e) => console.warn(`[tauri] ${cmd}`, e))
}

document.addEventListener(
  'mousedown',
  (e) => {
    if (e.button !== 0 || !dragSel || !regionAt(e.target as Element)) return
    if (e.detail === 2) tauri('plugin:window|internal_toggle_maximize', { label: LABEL })
    else tauri('plugin:window|start_dragging', { label: LABEL })
  },
  true
)

// The stylesheets are linked in <head> after this script; wait for them.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchRegions)
else watchRegions()

// WKWebView does not fire beforeunload for a reload or close it was not given
// a user gesture for, but it does fire pagehide. The renderer flushes its
// debounced saves (settings, sessions) on beforeunload, so make sure that runs.
// (Rust's flush before a close or quit checks the same flag.)
w.addEventListener('beforeunload', () => void (w.__rivenUnloading = true))
w.addEventListener('pagehide', () => {
  if (!w.__rivenUnloading) w.dispatchEvent(new Event('beforeunload'))
})

listenRust()
