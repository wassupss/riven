import { create } from 'zustand'

// Multi-tab browser state, per workspace. Each tab is backed by a main-process
// WebContentsView (a real Chromium page); this store holds only the chrome-side
// metadata (title/url/loading/history) and drives the views over IPC. The panel
// reports the viewport rect so main can position the active view.

export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  favicon?: string | null
  // false until the tab actually navigates — a blank "new tab" has no
  // WebContentsView yet and shows the React start page instead.
  view: boolean
}

interface WsBrowser {
  tabs: BrowserTab[]
  activeId: string | null
}

interface BrowserState {
  byWs: Record<string, WsBrowser>
  ensureWs: (ws: string) => void
  newTab: (ws: string, url?: string) => string
  closeTab: (ws: string, id: string) => void
  selectTab: (ws: string, id: string) => void
  navigate: (ws: string, url: string) => void
  go: (ws: string, action: 'back' | 'forward' | 'reload' | 'stop') => void
  setMeta: (id: string, meta: Partial<BrowserTab>) => void
}

let tabSeq = 1
const nextTabId = (): string => `wtab-${tabSeq++}`

export const useBrowser = create<BrowserState>((set, get) => ({
  byWs: {},
  ensureWs: (ws) =>
    set((s) => (s.byWs[ws] ? s : { byWs: { ...s.byWs, [ws]: { tabs: [], activeId: null } } })),
  newTab: (ws, url) => {
    const id = nextTabId()
    const hasUrl = !!url
    if (hasUrl) void window.api.browser.create(id, url)
    set((s) => {
      const cur = s.byWs[ws] ?? { tabs: [], activeId: null }
      const tab: BrowserTab = {
        id,
        url: url ?? '',
        title: url ?? '',
        loading: hasUrl,
        canBack: false,
        canForward: false,
        view: hasUrl
      }
      return { byWs: { ...s.byWs, [ws]: { tabs: [...cur.tabs, tab], activeId: id } } }
    })
    return id
  },
  closeTab: (ws, id) => {
    void window.api.browser.destroy(id)
    set((s) => {
      const cur = s.byWs[ws]
      if (!cur) return s
      const idx = cur.tabs.findIndex((t) => t.id === id)
      const tabs = cur.tabs.filter((t) => t.id !== id)
      let activeId = cur.activeId
      if (activeId === id) activeId = tabs[Math.max(0, idx - 1)]?.id ?? tabs[0]?.id ?? null
      return { byWs: { ...s.byWs, [ws]: { tabs, activeId } } }
    })
  },
  selectTab: (ws, id) =>
    set((s) => {
      const cur = s.byWs[ws]
      if (!cur) return s
      return { byWs: { ...s.byWs, [ws]: { ...cur, activeId: id } } }
    }),
  navigate: (ws, url) => {
    const cur = get().byWs[ws]
    if (!cur?.activeId) return
    const tab = cur.tabs.find((tb) => tb.id === cur.activeId)
    if (tab && !tab.view) {
      // First navigation of a blank tab: spin up its WebContentsView now.
      void window.api.browser.create(tab.id, url)
      get().setMeta(tab.id, { view: true, url, loading: true })
    } else {
      void window.api.browser.navigate(cur.activeId, url)
    }
  },
  go: (ws, action) => {
    const cur = get().byWs[ws]
    if (cur?.activeId) void window.api.browser.go(cur.activeId, action)
  },
  setMeta: (id, meta) =>
    set((s) => {
      const byWs = { ...s.byWs }
      for (const ws of Object.keys(byWs)) {
        const cur = byWs[ws]
        const i = cur.tabs.findIndex((t) => t.id === id)
        if (i >= 0) {
          const tabs = cur.tabs.slice()
          tabs[i] = { ...tabs[i], ...meta }
          byWs[ws] = { ...cur, tabs }
          break
        }
      }
      return { byWs }
    })
}))

export function activeTab(ws: string): BrowserTab | undefined {
  const cur = useBrowser.getState().byWs[ws]
  return cur?.tabs.find((t) => t.id === cur.activeId)
}
export function activeTabId(ws: string): string | null {
  return useBrowser.getState().byWs[ws]?.activeId ?? null
}
export function findTabWorkspace(id: string): string | null {
  const byWs = useBrowser.getState().byWs
  for (const ws of Object.keys(byWs)) if (byWs[ws].tabs.some((t) => t.id === id)) return ws
  return null
}

// Subscribe once to main→renderer browser events (navigation/title/loading/…)
// and reflect them into the tab metadata. Call from App on startup.
export function initBrowserEvents(): () => void {
  return window.api.browser.onEvent((e) => {
    const kind = e.kind as string
    const tabId = e.tabId as string | undefined
    if (kind === 'nav' && tabId) {
      useBrowser.getState().setMeta(tabId, {
        url: e.url as string,
        canBack: !!e.canGoBack,
        canForward: !!e.canGoForward
      })
    } else if (kind === 'title' && tabId) {
      useBrowser.getState().setMeta(tabId, { title: e.title as string })
    } else if (kind === 'loading' && tabId) {
      useBrowser.getState().setMeta(tabId, { loading: !!e.loading })
    } else if (kind === 'favicon' && tabId) {
      useBrowser.getState().setMeta(tabId, { favicon: (e.favicon as string) ?? null })
    } else if (kind === 'newtab') {
      // A popup / target=_blank: open it as a new tab in the tab's workspace.
      const ws = tabId ? findTabWorkspace(tabId) : null
      if (ws) useBrowser.getState().newTab(ws, e.url as string)
    }
  })
}
