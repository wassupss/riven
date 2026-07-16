import { PanelTop } from 'lucide-react'
import { useSession } from '../state/session'
import { useUI } from '../state/ui'
import { useT } from '../i18n'

// The old +terminal button and panels dropdown are now unified into a single
// keyboard-driven dialog (QuickPanel), opened here or via ⌘⇧K.
export default function Toolbar(): JSX.Element {
  const t = useT()
  const hasWs = useSession((s) => s.activeWorkspace != null)
  const setQuickPanel = useUI((s) => s.setQuickPanel)

  return (
    <div className="toolbar">
      <button
        className="tb-btn"
        disabled={!hasWs}
        title={t('toolbar.openPanel')}
        onClick={() => setQuickPanel(true)}
      >
        <PanelTop size={14} /> {t('toolbar.panels')}
        <span className="tb-menu-key">⌘⇧K</span>
      </button>
    </div>
  )
}
