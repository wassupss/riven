import '../../styles/browser-bookmarks.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import { pathOf } from '../../state/session'
import { contextBus } from '../../bridge/contextBus'
import { attachToWorkspaceAgent } from '../../state/agents'
import { useT } from '../../i18n'
import { useBrowser, activeTab, activeTabId } from '../../state/browser'
import { getSettings } from '../../state/settings'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  X,
  Plus,
  Star,
  Globe,
  MoreVertical,
  History as HistoryIcon,
  Trash2
} from 'lucide-react'

interface Bookmark {
  url: string
  title: string
}
interface HistoryItem {
  url: string
  title: string
  ts: number
}

// Build a favicon URL from a page URL's host (guarding invalid urls). Google's
// s2 endpoint returns a rasterized icon for the domain; the app CSP allows it.
export function faviconUrl(url: string): string {
  try {
    const host = new URL(url).host
    if (!host) return ''
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

// Favicon image with a graceful fallback to the lucide Globe icon (on load
// error or when the url has no derivable host).
function Favicon({ url, size = 16 }: { url: string; size?: number }): JSX.Element {
  const [err, setErr] = useState(false)
  const src = faviconUrl(url)
  if (err || !src) return <Globe size={size} className="bm-fav" />
  return (
    <img
      className="bm-fav"
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setErr(true)}
    />
  )
}

// Turn an address-bar entry into a URL: keep full URLs, prepend a scheme for
// hosts (localhost:3000, example.com), and treat plain words as a web search.
export function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s) || /^(file|about|data):/i.test(s)) return s
  const looksLikeHost = /^localhost([:/]|$)/i.test(s) || /^[\w-]+(\.[\w-]+)+([:/]|$)/.test(s)
  if (looksLikeHost) return 'http://' + s
  const tmpl = getSettings().browserSearch || 'https://www.google.com/search?q={q}'
  return tmpl.replace('{q}', encodeURIComponent(s))
}

export default function PreviewPanel({
  workspace,
  api
}: {
  workspace: string
  api?: DockviewPanelApi
}): JSX.Element {
  const t = useT()
  const ws = useBrowser((s) => s.byWs[workspace])
  const ensureWs = useBrowser((s) => s.ensureWs)
  const newTab = useBrowser((s) => s.newTab)
  const closeTab = useBrowser((s) => s.closeTab)
  const selectTab = useBrowser((s) => s.selectTab)
  const navigateTab = useBrowser((s) => s.navigate)
  const goTab = useBrowser((s) => s.go)

  const tabs = ws?.tabs ?? []
  const activeId = ws?.activeId ?? null
  const active = tabs.find((tb) => tb.id === activeId) ?? null
  const isStart = !active || !active.view // blank new-tab page

  const [addr, setAddr] = useState('')
  const [editing, setEditing] = useState(false)
  const [finding, setFinding] = useState(false)
  const [findText, setFindText] = useState('')
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastSent = useRef('')
  // The omnibox dropdown is drawn by a NATIVE overlay view (renderer DOM can't
  // paint above a WebContentsView), positioned right under the address bar.
  const addrWrapRef = useRef<HTMLDivElement | null>(null)
  const [suggestIndex, setSuggestIndex] = useState(0)

  // Keep native context menus in the current UI language.
  useEffect(() => {
    window.api.browser.setLang(getSettings().language === 'en' ? 'en' : 'ko')
  }, [])

  useEffect(() => {
    ensureWs(workspace)
    if ((useBrowser.getState().byWs[workspace]?.tabs.length ?? 0) === 0) newTab(workspace)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  useEffect(() => {
    if (!editing) setAddr(active?.url ?? '')
  }, [active?.url, editing])

  const loadStore = useCallback(async () => {
    const [b, h] = await Promise.all([window.api.browser.bookmarks(), window.api.browser.history()])
    setBookmarks(b)
    setHistory(h)
  }, [])

  useEffect(() => {
    void loadStore()
    return window.api.browser.onEvent((e) => {
      if (e.kind === 'store') void loadStore()
      // Right-click menu actions routed back from the page's native context menu.
      else if (e.kind === 'agent-action') {
        if (e.action === 'capture') void captureToClaude()
        else if (e.action === 'pick') void pickElementToChat()
        else if (e.action === 'find') setFinding(true)
        else if (e.action === 'selection' && e.text)
          sendToChat(`${t('preview.selectionNote')} (${active?.url ?? ''})\n"""${String(e.text)}"""`)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadStore, workspace, activeId, active?.url])

  const syncBounds = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // Also require the dock panel itself to be the visible tab of its group — the
    // WebContentsView is a native overlay that keeps painting on top when this
    // panel becomes an inactive tab (e.g. a terminal opened beside it), so we must
    // explicitly hide it then instead of relying on the viewport rect alone.
    const panelVisible = api ? api.isVisible : true
    const visible =
      panelVisible && r.width > 2 && r.height > 2 && document.visibilityState !== 'hidden'
    const id = activeTabId(workspace)
    const tab = activeTab(workspace)
    // Hide all views on the blank start page (no view for this tab).
    const payload =
      visible && id && tab?.view
        ? { activeId: id, rect: { x: r.left, y: r.top, width: r.width, height: r.height } }
        : { activeId: null, rect: null }
    const key = JSON.stringify(payload)
    if (key === lastSent.current) return
    lastSent.current = key
    window.api.browser.sync(payload.activeId, payload.rect, { w: window.innerWidth, h: window.innerHeight })
  }, [workspace, api])

  // Re-sync the moment this panel is shown/hidden or made the active tab, so the
  // native view appears/disappears immediately (not on the next 250ms poll).
  useEffect(() => {
    if (!api) return
    const onChange = (): void => {
      lastSent.current = ''
      syncBounds()
    }
    const subs = [api.onDidVisibilityChange(onChange), api.onDidActiveChange(onChange)]
    return () => subs.forEach((s) => s.dispose())
  }, [api, syncBounds])

  useEffect(() => {
    syncBounds()
    const ro = new ResizeObserver(syncBounds)
    if (viewportRef.current) ro.observe(viewportRef.current)
    const id = setInterval(syncBounds, 250)
    window.addEventListener('resize', syncBounds)
    return () => {
      ro.disconnect()
      clearInterval(id)
      window.removeEventListener('resize', syncBounds)
    }
  }, [syncBounds, tabs.length, activeId, isStart])

  useEffect(() => () => window.api.browser.sync(null, null), [])

  const navigate = (raw: string): void => {
    const url = normalizeUrl(raw)
    if (!url) return
    setSuggestOpen(false)
    if (activeId) navigateTab(workspace, url)
    else newTab(workspace, url)
  }

  const isBookmarked = !!active && bookmarks.some((b) => b.url === active.url)
  const toggleBookmark = async (): Promise<void> => {
    if (!active?.url) return
    if (isBookmarked) await window.api.browser.removeBookmark(active.url)
    else await window.api.browser.addBookmark({ url: active.url, title: active.title || active.url })
  }

  // Deliver browser context to the workspace's agent: prefer a native chat pane
  // (append to its composer), else fall back to a terminal agent via contextBus.
  const sendToChat = (text: string): void => {
    if (!attachToWorkspaceAgent(workspace, text)) contextBus.sendText(workspace, text)
  }

  const captureToClaude = async (): Promise<void> => {
    if (!activeId) return
    const dataUrl = await window.api.browser.capture(activeId)
    if (!dataUrl) return
    const saved = await window.api.bridge.saveCapture(pathOf(workspace), dataUrl)
    sendToChat(`${t('preview.captureNote')} (${active?.url ?? ''})\n${saved}`)
  }

  // Let the user click an element in the page; send its cropped screenshot +
  // selector + markup to the agent so it knows exactly which element is meant.
  const pickElementToChat = async (): Promise<void> => {
    if (!activeId) return
    const r = await window.api.browser.pickElement(activeId)
    if (!r) return
    let line = `${t('preview.pickNote')} \`${r.selector}\` (${active?.url ?? ''})`
    if (r.dataUrl) {
      const saved = await window.api.bridge.saveCapture(pathOf(workspace), r.dataUrl)
      line += `\n${saved}`
    }
    if (r.html) line += `\n\`\`\`html\n${r.html}\n\`\`\``
    sendToChat(line)
  }

  const runFind = (text: string): void => {
    if (activeId) window.api.browser.find(activeId, text)
  }

  // Address-bar suggestions: bookmarks + history matching the typed text.
  const q = addr.trim().toLowerCase()
  const suggestions =
    editing && q
      ? [
          ...bookmarks.filter((b) => b.url.toLowerCase().includes(q) || b.title.toLowerCase().includes(q)),
          ...history.filter((h) => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q))
        ].slice(0, 8)
      : []

  // A WebContentsView is a native layer that ALWAYS paints above renderer DOM, so
  // the suggestions dropdown was drawn underneath the page. Hide the page while the
  // dropdown is open (you're typing an address, not reading the page) and restore it
  // as soon as it closes.
  const suggestVisible = suggestOpen && suggestions.length > 0
  const suggestKey = suggestions.map((x) => x.url).join('|')
  useEffect(() => {
    const el = addrWrapRef.current
    if (!suggestVisible || !el) {
      window.api.browser.suggest(null, [], 0)
      return
    }
    const r = el.getBoundingClientRect()
    const rowH = 30
    window.api.browser.suggest(
      { x: r.left, y: r.bottom + 3, width: r.width, height: Math.min(suggestions.length, 8) * rowH + 8 },
      suggestions.map((x) => ({ url: x.url, title: x.title })),
      suggestIndex
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestVisible, suggestKey, suggestIndex])

  // Clicking a row in the overlay navigates here.
  useEffect(() => {
    return window.api.browser.onSuggestPick((i) => {
      const s = suggestions[i]
      if (s) navigate(s.url)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestKey])

  // Never leave the overlay behind when the panel unmounts/hides.
  useEffect(() => () => window.api.browser.suggest(null, [], 0), [])

  return (
    <div className="browser-panel">
      <div className="browser-tabs">
        {tabs.map((tb) => (
          <div
            key={tb.id}
            className={`browser-tab${tb.id === activeId ? ' active' : ''}`}
            onClick={() => selectTab(workspace, tb.id)}
            title={tb.url || t('browser.newTab')}
          >
            {tb.favicon ? (
              <img className="browser-tab-fav" src={tb.favicon} alt="" />
            ) : (
              <Globe size={12} className="browser-tab-fav" />
            )}
            <span className="browser-tab-title">
              {tb.loading ? '…' : tb.title || tb.url || t('browser.newTabTitle')}
            </span>
            <button
              className="browser-tab-close"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(workspace, tb.id)
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button className="browser-tab-new" title={t('browser.newTab')} onClick={() => newTab(workspace)}>
          <Plus size={13} />
        </button>
      </div>

      <div className="browser-bar">
        <button className="browser-nav" disabled={!active?.canBack} onClick={() => goTab(workspace, 'back')}>
          <ArrowLeft size={14} />
        </button>
        <button className="browser-nav" disabled={!active?.canForward} onClick={() => goTab(workspace, 'forward')}>
          <ArrowRight size={14} />
        </button>
        <button
          className="browser-nav"
          onClick={() => goTab(workspace, active?.loading ? 'stop' : 'reload')}
          title={active?.loading ? t('browser.stop') : t('browser.reload')}
        >
          {active?.loading ? <X size={14} /> : <RotateCw size={13} />}
        </button>
        <div className="browser-addr-wrap" ref={addrWrapRef}>
          <input
            className="url-input browser-addr"
            value={addr}
            placeholder={t('browser.addrPlaceholder')}
            onFocus={() => {
              setEditing(true)
              setSuggestOpen(true)
            }}
            onBlur={() => {
              setEditing(false)
              setTimeout(() => setSuggestOpen(false), 120)
            }}
            onChange={(e) => {
              setAddr(e.target.value)
              setSuggestOpen(true)
              setSuggestIndex(0)
            }}
            onKeyDown={(e) => {
              // Arrow keys move the highlight in the native suggestion overlay;
              // Enter takes the highlighted row (or the typed text when none).
              if (suggestVisible && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                const n = suggestions.length
                setSuggestIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n))
                return
              }
              if (e.key === 'Enter') {
                const picked = suggestVisible ? suggestions[suggestIndex] : null
                navigate(picked ? picked.url : addr)
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') setSuggestOpen(false)
            }}
          />
          {active?.view && (
            <button
              className={`browser-star${isBookmarked ? ' on' : ''}`}
              title={t('browser.bookmark')}
              onClick={toggleBookmark}
            >
              <Star size={13} fill={isBookmarked ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>
        {/* Everything except back/forward/reload lives in this overflow menu — a
            NATIVE popup (the web view paints on top, so an HTML dropdown can't
            show over it without blanking the page). */}
        <button
          className="browser-nav"
          title={t('browser.more')}
          disabled={!active?.view}
          onClick={() => activeId && window.api.browser.barMenu(activeId)}
        >
          <MoreVertical size={15} />
        </button>
      </div>

      {/* Bookmarks bar (Chrome-like): saved sites for one-click nav. Shown only
          when there are bookmarks; add/remove via the address-bar star. */}
      {bookmarks.length > 0 && (
        <div className="browser-bookmarks">
          {bookmarks.map((b) => (
            <button
              key={b.url}
              className="browser-bm"
              title={b.url}
              onClick={() => navigate(b.url)}
              onContextMenu={(e) => {
                e.preventDefault()
                void window.api.browser.removeBookmark(b.url)
              }}
            >
              <Favicon url={b.url} size={15} />
              <span className="browser-bm-title">{b.title || b.url}</span>
            </button>
          ))}
        </div>
      )}

      {finding && (
        <div className="browser-find">
          <input
            className="url-input"
            autoFocus
            value={findText}
            placeholder={t('browser.findPlaceholder')}
            onChange={(e) => {
              setFindText(e.target.value)
              runFind(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runFind(findText)
              else if (e.key === 'Escape') {
                setFinding(false)
                runFind('')
              }
            }}
          />
          <button
            className="browser-nav"
            onClick={() => {
              setFinding(false)
              runFind('')
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Start page (blank tab): bookmarks + recent history. Real pages float over
          this box as a WebContentsView positioned by main. */}
      <div className="browser-viewport" ref={viewportRef}>
        {isStart && (
          <div className="browser-start">
            <div className="browser-start-inner">
              {bookmarks.length > 0 && (
                <div className="browser-start-section">
                  <div className="browser-start-label">
                    <Star size={12} /> {t('browser.bookmarks')}
                  </div>
                  <div className="browser-start-grid">
                    {bookmarks.map((b) => (
                      <button
                        key={b.url}
                        className="browser-start-card"
                        title={b.url}
                        onClick={() => navigate(b.url)}
                      >
                        <Favicon url={b.url} size={32} />
                        <span className="browser-start-card-title">{b.title || hostOf(b.url)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {history.length > 0 && (
                <div className="browser-start-section">
                  <div className="browser-start-label">
                    <span className="browser-start-label-text">
                      <HistoryIcon size={12} /> {t('browser.recent')}
                    </span>
                    <button
                      className="browser-start-clear"
                      title={t('browser.clearHistory')}
                      onClick={() => void window.api.browser.clearHistory()}
                    >
                      <Trash2 size={12} /> {t('browser.clearHistory')}
                    </button>
                  </div>
                  <div className="browser-start-recent">
                    {history.slice(0, 8).map((h) => (
                      <button
                        key={h.url}
                        className="browser-start-recent-item"
                        title={h.url}
                        onClick={() => navigate(h.url)}
                      >
                        <Favicon url={h.url} size={16} />
                        <span className="browser-start-recent-text">
                          <span className="browser-start-recent-title">
                            {h.title || hostOf(h.url)}
                          </span>
                          <span className="browser-start-recent-host">{hostOf(h.url)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {bookmarks.length === 0 && history.length === 0 && (
                <div className="browser-start-hint">{t('browser.startHint')}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
