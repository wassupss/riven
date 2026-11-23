import { createContext, useContext, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import { useSettings } from '../state/settings'
import { useSession } from '../state/session'
import { bgVars, isBgKind, resolveBg } from '../state/panelBackground'
import { backgroundUrl } from '../lib/panelBackground'
import { holdSeeThrough } from '../lib/editorSeeThrough'
import '../styles/panel-background.css'

// One panel's background image (state/panelBackground): its own override from
// its pane state, else its kind's default from settings.
//
// The host is display: contents, so the dock's layout is untouched, and
// carries the resolved background as CSS custom properties plus a data-pbg
// attribute that turns the static layers in styles/panel-background.css on.
// It re-renders only when this panel's override or its kind's default object
// changes (both are replaced, never mutated, so the selectors are stable), and
// React then writes only the properties that differ. The children element is
// the same object across those renders, so the panel itself does not
// re-render, and nothing here runs per frame.

const PanelBgContext = createContext(false)

/** Does the panel this is rendered in show a background image? */
export function usePanelBgOn(): boolean {
  return useContext(PanelBgContext)
}

// Kinds whose panel holds a Monaco editor: their minimap needs the
// see-through theme (lib/editorSeeThrough).
const MONACO_KINDS = new Set(['editor', 'db', 'prdiff'])

export default function PanelBgHost({
  kind,
  workspace,
  panelId,
  children
}: {
  kind: string
  workspace: string
  panelId: string
  children: ReactNode
}): JSX.Element {
  const kindBg = useSettings((s) => (isBgKind(kind) ? s.settings.panelBgs?.[kind] : undefined))
  const paneBg = useSession((s) => s.sessions[workspace]?.panes?.[panelId]?.bg)
  const bg = useMemo(() => resolveBg(isBgKind(kind) ? { [kind]: kindBg } : {}, kind, paneBg), [kind, kindBg, paneBg])
  const on = bg !== null
  const style = useMemo(() => (bg ? (bgVars(bg, backgroundUrl) as unknown as CSSProperties) : undefined), [bg])

  useEffect(() => {
    if (on && MONACO_KINDS.has(kind)) return holdSeeThrough()
    return undefined
  }, [on, kind])

  return (
    <div className="pbg-host" data-kind={kind} data-pbg={on ? '' : undefined} style={style}>
      <div className="pbg" aria-hidden />
      <PanelBgContext.Provider value={on}>{children}</PanelBgContext.Provider>
    </div>
  )
}
