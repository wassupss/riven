import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { registerPaneFocuser, registerPaneClearer, setFocusRegion } from '../keybindings/focus'
import { useSettings, getSettings } from '../state/settings'

// The terminal palette derives from the active app theme (CSS vars) so the
// terminal is part of the same visual system and recolors on theme switch —
// instead of a stale saved color floating on a mismatched panel background.
function terminalTheme(): ITheme {
  const s = getComputedStyle(document.documentElement)
  const v = (n: string, f: string): string => s.getPropertyValue(n).trim() || f
  const bg = v('--bg', '#101113')
  const fg = v('--fg', '#e3e5ea')
  const dim = v('--fg-dim', '#868d98')
  const accent = v('--accent', '#ff7847')
  const light = document.documentElement.dataset.themeMode === 'light'
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: light ? 'rgba(0, 0, 0, 0.14)' : 'rgba(255, 255, 255, 0.16)',
    black: '#2a2e35',
    red: v('--danger', '#e5534b'),
    green: v('--success', '#4cc38a'),
    yellow: v('--warning', '#e2b053'),
    blue: v('--info', '#5eb1ef'),
    magenta: v('--accent-2', '#a18fff'),
    cyan: '#3ec5b7',
    white: dim,
    brightBlack: '#5a616b',
    brightRed: '#ff6b63',
    brightGreen: '#6ad39b',
    brightYellow: '#f0c56a',
    brightBlue: '#7cc4f5',
    brightMagenta: '#b9a9ff',
    brightCyan: '#5fd6c9',
    brightWhite: fg
  }
}

export interface TerminalPaneProps {
  sessionKey: string
  cwd: string
  shell?: string
  args?: string[]
  paneId?: number
  initialCommand?: string
  onReady?: (ptyId: string) => void
  onFocus?: () => void
}

// Delay before a hidden+idle terminal releases its xterm renderer.
const VIRTUALIZE_DELAY_MS = 4000

export default function TerminalPane({
  sessionKey,
  cwd,
  paneId,
  initialCommand,
  onReady,
  onFocus
}: TerminalPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const searchRef = useRef<SearchAddon | null>(null)
  const refocusRef = useRef<(() => void) | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // --- xterm lifecycle (creatable/disposable independently of the PTY) -------
    // The PTY lives in main and survives; only the renderer-side xterm (WebGL
    // context + scrollback) is virtualized. Returns a teardown that disposes the
    // renderer but leaves the PTY running.
    let teardown: (() => void) | null = null

    const mountTerminal = (): (() => void) => {
      const cfg = getSettings()
      const term = new Terminal({
        fontFamily: cfg.terminalFontFamily,
        fontSize: cfg.terminalFontSize,
        fontWeight: '300',
        fontWeightBold: '500',
        cursorBlink: true,
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        allowProposedApi: true,
        scrollback: 5000,
        minimumContrastRatio: 4.5,
        drawBoldTextInBrightColors: true,
        macOptionClickForcesSelection: true,
        scrollSensitivity: 1.15,
        fastScrollSensitivity: 5,
        theme: terminalTheme()
      })
      const fit = new FitAddon()
      const serialize = new SerializeAddon()
      const unicode11 = new Unicode11Addon()
      const search = new SearchAddon()
      term.loadAddon(fit)
      term.loadAddon(serialize)
      term.loadAddon(unicode11)
      term.loadAddon(search)
      searchRef.current = search
      refocusRef.current = () => term.focus()
      term.unicode.activeVersion = '11'
      term.open(container)

      // ⌘F opens the in-terminal find box (don't forward the key to the shell).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          setSearchOpen(true)
          return false
        }
        return true
      })

      let ptyId: string | null = null
      let torn = false
      const disposers: Array<() => void> = []

      let snapTimer: ReturnType<typeof setTimeout> | null = null
      const scheduleSnapshot = (id: string): void => {
        if (snapTimer) clearTimeout(snapTimer)
        // Coarse debounce: this periodic snapshot is only a crash-recovery backup
        // (normal reload/⌘R and teardown snapshot on unmount), so serializing the
        // whole screen every ~2s during streaming is plenty and far cheaper.
        snapTimer = setTimeout(() => {
          try {
            window.api.pty.snapshot(id, serialize.serialize({ scrollback: 400 }))
          } catch {
            /* serialize can throw on dispose */
          }
        }, 2000)
      }

      let webgl: WebglAddon | null = null
      let webglTried = false
      const tryAttachWebgl = (): void => {
        if (webglTried || torn) return
        if (!container.clientWidth || !container.clientHeight) return
        webglTried = true
        try {
          const addon = new WebglAddon()
          addon.onContextLoss(() => {
            addon.dispose()
            webgl = null
          })
          term.loadAddon(addon)
          webgl = addon
        } catch {
          webgl = null
        }
      }

      let lastPtyCols = 0
      let lastPtyRows = 0
      const syncPtySize = (): void => {
        if (!ptyId) return
        if (term.cols === lastPtyCols && term.rows === lastPtyRows) return
        lastPtyCols = term.cols
        lastPtyRows = term.rows
        window.api.pty.resize(ptyId, term.cols, term.rows)
      }

      const safeFit = (): void => {
        const rect = container.getBoundingClientRect()
        if (rect.width < 48 || rect.height < 24) return
        let dims: { cols: number; rows: number } | undefined
        try {
          dims = fit.proposeDimensions()
        } catch {
          return
        }
        if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
        const cols = Math.max(8, dims.cols)
        const rows = Math.max(4, dims.rows)
        if (cols !== term.cols || rows !== term.rows) {
          try {
            term.resize(cols, rows)
          } catch {
            return
          }
        }
        syncPtySize()
        tryAttachWebgl()
      }

      safeFit()

      ;(async () => {
        const { id, existed, buffer } = await window.api.pty.open({
          sessionKey,
          cwd,
          initialCommand,
          cols: term.cols,
          rows: term.rows
        })
        if (torn) return
        ptyId = id
        if (existed && buffer) term.write(buffer)
        onReadyRef.current?.(id)
        disposers.push(
          window.api.pty.onData(id, (data) => {
            term.write(data)
            scheduleSnapshot(id)
          })
        )
        disposers.push(() => snapTimer && clearTimeout(snapTimer))
        disposers.push(
          window.api.pty.onExit(id, () => term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'))
        )
        term.onData((data) => window.api.pty.write(id, data))
        safeFit()
        if (existed) setTimeout(safeFit, 60)
      })()

      disposers.push(
        useSettings.subscribe(() => {
          const s = getSettings()
          term.options.fontFamily = s.terminalFontFamily
          term.options.fontSize = s.terminalFontSize
          requestAnimationFrame(() => {
            term.options.theme = terminalTheme()
          })
          safeFit()
        })
      )

      const raf = requestAnimationFrame(safeFit)
      const t1 = setTimeout(safeFit, 60)
      const t2 = setTimeout(safeFit, 300)
      let fitDebounce: ReturnType<typeof setTimeout> | null = null
      const ro = new ResizeObserver(() => {
        if (fitDebounce) clearTimeout(fitDebounce)
        fitDebounce = setTimeout(safeFit, 110)
      })
      ro.observe(container)

      const onFocusIn = (): void => {
        if (paneId != null) setFocusRegion({ kind: 'terminal', paneId })
        onFocusRef.current?.()
      }
      container.addEventListener('focusin', onFocusIn)
      if (paneId != null) {
        disposers.push(registerPaneFocuser(paneId, () => term.focus()))
        disposers.push(registerPaneClearer(paneId, () => term.clear()))
      }

      return () => {
        torn = true
        cancelAnimationFrame(raf)
        clearTimeout(t1)
        clearTimeout(t2)
        if (fitDebounce) clearTimeout(fitDebounce)
        ro.disconnect()
        container.removeEventListener('focusin', onFocusIn)
        // Persist the current screen so the PTY reconnect replays cleanly later.
        if (ptyId) {
          try {
            window.api.pty.snapshot(ptyId, serialize.serialize({ scrollback: 400 }))
          } catch {
            /* ignore */
          }
        }
        disposers.forEach((d) => d())
        searchRef.current = null
        refocusRef.current = null
        webgl?.dispose()
        term.dispose()
      }
    }

    // --- visibility + idle → mount / release the renderer ----------------------
    let visible = false
    let agent = false
    let busy = false
    let hideTimer: ReturnType<typeof setTimeout> | null = null

    const reconcile = (): void => {
      // Keep the renderer alive while visible OR while an agent is working (so its
      // output is captured even in a background workspace). Release it only when
      // hidden AND idle, after a short grace period.
      const shouldMount = visible || agent || busy
      if (shouldMount) {
        if (hideTimer) {
          clearTimeout(hideTimer)
          hideTimer = null
        }
        if (!teardown) teardown = mountTerminal()
      } else {
        if (hideTimer || !teardown) return
        hideTimer = setTimeout(() => {
          hideTimer = null
          if (!visible && !agent && !busy && teardown) {
            teardown()
            teardown = null
          }
        }, VIRTUALIZE_DELAY_MS)
      }
    }

    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1]
      visible = e.isIntersecting && e.intersectionRatio > 0
      reconcile()
    })
    io.observe(container)
    // IntersectionObserver fires async; if we're already laid out and visible,
    // mount promptly so the PTY spawns without waiting for the first callback.
    if (container.getBoundingClientRect().width > 0) {
      visible = true
      reconcile()
    }

    const offStatus = window.api.pty.onStatus(({ key, busy: b }) => {
      if (key !== sessionKey) return
      busy = b
      reconcile()
    })
    const offAgent = window.api.pty.onAgent(({ key, agent: a }) => {
      if (key !== sessionKey) return
      agent = a
      reconcile()
    })

    return () => {
      io.disconnect()
      offStatus()
      offAgent()
      if (hideTimer) clearTimeout(hideTimer)
      teardown?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const findNext = (back: boolean): void => {
    if (!query) return
    if (back) searchRef.current?.findPrevious(query)
    else searchRef.current?.findNext(query)
  }
  const closeSearch = (): void => {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    refocusRef.current?.()
  }

  return (
    <div className="terminal-pane-outer">
      <div className="terminal-pane" ref={containerRef} />
      {searchOpen && (
        <div className="term-search">
          <input
            className="term-search-input"
            autoFocus
            value={query}
            placeholder="찾기"
            onChange={(e) => {
              setQuery(e.target.value)
              searchRef.current?.findNext(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                findNext(e.shiftKey)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeSearch()
              }
            }}
          />
          <button className="term-search-btn" title="이전" onClick={() => findNext(true)}>
            <ChevronUp size={13} />
          </button>
          <button className="term-search-btn" title="다음" onClick={() => findNext(false)}>
            <ChevronDown size={13} />
          </button>
          <button className="term-search-btn" title="닫기" onClick={closeSearch}>
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
