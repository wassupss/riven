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
    // Scroll preservation across workspace switches. Hiding a workspace with
    // display:none zeroes the .xterm-viewport scrollTop, so returning strands the
    // terminal at the top of its scrollback. Remember the scroll on hide and
    // restore it on show (only for a still-mounted term; a torn-down/remounted one
    // restores via the snapshot replay below).
    let liveTerm: Terminal | null = null
    let hiddenTerm: Terminal | null = null
    let savedViewportY: number | null = null
    let savedAtBottom = false

    const mountTerminal = (): (() => void) => {
      const cfg = getSettings()
      const term = new Terminal({
        fontFamily: cfg.terminalFontFamily,
        fontSize: cfg.terminalFontSize,
        // Regular/bold (400/700), NOT the old 300/500: the system Korean fallback
        // (Apple SD Gothic Neo) has no 300 weight, so forcing 300 made Korean
        // render at 400 and look much bolder than the light Latin — the mismatch.
        // Matching both at 400 mirrors Ghostty/cmux.
        fontWeight: '400',
        fontWeightBold: '700',
        // No extra letter spacing (Ghostty adds none); a touch of line height.
        letterSpacing: 0,
        lineHeight: 1.25,
        cursorBlink: true,
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        allowProposedApi: true,
        scrollback: 5000,
        // minimumContrastRatio > 1 makes xterm recompute a contrast-adjusted color
        // for every cell on every render (documented CPU/memory cost) — it was the
        // cause of the lag on a busy prompt redraw. Ghostty does no runtime contrast
        // adjustment either, so 1 (disabled) matches native and renders far faster.
        minimumContrastRatio: 1,
        drawBoldTextInBrightColors: true,
        macOptionClickForcesSelection: true,
        scrollSensitivity: 1.15,
        fastScrollSensitivity: 5,
        theme: terminalTheme()
      })
      liveTerm = term
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

      // Defer term.open() until the pane actually has size. Opening into a 0-size
      // container (a stacked/background dock panel, or before dockview lays it out)
      // makes xterm's renderer schedule a paint with no measured dimensions and
      // throw in its viewport sync. We open on the first non-zero size instead;
      // until then onData buffers (see isRenderable/pendingHidden below).
      let opened = false
      // Returns true only on the call that actually opens, so the caller can defer
      // the first resize by a frame — xterm measures its render dimensions on the
      // first paint (async), and resizing before that throws in syncScrollArea.
      const ensureOpened = (): boolean => {
        if (opened || !container.isConnected || !container.clientWidth || !container.clientHeight)
          return false
        opened = true
        term.open(container)
        // Expose the terminal font to CSS so the IME composition overlay (a separate
        // DOM element xterm doesn't font-style) matches the grid — otherwise Korean
        // shows a fallback font while composing and only snaps to D2Coding on commit.
        container.style.setProperty('--term-font', cfg.terminalFontFamily)
        container.style.setProperty('--term-font-size', `${cfg.terminalFontSize}px`)
        // The canvas/webgl renderer measures glyphs at init; if a bundled webfont
        // (D2Coding) isn't loaded yet it measures the fallback and Korean looks off
        // until a reflow. Re-render once fonts are ready so it picks up the real
        // metrics. (No-op when the font is already installed/loaded.)
        document.fonts?.ready
          .then(() => {
            if (!opened || !container.isConnected) return
            try {
              term.refresh(0, term.rows - 1)
            } catch {
              /* repainted by a later fit */
            }
          })
          .catch(() => {})
        return true
      }

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
        // DIAGNOSTIC: skip WebGL to isolate whether the "blank rows on fast scroll"
        // artifact is the WebGL renderer. Toggle in devtools:
        //   localStorage.setItem('riven.noWebgl','1')  → DOM renderer, then ⌘R
        //   localStorage.removeItem('riven.noWebgl')   → WebGL again, then ⌘R
        if (localStorage.getItem('riven.noWebgl') === '1') {
          webglTried = true
          return
        }
        if (!container.clientWidth || !container.clientHeight) return
        webglTried = true
        try {
          const addon = new WebglAddon()
          addon.onContextLoss(() => {
            addon.dispose()
            webgl = null
            // Disposing the WebGL addon reverts xterm to its DOM renderer, but an
            // idle full-screen TUI (no new output) won't trigger a redraw and would
            // stay blank. Force a full repaint so the screen comes back without a
            // ⌘R. We deliberately do NOT re-attach WebGL (webglTried stays true):
            // once the GPU context is unstable, the DOM renderer is the reliable
            // fallback for the rest of the session.
            try {
              term.refresh(0, term.rows - 1)
            } catch {
              /* term may be mid-dispose */
            }
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

      // While the pane is hidden (0-size, e.g. a stacked/background dock panel) we
      // must NOT write to xterm: it throws in its viewport sync (no render
      // dimensions) and, worse, rendering there can't keep up with a flood so the
      // main->renderer IPC queue explodes (measured 16GB). Instead we hold recent
      // output in a capped ring and ack immediately — main stays drained and a
      // background agent keeps running — then replay it once the pane is shown.
      const HIDDEN_CAP = 256 * 1024
      let pendingHidden = ''
      const isRenderable = (): boolean =>
        opened && container.isConnected && container.clientWidth > 0 && container.clientHeight > 0
      const flushHidden = (): void => {
        if (!isRenderable()) return
        if (pendingHidden) {
          const b = pendingHidden
          pendingHidden = ''
          try {
            term.write(b, () => term.scrollToBottom())
          } catch {
            /* will retry on the next fit once measured */
          }
        }
        // We withheld acks while hidden (backpressure paused the PTY at the source);
        // now that we're visible again, drain the in-flight count and resume.
        if (ptyId) window.api.pty.resume(ptyId)
      }

      const safeFit = (): void => {
        const rect = container.getBoundingClientRect()
        if (rect.width < 48 || rect.height < 24) return
        // Now sized — open if we deferred it. On the opening frame, let xterm paint
        // once (so its render dimensions exist) before resizing, else syncScrollArea
        // throws. The rAF/timers/ResizeObserver below re-run this to finish the fit.
        if (ensureOpened()) {
          requestAnimationFrame(safeFit)
          return
        }
        if (!opened) return
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
        flushHidden() // now measured — replay anything buffered while hidden
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
        if (existed && buffer) {
          // Guard: replaying into a hidden/zero-size terminal can throw in xterm's
          // viewport sync (no render dimensions yet). The buffer still lands; the
          // scroll pin retries when the pane becomes visible and fits.
          try {
            term.write(buffer)
            // The snapshot restores content but not scroll position; pin to the
            // bottom (the prompt) so a replayed terminal doesn't open at the top.
            term.write('', () => term.scrollToBottom())
          } catch {
            /* not measured yet */
          }
        }
        onReadyRef.current?.(id)
        disposers.push(
          window.api.pty.onData(id, (data) => {
            if (isRenderable()) {
              // Visible: ack in the write callback (after xterm parses the chunk).
              // That is the backpressure signal — if xterm falls behind, acks lag,
              // main hits the high-water mark and pauses the PTY (see pty.ts). A
              // rare synchronous throw still acks so flow control can't deadlock.
              try {
                term.write(data, () => window.api.pty.ack(id, data.length))
              } catch {
                pendingHidden = (pendingHidden + data).slice(-HIDDEN_CAP)
                window.api.pty.ack(id, data.length)
              }
            } else {
              // Hidden: don't touch xterm (rendering into a 0-size viewport throws and
              // can't keep up with a flood). Buffer the last screenful (capped) and ack
              // immediately so main stays drained and a background agent keeps running;
              // flushHidden() replays it when the pane is shown. Memory stays bounded by
              // the cap here + main's coalescing, so no ballooning.
              pendingHidden = (pendingHidden + data).slice(-HIDDEN_CAP)
              window.api.pty.ack(id, data.length)
            }
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
          container.style.setProperty('--term-font', s.terminalFontFamily)
          container.style.setProperty('--term-font-size', `${s.terminalFontSize}px`)
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
        if (liveTerm === term) liveTerm = null
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
      const nowVisible = e.isIntersecting && e.intersectionRatio > 0
      if (nowVisible !== visible) {
        if (!nowVisible && liveTerm) {
          // About to be hidden (display:none) → capture scroll before the browser
          // zeroes the viewport scrollTop.
          const buf = liveTerm.buffer.active
          hiddenTerm = liveTerm
          savedViewportY = buf.viewportY
          savedAtBottom = buf.viewportY >= buf.baseY
        } else if (nowVisible && liveTerm && liveTerm === hiddenTerm && savedViewportY != null) {
          // Shown again without a teardown → restore the pre-hide scroll (a
          // remounted term instead restores via the snapshot scrollToBottom).
          const term = liveTerm
          const y = savedViewportY
          const bottom = savedAtBottom
          requestAnimationFrame(() => (bottom ? term.scrollToBottom() : term.scrollToLine(y)))
          hiddenTerm = null
          savedViewportY = null
        }
      }
      visible = nowVisible
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
