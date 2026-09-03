import { CircleX, TriangleAlert, ScrollText } from 'lucide-react'
import { useEditorBottom } from '../../state/editorBottomPanel'
import { useProblemCounts } from '../../state/problems'
import { useT } from '../../i18n'

// Thin bar pinned to the bottom of the editor. Shows live error/warning counts
// (click → Problems) and an Output toggle — the always-visible entry to the drawer.
export default function EditorStatusBar(): JSX.Element {
  const t = useT()
  const toggle = useEditorBottom((s) => s.toggle)
  const { errors, warnings } = useProblemCounts()
  return (
    <div className="editor-statusbar">
      <button
        className="esb-item"
        onClick={() => toggle('problems')}
        title={t('title.problems')}
      >
        <CircleX size={12} className="prob-sev err" />
        <span className="esb-num">{errors}</span>
        <TriangleAlert size={12} className="prob-sev warn" />
        <span className="esb-num">{warnings}</span>
      </button>
      <div className="esb-spacer" />
      <button className="esb-item" onClick={() => toggle('output')} title={t('title.output')}>
        <ScrollText size={12} />
        <span>{t('title.output')}</span>
      </button>
    </div>
  )
}
