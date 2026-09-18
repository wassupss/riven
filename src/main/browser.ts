import { ipcMain, WebContentsView, BrowserWindow, session, app, Menu, clipboard } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

// UI language for native context menus (the renderer pushes it via browser:setLang).
let lang: 'ko' | 'en' = 'ko'
const L = (ko: string, en: string): string => (lang === 'ko' ? ko : en)

// Real Chromium browsing surface: each tab is a main-process WebContentsView
// (full WebContents API — downloads, permissions, popups, devtools, zoom,
// discarding), floated over the window at the bounds the renderer's viewport div
// reports. The renderer draws the chrome (tabs/nav) and drives everything by IPC;
// the MCP browser_* tools reach these WebContents directly in the main process.

interface Tab {
  id: string
  view: WebContentsView
}

const tabs = new Map<string, Tab>()
let getWindow: (() => BrowserWindow | null) | null = null
let hiddenAll = false // set while a renderer modal is up (z-order guard)

// ---- bookmarks + history (persisted in userData/browser.json) ----
interface BrowserStore {
  bookmarks: Array<{ url: string; title: string }>
  history: Array<{ url: string; title: string; ts: number }>
}
let store: BrowserStore = { bookmarks: [], history: [] }
const storePath = (): string => path.join(app.getPath('userData'), 'browser.json')
let storeLoaded = false
async function loadStore(): Promise<void> {
  if (storeLoaded) return
  storeLoaded = true
  try {
    store = { bookmarks: [], history: [], ...JSON.parse(await fs.readFile(storePath(), 'utf8')) }
  } catch {
    /* first run */
  }
}
let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveStore(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void fs.writeFile(storePath(), JSON.stringify(store)).catch(() => {})
  }, 300)
}
function recordHistory(url: string, title: string): void {
  if (!/^https?:\/\//i.test(url)) return
  store.history = store.history.filter((h) => h.url !== url)
  store.history.unshift({ url, title: title || url, ts: Date.now() })
  if (store.history.length > 500) store.history.length = 500
  saveStore()
  send('browser:event', { kind: 'store' })
}

function win(): BrowserWindow | null {
  return getWindow?.() ?? null
}

// The window whose renderer sent this message — the only window whose content
// bounds the message's coordinates mean anything against.
function senderWindow(e: { sender: Electron.WebContents }): BrowserWindow | null {
  const w = BrowserWindow.fromWebContents(e.sender)
  return w && !w.isDestroyed() ? w : null
}

function send(channel: string, payload: unknown): void {
  const w = win()
  if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, payload)
}

// canGoBack/Forward moved onto webContents.navigationHistory in newer Electron;
// fall back to the deprecated direct methods so we work across versions.
function navState(wc: Electron.WebContents): { canGoBack: boolean; canGoForward: boolean } {
  const nh = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean } })
    .navigationHistory
  if (nh) return { canGoBack: nh.canGoBack(), canGoForward: nh.canGoForward() }
  const legacy = wc as unknown as { canGoBack(): boolean; canGoForward(): boolean }
  return { canGoBack: legacy.canGoBack(), canGoForward: legacy.canGoForward() }
}

function wireEvents(tab: Tab): void {
  const wc = tab.view.webContents
  const nav = (): void =>
    send('browser:event', { tabId: tab.id, kind: 'nav', url: wc.getURL(), ...navState(wc) })
  wc.on('did-navigate', nav)
  wc.on('did-navigate-in-page', nav)
  wc.on('page-title-updated', (_e, title) =>
    send('browser:event', { tabId: tab.id, kind: 'title', title })
  )
  wc.on('did-start-loading', () =>
    send('browser:event', { tabId: tab.id, kind: 'loading', loading: true })
  )
  wc.on('did-stop-loading', () => {
    send('browser:event', { tabId: tab.id, kind: 'loading', loading: false })
    nav()
    recordHistory(wc.getURL(), wc.getTitle())
  })
  wc.on('page-favicon-updated', (_e, favicons) =>
    send('browser:event', { tabId: tab.id, kind: 'favicon', favicon: favicons[0] ?? null })
  )
  // Right-click menu. A WebContentsView always paints on top of the renderer, so
  // an HTML menu would be hidden behind it — this must be a native Menu. Includes
  // the usual browser actions plus riven's agent hooks (send screenshot/selection
  // to chat, pick an element to send).
  wc.on('context-menu', (_e, params) => {
    const w = win()
    if (!w) return
    const nav = navState(wc)
    const agent = (action: string, text?: string): void =>
      send('browser:event', { tabId: tab.id, kind: 'agent-action', action, text })
    const tpl: Electron.MenuItemConstructorOptions[] = [
      { label: L('뒤로', 'Back'), enabled: nav.canGoBack, click: () => wc.navigationHistory.goBack() },
      { label: L('앞으로', 'Forward'), enabled: nav.canGoForward, click: () => wc.navigationHistory.goForward() },
      { label: L('새로고침', 'Reload'), click: () => wc.reload() },
      { type: 'separator' }
    ]
    if (params.linkURL) {
      tpl.push(
        { label: L('링크 새 탭에서 열기', 'Open link in new tab'), click: () => send('browser:event', { tabId: tab.id, kind: 'newtab', url: params.linkURL }) },
        { label: L('링크 주소 복사', 'Copy link address'), click: () => clipboard.writeText(params.linkURL) }
      )
    }
    if (params.mediaType === 'image' && params.srcURL) {
      tpl.push({ label: L('이미지 주소 복사', 'Copy image address'), click: () => clipboard.writeText(params.srcURL) })
    }
    if (params.selectionText) {
      tpl.push(
        { label: L('복사', 'Copy'), role: 'copy' },
        { label: L('선택 영역 채팅으로 보내기', 'Send selection to chat'), click: () => agent('selection', params.selectionText) }
      )
    }
    if (params.isEditable) {
      tpl.push(
        { label: L('잘라내기', 'Cut'), role: 'cut' },
        { label: L('붙여넣기', 'Paste'), role: 'paste' },
        { label: L('모두 선택', 'Select all'), role: 'selectAll' }
      )
    }
    tpl.push(
      { type: 'separator' },
      { label: L('스크린샷 채팅으로 보내기', 'Send screenshot to chat'), click: () => agent('capture') },
      { label: L('요소 선택해서 보내기', 'Pick an element to send'), click: () => agent('pick') },
      { type: 'separator' },
      { label: L('검사', 'Inspect element'), click: () => wc.inspectElement(params.x, params.y) }
    )
    Menu.buildFromTemplate(tpl).popup({ window: w })
  })
  // target=_blank / window.open → open as a new tab in the panel (Chrome-like).
  wc.setWindowOpenHandler(({ url }) => {
    send('browser:event', { tabId: tab.id, kind: 'newtab', url })
    return { action: 'deny' }
  })
  // A focused WebContentsView swallows keyboard, so the renderer's global
  // shortcuts (⌃⌘arrows pane nav, ⌘T, …) would die while browsing. Forward
  // chords that use Cmd/Ctrl to the renderer's keymap so they keep working.
  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    if (input.meta || input.control)
      send('browser:key', {
        key: input.key,
        code: input.code,
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift
      })
  })
}

function createTab(id: string, url: string, partition?: string): void {
  const w = win()
  if (!w || tabs.has(id)) return
  const view = new WebContentsView({
    webPreferences: { partition: partition || 'persist:riven-browser' }
  })
  const tab: Tab = { id, view }
  tabs.set(id, tab)
  w.contentView.addChildView(view)
  view.setVisible(false)
  wireEvents(tab)
  if (url) void view.webContents.loadURL(url).catch(() => {})
}

export function registerBrowserHandlers(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  void loadStore()

  // Bookmarks + history for the new-tab page and address-bar autocomplete.
  ipcMain.handle('browser:bookmarks', async () => {
    await loadStore()
    return store.bookmarks
  })
  ipcMain.handle('browser:history', async () => {
    await loadStore()
    return store.history.slice(0, 100)
  })
  ipcMain.handle('browser:addBookmark', (_e, b: { url: string; title: string }) => {
    if (!store.bookmarks.some((x) => x.url === b.url)) store.bookmarks.unshift(b)
    saveStore()
    send('browser:event', { kind: 'store' })
  })
  ipcMain.handle('browser:removeBookmark', (_e, url: string) => {
    store.bookmarks = store.bookmarks.filter((x) => x.url !== url)
    saveStore()
    send('browser:event', { kind: 'store' })
  })
  ipcMain.handle('browser:clearHistory', () => {
    store.history = []
    saveStore()
    send('browser:event', { kind: 'store' })
  })

  // Downloads: let Chromium save to the OS default location and tell the renderer.
  session.fromPartition('persist:riven-browser').on('will-download', (_e, item) => {
    send('browser:event', { kind: 'download', filename: item.getFilename() })
    item.once('done', (_ev, state) =>
      send('browser:event', {
        kind: 'download-done',
        filename: item.getFilename(),
        path: item.getSavePath(),
        state
      })
    )
  })

  ipcMain.handle('browser:create', (_e, a: { id: string; url: string; partition?: string }) => {
    createTab(a.id, a.url, a.partition)
  })
  ipcMain.handle('browser:navigate', (_e, a: { id: string; url: string }) => {
    const t = tabs.get(a.id)
    if (t) void t.view.webContents.loadURL(a.url).catch(() => {})
  })
  ipcMain.handle('browser:go', (_e, a: { id: string; action: string }) => {
    const wc = tabs.get(a.id)?.view.webContents
    if (!wc) return
    const nh = (wc as unknown as { navigationHistory?: { goBack(): void; goForward(): void } })
      .navigationHistory
    if (a.action === 'back') nh ? nh.goBack() : (wc as unknown as { goBack(): void }).goBack()
    else if (a.action === 'forward')
      nh ? nh.goForward() : (wc as unknown as { goForward(): void }).goForward()
    else if (a.action === 'reload') wc.reload()
    else if (a.action === 'stop') wc.stop()
  })
  ipcMain.handle('browser:destroy', (_e, a: { id: string }) => {
    const t = tabs.get(a.id)
    if (!t) return
    const w = win()
    try {
      w?.contentView.removeChildView(t.view)
    } catch {
      /* ignore */
    }
    ;(t.view.webContents as unknown as { close?: () => void }).close?.()
    tabs.delete(a.id)
  })
  // The single source of truth for visibility + position: the renderer reports
  // the active tab and the viewport rect; everything else is hidden. rect=null or
  // activeId=null (panel hidden / modal open) hides all.
  // CSS px inside the window → device-independent px, i.e. the UI's zoom factor.
  const uiScale = (w: BrowserWindow): number => {
    const z = w.webContents.getZoomFactor()
    return z > 0 ? z : 1
  }

  // The panel draws a 1px frame around itself, and a native view paints above all
  // renderer DOM — so a page laid out edge to edge ate that frame on three sides.
  // Keep the view just inside it (the top edge is under the toolbar already).
  const VIEW_INSET = 1

  ipcMain.on(
    'browser:sync',
    (
      e,
      a: {
        activeId: string | null
        rect: { x: number; y: number; width: number; height: number } | null
        css?: { w: number; h: number }
      }
    ) => {
      const w = senderWindow(e) ?? win()
      const showId = hiddenAll ? null : a.activeId
      // The renderer measures in CSS px; setBounds wants window DIP. If the web
      // content's CSS viewport differs from the window's DIP content size (page
      // zoom / fractional display scale), scale the rect so the view lands
      // exactly over the panel instead of drifting outside it.
      let sx = 1
      let sy = 1
      if (w && a.css && a.css.w > 0 && a.css.h > 0) {
        const cb = w.getContentBounds()
        sx = cb.width / a.css.w
        sy = cb.height / a.css.h
      }
      // The frame is 1 CSS px of riven's UI, which is more than one device-
      // independent pixel whenever the UI is zoomed.
      const inset = Math.max(1, Math.ceil(VIEW_INSET * sx))
      for (const [id, t] of tabs) {
        const on = id === showId && a.rect != null
        t.view.setVisible(on)
        if (on && a.rect)
          t.view.setBounds({
            x: Math.round(a.rect.x * sx) + inset,
            y: Math.round(a.rect.y * sy),
            width: Math.max(1, Math.round(a.rect.width * sx) - inset * 2),
            height: Math.max(1, Math.round(a.rect.height * sy) - inset)
          })
      }
    }
  )
  // Modal z-order guard: hide every browser view while a renderer overlay is up.
  // ---- address-bar suggestions -------------------------------------------
  //
  // The dropdown has to paint over the page, and the page is a native view which
  // always paints above renderer DOM. Two things were tried and are recorded
  // here so they are not tried again:
  //   · a WebContentsView overlay — it TAKES THE KEYBOARD the moment it is
  //     created (measured), and focusing the window afterwards does not win it
  //     back, so the address bar kept a caret and swallowed every keystroke;
  //   · pushing the page down by the height of the list — the page jumped
  //     around while typing.
  // So the list is its own window, marked `focusable: false`: a window that by
  // construction can never take the keyboard, shown with showInactive() above
  // the app window, over a page that does not move.
  let suggestWin: BrowserWindow | null = null
  const suggestHtml = (items: Array<{ url: string; title: string }>, sel: number, zoom: number): string => {
    const esc = (v: string): string =>
      v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
    const rows = items
      .map(
        (it, i) =>
          `<div class="i${i === sel ? ' on' : ''}" data-i="${i}"><span class="t">${esc(
            it.title || it.url
          )}</span><span class="u">${esc(it.url)}</span></div>`
      )
      .join('')
    return `<!doctype html><meta charset="utf-8"><style>
      :root{color-scheme:dark}
      html,body{margin:0;overflow:hidden;background:transparent}
      body{font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#e7e3df}
      /* The window itself is at 100%; the list is drawn at riven's UI zoom so
         its text is the same size as the app's. */
      #l{zoom:${zoom};background:#17130f;border:1px solid #2f2b26;border-radius:10px;
         overflow:hidden;padding:4px}
      .i{display:flex;gap:10px;align-items:baseline;padding:6px 10px;border-radius:6px;
         cursor:default;white-space:nowrap;line-height:1.35}
      .i:hover{background:#221d18}
      .i.on{background:rgba(217,119,66,.16);box-shadow:inset 2px 0 0 #d97742}
      .t{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
      .u{flex:1 1 auto;min-width:0;color:#9b8f81;overflow:hidden;text-overflow:ellipsis;
         font-size:12px;text-align:right}
    </style><body><div id="l">${rows}</div></body>
    <script>
      document.body.addEventListener('mousedown', function (e) {
        var el = e.target.closest('.i'); if (!el) return;
        // No preload here: report the pick through the title, which main observes.
        document.title = 'pick:' + el.dataset.i + ':' + Date.now();
      });
    </script>`
  }
  const closeSuggest = (): void => {
    if (suggestWin && !suggestWin.isDestroyed()) suggestWin.hide()
  }
  ipcMain.on(
    'browser:suggest',
    (
      e,
      payload: {
        rect: { x: number; y: number; width: number; height: number } | null
        items: Array<{ url: string; title: string }>
        selected: number
      }
    ) => {
      const w = senderWindow(e) ?? win()
      if (!w) return
      if (!payload.rect || payload.items.length === 0) {
        closeSuggest()
        return
      }
      if (!suggestWin || suggestWin.isDestroyed()) {
        suggestWin = new BrowserWindow({
          parent: w,
          frame: false,
          transparent: true,
          hasShadow: false,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          focusable: false,
          show: false,
          webPreferences: { javascript: true }
        })
        suggestWin.setMenuBarVisibility(false)
        suggestWin.webContents.on('page-title-updated', (_ev, title) => {
          const m = /^pick:(\d+):/.exec(title)
          if (m && !e.sender.isDestroyed()) e.sender.send('browser:suggestPick', Number(m[1]))
        })
        // The list belongs to a moment in the parent window; anything that moves
        // it out from under the address bar closes it rather than leaving it
        // floating somewhere wrong.
        w.on('move', closeSuggest)
        w.on('resize', closeSuggest)
        w.on('hide', closeSuggest)
        w.on('minimize', closeSuggest)
        w.on('blur', closeSuggest)
      }
      // The renderer measures in CSS px inside the window; the window's own
      // content origin turns that into screen coordinates.
      const cb = w.getContentBounds()
      const sx = uiScale(w)
      const place = (cssHeight: number): void => {
        if (!suggestWin || suggestWin.isDestroyed() || !payload.rect) return
        suggestWin.setBounds({
          x: Math.round(cb.x + payload.rect.x * sx),
          y: Math.round(cb.y + payload.rect.y * sx),
          width: Math.max(80, Math.round(payload.rect.width * sx)),
          height: Math.max(24, Math.round(cssHeight * sx))
        })
      }
      place(payload.rect.height)
      void suggestWin.webContents
        .loadURL(
          'data:text/html;charset=utf-8,' + encodeURIComponent(suggestHtml(payload.items, payload.selected, sx))
        )
        .then(async () => {
          if (!suggestWin || suggestWin.isDestroyed()) return
          // The window is exactly as tall as the rows it drew — guessing a row
          // height left a strip of empty background under the last one.
          const h = (await suggestWin.webContents
            .executeJavaScript('document.getElementById("l").getBoundingClientRect().height')
            .catch(() => null)) as number | null
          // `h` is already in device-independent px (the list carries the zoom),
          // so it is the window's height as-is.
          if (typeof h === 'number' && h > 0) place(Math.ceil(h) / sx)
          if (suggestWin && !suggestWin.isDestroyed()) suggestWin.showInactive()
        })
    }
  )

  ipcMain.on('browser:hideAll', (_e, hidden: boolean) => {
    hiddenAll = hidden
    if (hidden) for (const t of tabs.values()) t.view.setVisible(false)
    // showing again is driven by the next browser:sync from the panel
  })
  ipcMain.handle('browser:execJs', async (_e, a: { id: string; code: string }) => {
    const wc = tabs.get(a.id)?.view.webContents
    if (!wc) return null
    try {
      return await wc.executeJavaScript(a.code, true)
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`
    }
  })
  ipcMain.handle('browser:capture', async (_e, a: { id: string }) => {
    const wc = tabs.get(a.id)?.view.webContents
    if (!wc) return null
    const img = await wc.capturePage()
    return img.toDataURL()
  })
  ipcMain.handle('browser:state', (_e, a: { id: string }) => {
    const wc = tabs.get(a.id)?.view.webContents
    if (!wc) return null
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      ...navState(wc),
      zoom: wc.getZoomFactor()
    }
  })
  ipcMain.handle('browser:setZoom', (_e, a: { id: string; factor: number }) => {
    const wc = tabs.get(a.id)?.view.webContents
    if (wc) wc.setZoomFactor(a.factor)
  })
  ipcMain.on('browser:find', (_e, a: { id: string; text: string }) => {
    const wc = tabs.get(a.id)?.view.webContents
    if (!wc) return
    if (a.text) wc.findInPage(a.text)
    else wc.stopFindInPage('clearSelection')
  })
  ipcMain.handle('browser:openDevtools', (_e, a: { id: string }) => {
    tabs.get(a.id)?.view.webContents.openDevTools({ mode: 'detach' })
  })
  ipcMain.on('browser:setLang', (_e, l: 'ko' | 'en') => {
    lang = l === 'en' ? 'en' : 'ko'
  })
  // The toolbar overflow menu, as a NATIVE popup (like the right-click menu). Must
  // be native: a WebContentsView always paints on top of the renderer, so an HTML
  // dropdown would be hidden behind the page (and hiding the page to show it just
  // blanks the view). Zoom/devtools/bookmark act here directly; find/capture/pick
  // route back to the renderer.
  ipcMain.handle('browser:barMenu', (_e, a: { id: string }) => {
    const wc = tabs.get(a.id)?.view.webContents
    const w = win()
    if (!wc || !w) return
    const url = wc.getURL()
    const title = wc.getTitle()
    const isBm = store.bookmarks.some((b) => b.url === url)
    const agent = (action: string): void => send('browser:event', { tabId: a.id, kind: 'agent-action', action })
    const tpl: Electron.MenuItemConstructorOptions[] = [
      { label: L('확대', 'Zoom in'), click: () => wc.setZoomFactor(Math.min(3, wc.getZoomFactor() + 0.1)) },
      { label: L('축소', 'Zoom out'), click: () => wc.setZoomFactor(Math.max(0.4, wc.getZoomFactor() - 0.1)) },
      { label: L('배율 초기화', 'Reset zoom'), click: () => wc.setZoomFactor(1) },
      { type: 'separator' },
      { label: L('페이지에서 찾기', 'Find in page'), click: () => agent('find') },
      {
        label: isBm ? L('즐겨찾기 삭제', 'Remove bookmark') : L('즐겨찾기 추가', 'Add bookmark'),
        enabled: /^https?:\/\//i.test(url),
        click: () => {
          if (isBm) store.bookmarks = store.bookmarks.filter((b) => b.url !== url)
          else store.bookmarks.unshift({ url, title: title || url })
          saveStore()
          send('browser:event', { kind: 'store' })
        }
      },
      { label: L('개발자 도구', 'DevTools'), click: () => wc.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
      { label: L('스크린샷 채팅으로 보내기', 'Send screenshot to chat'), click: () => agent('capture') },
      { label: L('요소 선택해서 보내기', 'Pick an element to send'), click: () => agent('pick') }
    ]
    Menu.buildFromTemplate(tpl).popup({ window: w })
  })
  // Element picker: let the user hover + click an element in the page, then return
  // a cropped screenshot of it plus a CSS selector and a snippet of its markup —
  // so the agent can be shown exactly which UI element the user means.
  ipcMain.handle('browser:pickElement', async (_e, a: { id: string }) => {
    const wc = tabs.get(a.id)?.view.webContents
    if (!wc) return null
    let picked: { x: number; y: number; width: number; height: number; selector: string; html: string } | null
    try {
      picked = (await wc.executeJavaScript(PICK_SCRIPT, true)) as typeof picked
    } catch {
      return null
    }
    if (!picked) return null
    const rect = {
      x: Math.max(0, Math.round(picked.x)),
      y: Math.max(0, Math.round(picked.y)),
      width: Math.max(1, Math.round(picked.width)),
      height: Math.max(1, Math.round(picked.height))
    }
    let dataUrl: string | null = null
    try {
      const img = await wc.capturePage(rect)
      dataUrl = img.toDataURL()
    } catch {
      dataUrl = null
    }
    return { dataUrl, selector: picked.selector, html: picked.html }
  })
}

// Injected into the page: overlays a highlight that follows the cursor and
// resolves with the clicked element's rect/selector/markup. Esc cancels (null).
const PICK_SCRIPT = `(() => new Promise((resolve) => {
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', zIndex: 2147483647, pointerEvents: 'none',
    border: '2px solid #e0662f', background: 'rgba(224,102,47,0.12)',
    borderRadius: '2px', transition: 'all 40ms ease', boxShadow: '0 0 0 1px rgba(0,0,0,0.4)'
  });
  const tip = document.createElement('div');
  Object.assign(tip.style, {
    position: 'fixed', zIndex: 2147483647, pointerEvents: 'none',
    font: '11px ui-monospace, monospace', color: '#fff', background: '#e0662f',
    padding: '2px 6px', borderRadius: '3px', maxWidth: '60vw', whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis'
  });
  document.body.appendChild(box); document.body.appendChild(tip);
  let cur = null;
  const sel = (el) => {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + el.id;
    let s = el.tagName.toLowerCase();
    if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    return s;
  };
  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tip) return;
    cur = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    tip.textContent = sel(el);
    tip.style.left = r.left + 'px';
    tip.style.top = Math.max(0, r.top - 20) + 'px';
  };
  const cleanup = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove(); tip.remove();
  };
  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = cur; cleanup();
    if (!el) return resolve(null);
    const r = el.getBoundingClientRect();
    resolve({ x: r.left, y: r.top, width: r.width, height: r.height, selector: sel(el), html: el.outerHTML.slice(0, 600) });
  };
  const onKey = (e) => { if (e.key === 'Escape') { cleanup(); resolve(null); } };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}))()`

// For MCP browser tools that run in the main process (see mcpServer.ts).
export function browserTabIds(): string[] {
  return [...tabs.keys()]
}
export async function browserExec(id: string, code: string): Promise<unknown> {
  const wc = tabs.get(id)?.view.webContents
  if (!wc) return null
  return wc.executeJavaScript(code, true).catch((e) => `error: ${String(e)}`)
}
