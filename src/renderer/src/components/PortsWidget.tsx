import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSession, pathOf } from '../state/session'
import { togglePanel } from '../dock/registry'
import { useApiTarget } from '../state/apiTarget'
import { anchorPlacement } from '../lib/anchorPlacement'
import { useT } from '../i18n'
import { Plug } from 'lucide-react'

interface Port {
  port: number
  pid: number
  name: string
}

// The dev servers listening for this workspace, as chips. Clicking one asks
// WHERE to open it: the API client (to poke an endpoint), the in-app browser, or
// the system browser — or stops it.
export default function PortsWidget(): JSX.Element | null {
  const t = useT()
  const folder = useSession((s) => s.activeWorkspace)
  const patch = useSession((s) => s.patch)
  const [ports, setPorts] = useState<Port[]>([])

  // Poll running ports for this repo.
  useEffect(() => {
    if (!folder) {
      setPorts([])
      return
    }
    let cancelled = false
    const poll = (): void => {
      window.api.ports.list(pathOf(folder)).then((p) => {
        if (!cancelled) setPorts(p)
      })
    }
    poll()
    const id = setInterval(poll, 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [folder])

  const [portMenu, setPortMenu] = useState<(Port & { anchor: DOMRect }) | null>(null)
  // Placed after it has a size, so the menu sits right on its chip.
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!portMenu || !menuRef.current) {
      setMenuPos(null)
      return
    }
    const r = menuRef.current.getBoundingClientRect()
    setMenuPos(
      anchorPlacement(
        portMenu.anchor,
        { width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [portMenu])

  // Killing is two clicks, not one: the menu item arms first and only then does
  // it. A dev server dies instantly and takes its state with it, and this menu
  // is one stray click away from the port number you meant to open.
  const [armedKill, setArmedKill] = useState<number | null>(null)
  const [killError, setKillError] = useState<string | null>(null)

  const killPort = async (p: Port): Promise<void> => {
    if (!folder) return
    setPortMenu(null)
    setArmedKill(null)
    const res = await window.api.ports.kill(pathOf(folder), p.port, p.pid)
    if (!res.ok) {
      setKillError(res.error ?? 'failed')
      setTimeout(() => setKillError(null), 4000)
      return
    }
    // Reflect it immediately rather than waiting up to 4s for the next poll.
    setPorts((cur) => cur.filter((x) => x.port !== p.port))
  }
  const openPortIn = (port: number, where: 'api' | 'browser' | 'external'): void => {
    const url = `http://localhost:${port}`
    setPortMenu(null)
    if (where === 'external') {
      window.api.openExternal(url)
      return
    }
    if (where === 'api') {
      useApiTarget.getState().setUrl(url)
      togglePanel('api')
      return
    }
    if (folder) patch(folder, { previewUrl: url })
    togglePanel('preview')
  }

  if (!folder || (ports.length === 0 && !killError)) return null

  return (
    <>
      {ports.length > 0 && (
        <span className="status-item ports" title={t('status.ports')}>
          <Plug size={13} />
          {ports.map((p) => (
            <span
              key={p.port}
              className={`port-chip${portMenu?.port === p.port ? ' open' : ''}`}
              // Say WHAT is listening, not just the number — several dev servers
              // look identical otherwise.
              title={`${p.name} · pid ${p.pid} · :${p.port}`}
              onClick={(e) => {
                setArmedKill(null)
                setPortMenu({ ...p, anchor: e.currentTarget.getBoundingClientRect() })
              }}
            >
              <i className="port-dot" />
              {p.port}
              <span className="port-name">{p.name}</span>
            </span>
          ))}
        </span>
      )}
      {killError && (
        <span className="status-item dim" title={killError}>
          {t('port.killFailed')}
        </span>
      )}
      {portMenu &&
        createPortal(
          <div className="ctx-backdrop" onClick={() => setPortMenu(null)}>
            <div
              ref={menuRef}
              className="context-menu port-menu"
              // Measured invisibly first, then placed on its chip.
              style={menuPos ? { left: menuPos.left, top: menuPos.top } : { left: 0, top: 0, visibility: 'hidden' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="context-label">localhost:{portMenu.port}</div>
              <div className="context-item" onClick={() => openPortIn(portMenu.port, 'api')}>
                {t('port.openApi')}
              </div>
              <div className="context-item" onClick={() => openPortIn(portMenu.port, 'browser')}>
                {t('port.openBrowser')}
              </div>
              <div className="context-item" onClick={() => openPortIn(portMenu.port, 'external')}>
                {t('port.openExternal')}
              </div>
              <div className="context-sep" />
              <div
                className={`context-item danger${armedKill === portMenu.port ? ' armed' : ''}`}
                onClick={() => {
                  if (armedKill === portMenu.port) void killPort(portMenu)
                  else setArmedKill(portMenu.port)
                }}
              >
                {armedKill === portMenu.port
                  ? t('port.killConfirm', { name: portMenu.name, pid: portMenu.pid })
                  : t('port.kill')}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
