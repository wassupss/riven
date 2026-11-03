// 'electron' as src/preload sees it in the Tauri build. The preload bundle is
// loaded by a <script> the server puts at the top of every app page, so it runs
// before the page's own scripts, as Electron's preload did, but in the page's
// world (there is no isolated world to bridge from).
//
// ipcRenderer rides a WebSocket to server.ts; sendSync is a synchronous XHR.
import { decode, encode } from './codec'

type W = Window & {
  __RIVEN_T__?: string
  __RIVEN_WIN__?: string
  __RIVEN_MEDIA__?: string
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: unknown) => Promise<unknown>
    metadata?: { currentWindow?: { label?: string } }
  }
}
const w = window as W
const TOKEN = w.__RIVEN_T__ ?? ''
const LABEL = w.__RIVEN_WIN__ ?? w.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? ''
w.__RIVEN_MEDIA__ = `/__riven/media/{}?t=${TOKEN}`

// ---- the socket -------------------------------------------------------------

type Listener = (event: unknown, ...args: unknown[]) => void
const listeners = new Map<string, Listener[]>()
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let nextId = 1
let ws: WebSocket | null = null
let open = false
const queue: string[] = []

function connect(): void {
  ws = new WebSocket(`ws://${location.host}/__riven/ws?t=${TOKEN}&w=${encodeURIComponent(LABEL)}`)
  ws.onopen = (): void => {
    open = true
    for (const q of queue.splice(0)) ws!.send(q)
  }
  ws.onmessage = (e): void => onMessage(String(e.data))
  ws.onclose = (): void => {
    open = false
    ws = null
    // Main never drops a live page; this is the page going away, or Node gone.
    for (const p of pending.values()) p.reject(new Error('riven: connection to main lost'))
    pending.clear()
  }
}

function post(m: unknown): void {
  const s = encode(m)
  if (open && ws) ws.send(s)
  else queue.push(s)
}

function onMessage(s: string): void {
  const m = decode(s) as
    | { t: 'res'; id: number; ok: boolean; val?: unknown; err?: string }
    | { t: 'ev'; ch: string; args: unknown[] }
    | { t: 'eval'; id: number; code: string }
  if (m.t === 'res') {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(m.val)
    else p.reject(new Error(m.err))
  } else if (m.t === 'ev') {
    const ls = listeners.get(m.ch)
    if (!ls) return
    const evt = { sender: ipcRenderer }
    for (const l of [...ls]) {
      try {
        l(evt, ...(m.args ?? []))
      } catch (e) {
        console.error(`[ipc] listener for ${m.ch} threw`, e)
      }
    }
  } else if (m.t === 'eval') {
    Promise.resolve()
      .then(() => (0, eval)(m.code))
      .then(
        (val) => post({ t: 'evalres', id: m.id, ok: true, val }),
        (e: unknown) => post({ t: 'evalres', id: m.id, ok: false, err: String(e) })
      )
  }
}

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      post({ t: 'invoke', id, ch: channel, args })
    })
  },
  send(channel: string, ...args: unknown[]): void {
    post({ t: 'send', ch: channel, args })
  },
  sendSync(channel: string, ...args: unknown[]): unknown {
    const x = new XMLHttpRequest()
    x.open('POST', `/__riven/sync?t=${TOKEN}`, false)
    x.setRequestHeader('content-type', 'application/json')
    try {
      x.send(encode({ label: LABEL, ch: channel, args }))
    } catch {
      return undefined
    }
    if (x.status !== 200) return undefined
    return (decode(x.responseText) as { v: unknown }).v
  },
  on(channel: string, fn: Listener): typeof ipcRenderer {
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

// WebKit gives a dropped File no path. At drop time the paths are still on the
// macOS drag pasteboard, so main reads them (one sync call per file drop) and
// we pair them with the Files: by order when the names line up, else by name.
const dropPaths = new WeakMap<File, string>()
let dropByName = new Map<string, string>()
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1).normalize('NFC')

w.addEventListener(
  'drop',
  (e) => {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!files.length) return
    const paths = (ipcRenderer.sendSync('__riven:dragPaths') as string[] | undefined) ?? []
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

// WKWebView opens no new windows on its own. Hand the URL to main, whose
// setWindowOpenHandler sends real links to the browser.
w.open = ((url?: string | URL): null => {
  ipcRenderer.send('__riven:open', String(url ?? ''))
  return null
}) as typeof window.open

document.addEventListener(
  'click',
  (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || e.defaultPrevented) return
    const external = a.target === '_blank' || e.metaKey || a.origin !== location.origin
    if (external && /^https?:/.test(a.href)) {
      e.preventDefault()
      ipcRenderer.send('__riven:open', a.href)
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
  w.__TAURI_INTERNALS__?.invoke(cmd, args).catch((e) => console.warn(`[tauri] ${cmd}`, e))
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

connect()
