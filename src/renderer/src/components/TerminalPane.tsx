import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { registerPaneFocuser, setFocusRegion } from '../keybindings/focus'
import { useSettings, getSettings } from '../state/settings'

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

export default function TerminalPane({
  sessionKey,
  cwd,
  shell,
  args,
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

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const cfg = getSettings()
    const term = new Terminal({
      fontFamily: cfg.terminalFontFamily,
      fontSize: cfg.terminalFontSize,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: cfg.terminalBackground,
        foreground: cfg.terminalForeground,
        cursor: cfg.terminalCursor
      }
    })
    const fit = new FitAddon()
    const serialize = new SerializeAddon()
    term.loadAddon(fit)
    term.loadAddon(serialize)
    term.open(container)

    // Snapshot the rendered screen after output settles so a reconnect (⌘R) can
    // restore it cleanly instead of replaying a raw (possibly broken) stream.
    let snapTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleSnapshot = (id: string): void => {
      if (snapTimer) clearTimeout(snapTimer)
      snapTimer = setTimeout(() => {
        try {
          window.api.pty.snapshot(id, serialize.serialize({ scrollback: 400 }))
        } catch {
          /* serialize can throw on dispose */
        }
      }, 500)
    }

    let ptyId: string | null = null
    let disposed = false
    const disposers: Array<() => void> = []

    const doFit = (): void => {
      // Guard against fitting a zero-size / hidden container (dockview panels
      // mount before they're laid out, and hidden workspaces are 0×0).
      if (!container.clientWidth || !container.clientHeight) return
      try {
        fit.fit()
        if (ptyId) window.api.pty.resize(ptyId, term.cols, term.rows)
      } catch {
        /* renderer dimensions not ready yet */
      }
    }

    // Size xterm to the container BEFORE spawning so the PTY starts correct.
    doFit()

    ;(async () => {
      const { id, existed, buffer } = await window.api.pty.open({
        sessionKey,
        cwd,
        initialCommand,
        cols: term.cols,
        rows: term.rows
      })
      // Do NOT kill on unmount/reload — the session must survive. Just bail out.
      if (disposed) return
      ptyId = id
      if (existed && buffer) term.write(buffer) // restore serialized screen on reconnect
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
      doFit()
      // Nudge a full-screen TUI (e.g. claude) to redraw after replay.
      if (existed) setTimeout(doFit, 60)
    })()

    // Live-apply font/color settings.
    disposers.push(
      useSettings.subscribe(() => {
        const s = getSettings()
        term.options.fontFamily = s.terminalFontFamily
        term.options.fontSize = s.terminalFontSize
        term.options.theme = {
          background: s.terminalBackground,
          foreground: s.terminalForeground,
          cursor: s.terminalCursor
        }
        doFit()
      })
    )

    // Deferred fits catch dockview's asynchronous panel layout.
    const raf = requestAnimationFrame(doFit)
    const t1 = setTimeout(doFit, 60)
    const t2 = setTimeout(doFit, 300)
    const ro = new ResizeObserver(doFit)
    ro.observe(container)

    const onFocusIn = (): void => {
      if (paneId != null) setFocusRegion({ kind: 'terminal', paneId })
      onFocusRef.current?.()
    }
    container.addEventListener('focusin', onFocusIn)
    if (paneId != null) disposers.push(registerPaneFocuser(paneId, () => term.focus()))

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      clearTimeout(t1)
      clearTimeout(t2)
      ro.disconnect()
      container.removeEventListener('focusin', onFocusIn)
      disposers.forEach((d) => d())
      // Detach only — the PTY session stays alive in main (killed on panel close).
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="terminal-pane" ref={containerRef} />
}
