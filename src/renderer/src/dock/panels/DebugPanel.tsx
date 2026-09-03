import { useState } from 'react'
import {
  Play,
  Square,
  StepForward,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  ChevronDown,
  Bug
} from 'lucide-react'
import { useDebugger, type DebugScope } from '../../state/debugger'
import { pathOf, useSession } from '../../state/session'
import { useNav } from '../../state/nav'
import { useT } from '../../i18n'
import '../../styles/debug-panel.css'

interface Prop {
  name: string
  type: string
  value: string
  objectId: string | null
}

// A lazily-expanded variable node (a scope or an object property).
function VarNode({ name, value, objectId }: { name: string; value: string; objectId: string | null }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [kids, setKids] = useState<Prop[] | null>(null)
  const expandable = !!objectId
  const toggle = async (): Promise<void> => {
    if (!expandable) return
    if (!open && kids === null) setKids(await window.api.debug.getProperties(objectId))
    setOpen((o) => !o)
  }
  return (
    <div className="dbg-var">
      <button className="dbg-var-row" onClick={toggle}>
        {expandable ? (
          open ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )
        ) : (
          <span className="dbg-var-spacer" />
        )}
        <span className="dbg-var-name">{name}</span>
        <span className="dbg-var-val">{value}</span>
      </button>
      {open && kids && (
        <div className="dbg-var-kids">
          {kids.map((k) => (
            <VarNode key={k.name} name={k.name} value={k.value} objectId={k.objectId} />
          ))}
        </div>
      )}
    </div>
  )
}

function ScopeView({ scope }: { scope: DebugScope }): JSX.Element {
  const [open, setOpen] = useState(scope.type === 'local')
  const [kids, setKids] = useState<Prop[] | null>(null)
  const toggle = async (): Promise<void> => {
    if (!scope.objectId) return
    if (!open && kids === null) setKids(await window.api.debug.getProperties(scope.objectId))
    setOpen((o) => !o)
  }
  return (
    <div className="dbg-scope">
      <button className="dbg-scope-head" onClick={toggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="dbg-scope-name">{scope.name || scope.type}</span>
      </button>
      {open && kids && (
        <div className="dbg-var-kids">
          {kids.map((k) => (
            <VarNode key={k.name} name={k.name} value={k.value} objectId={k.objectId} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function DebugPanel(): JSX.Element {
  const t = useT()
  const status = useDebugger((s) => s.status)
  const frames = useDebugger((s) => s.frames)
  const scopes = useDebugger((s) => s.scopes)
  const activeFrameId = useDebugger((s) => s.activeFrameId)
  const setActiveFrame = useDebugger((s) => s.setActiveFrame)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const activePath = useSession((s) => (activeWorkspace ? s.sessions[activeWorkspace]?.activePath : null))
  const openWorkspaces = useSession((s) => s.openWorkspaces)
  const setActiveWorkspace = useSession((s) => s.setActiveWorkspace)

  const paused = status === 'paused'
  const idle = status === 'idle'

  const startDebug = (): void => {
    if (activePath) void useDebugger.getState().start(activePath)
  }
  const jumpTo = (file: string, line: number, id: string): void => {
    setActiveFrame(id)
    const ws = openWorkspaces.find((w) => file.startsWith(pathOf(w) + '/'))
    if (ws) setActiveWorkspace(ws)
    if (file) useNav.getState().requestReveal(file, line, 1)
  }

  return (
    <div className="dbg-panel">
      <div className="dbg-toolbar">
        {idle ? (
          <button className="dbg-btn primary" onClick={startDebug} disabled={!activePath} title={t('debug.start')}>
            <Play size={13} /> {t('debug.start')}
          </button>
        ) : (
          <>
            <button
              className="dbg-btn"
              onClick={() => useDebugger.getState().cont()}
              disabled={!paused}
              title={t('debug.continue')}
            >
              <Play size={14} />
            </button>
            <button
              className="dbg-btn"
              onClick={() => useDebugger.getState().stepOver()}
              disabled={!paused}
              title={t('debug.stepOver')}
            >
              <StepForward size={14} />
            </button>
            <button
              className="dbg-btn"
              onClick={() => useDebugger.getState().stepInto()}
              disabled={!paused}
              title={t('debug.stepInto')}
            >
              <ArrowDownToLine size={14} />
            </button>
            <button
              className="dbg-btn"
              onClick={() => useDebugger.getState().stepOut()}
              disabled={!paused}
              title={t('debug.stepOut')}
            >
              <ArrowUpFromLine size={14} />
            </button>
            <button className="dbg-btn danger" onClick={() => useDebugger.getState().stop()} title={t('debug.stop')}>
              <Square size={13} />
            </button>
          </>
        )}
        <span className={`dbg-status ${status}`}>{t(`debug.state.${status}`)}</span>
      </div>

      {idle ? (
        <div className="dbg-empty">
          <Bug size={16} /> {t('debug.hint')}
        </div>
      ) : (
        <div className="dbg-body">
          <div className="dbg-section">
            <div className="dbg-section-title">{t('debug.callStack')}</div>
            {frames.map((f) => (
              <button
                key={f.id}
                className={`dbg-frame${f.id === activeFrameId ? ' active' : ''}`}
                onClick={() => jumpTo(f.file, f.line, f.id)}
              >
                <span className="dbg-frame-name">{f.name}</span>
                <span className="dbg-frame-loc">
                  {f.file ? f.file.split('/').pop() : '?'}:{f.line}
                </span>
              </button>
            ))}
          </div>
          <div className="dbg-section">
            <div className="dbg-section-title">{t('debug.variables')}</div>
            {scopes.map((s, i) => (
              <ScopeView key={i} scope={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
