import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Play, ChevronDown } from 'lucide-react'
import { useSession, pathOf } from '../state/session'
import { addTerminal } from '../dock/registry'
import { useT } from '../i18n'

// Reads the repo's package.json scripts + detects the package manager, and runs
// the chosen script in a new terminal (logs stream there).
export default function ScriptRunner(): JSX.Element {
  const t = useT()
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  // Opens toward the middle of the window: down from the header, up from a bar
  // at the bottom.
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null)
  const [data, setData] = useState<{ manager: string; scripts: string[] } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!pos) return
    const onDown = (e: MouseEvent): void => {
      const tg = e.target as HTMLElement
      if (!btnRef.current?.contains(tg) && !tg.closest?.('.tb-menu')) setPos(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pos])

  const toggle = (): void => {
    if (pos) {
      setPos(null)
      return
    }
    if (!activeWorkspace) return
    setData(null)
    window.api.workspace.scripts(pathOf(activeWorkspace)).then(setData).catch(() => setData({ manager: 'npm', scripts: [] }))
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - 180))
    if (r.top < window.innerHeight / 2) setPos({ top: r.bottom + 6, left })
    else setPos({ bottom: window.innerHeight - r.top + 6, left })
  }
  const run = (name: string): void => {
    if (activeWorkspace) addTerminal(`${data?.manager ?? 'npm'} run ${name}`)
    setPos(null)
  }

  return (
    <>
      <button
        ref={btnRef}
        className="status-item click run-btn"
        disabled={!activeWorkspace}
        title={t('run.title')}
        onClick={toggle}
      >
        <Play size={12} /> {t('run.label')}
      </button>
      {pos &&
        createPortal(
          <div className="tb-menu" style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}>
            {data && data.scripts.length === 0 && <div className="tb-menu-empty">{t('run.none')}</div>}
            {!data && <div className="tb-menu-empty">…</div>}
            {data?.scripts.map((s) => (
              <div key={s} className="tb-menu-item" onClick={() => run(s)}>
                <span>{s}</span>
                <span className="tb-menu-key">{data.manager} run</span>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
