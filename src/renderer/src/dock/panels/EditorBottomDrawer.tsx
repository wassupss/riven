import { X } from 'lucide-react'
import { useEditorBottom, type BottomTab } from '../../state/editorBottomPanel'
import { useProblemCounts } from '../../state/problems'
import ProblemsPanel from './ProblemsPanel'
import OutputPanel from './OutputPanel'
import DebugPanel from './DebugPanel'
import { useT } from '../../i18n'
import '../../styles/editor-bottom.css'

// The editor's bottom drawer: a small tab strip (Problems / Output) over the shared
// panel components. Rendered inside EditorPanel so it's tied to the code editor.
export default function EditorBottomDrawer({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  const tab = useEditorBottom((s) => s.tab)
  const setTab = useEditorBottom((s) => s.openTab)
  const close = useEditorBottom((s) => s.close)
  const { errors, warnings } = useProblemCounts()

  const Tab = ({ id, label }: { id: BottomTab; label: string }): JSX.Element => (
    <button className={`ebd-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
      {label}
      {id === 'problems' && (errors > 0 || warnings > 0) && (
        <span className="ebd-badge">{errors + warnings}</span>
      )}
    </button>
  )

  return (
    <div className="ebd">
      <div className="ebd-tabs">
        <Tab id="problems" label={t('title.problems')} />
        <Tab id="output" label={t('title.output')} />
        <Tab id="debug" label={t('title.debug')} />
        <div className="ebd-spacer" />
        <button className="ebd-close" title={t('common.close')} onClick={close}>
          <X size={13} />
        </button>
      </div>
      <div className="ebd-body">
        {tab === 'problems' ? (
          <ProblemsPanel />
        ) : tab === 'output' ? (
          <OutputPanel workspace={workspace} />
        ) : (
          <DebugPanel />
        )}
      </div>
    </div>
  )
}
