import { PanelTop, Folder } from 'lucide-react'
import { useSession, pathOf } from '../state/session'
import { useUI } from '../state/ui'
import { useUsage } from '../state/usage'
import { useT } from '../i18n'

// Full-width top strip (native parity): traffic-light drag zone, a small
// workspace name, an "add panel" action on the left, and today's cost on the
// right. The whole bar drags the window; interactive controls opt out.
export default function TopHeader(): JSX.Element {
  const t = useT()
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const names = useSession((s) => s.names)
  const hasWs = activeWorkspace != null
  const setQuickPanel = useUI((s) => s.setQuickPanel)
  const today = useUsage((s) => s.today)

  const wsName = activeWorkspace
    ? names[activeWorkspace] ?? pathOf(activeWorkspace).split('/').pop() ?? ''
    : ''

  return (
    <div className="top-header">
      <div className="top-header-lights" />
      {hasWs && (
        <span className="top-header-ws">
          <Folder size={12} />
          {wsName}
        </span>
      )}
      <button
        className="top-header-btn"
        disabled={!hasWs}
        title={t('toolbar.openPanel')}
        onClick={() => setQuickPanel(true)}
      >
        <PanelTop size={12} /> {t('toolbar.addPanel')}
      </button>
      <div className="top-header-spacer" />
      {today && today.totalCost > 0 && (
        <span className="top-header-cost">${today.totalCost.toFixed(2)}</span>
      )}
    </div>
  )
}
