import { useEffect } from 'react'
import { useSession } from '../../state/session'
import { useAgentEdits, type TimelineEntry } from '../../state/agentEdits'
import { ensureEditor } from '../registry'
import { useT } from '../../i18n'
import { FileCode, FilePlus2, Trash2 } from 'lucide-react'

// Compact, language-neutral relative time (now / 5m / 2h / 3d).
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function fileParts(entry: TimelineEntry): { name: string; dir: string } {
  const rel = entry.path.startsWith(entry.workspace)
    ? entry.path.slice(entry.workspace.length + 1)
    : entry.path
  const i = rel.lastIndexOf('/')
  return i < 0 ? { name: rel, dir: '' } : { name: rel.slice(i + 1), dir: rel.slice(0, i) }
}

// The changes timeline: a running summary of files an agent edited in this
// session (see AgentWatch — only edits made while an agent is running are
// caught). Nothing auto-opens; clicking a row opens that file with its inline
// diff, so a big multi-file change never floods the editor with tabs.
export default function ChangesPanel(): JSX.Element {
  const t = useT()
  const timeline = useAgentEdits((s) => s.timeline)
  const markSeen = useAgentEdits((s) => s.markSeen)
  const clearTimeline = useAgentEdits((s) => s.clearTimeline)
  const openFile = useSession((s) => s.openFile)
  const setActiveWorkspace = useSession((s) => s.setActiveWorkspace)

  // Viewing the panel clears the unseen badge.
  useEffect(() => {
    markSeen()
  }, [timeline.length, markSeen])

  const open = (entry: TimelineEntry): void => {
    setActiveWorkspace(entry.workspace)
    openFile(entry.path)
    ensureEditor()
  }

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <span className="changes-title">
          {t('title.changes')}
          {timeline.length > 0 && <span className="changes-count">{timeline.length}</span>}
        </span>
        {timeline.length > 0 && (
          <button className="changes-clear" onClick={clearTimeline} title={t('changes.clear')}>
            <Trash2 size={13} /> {t('changes.clear')}
          </button>
        )}
      </div>

      {timeline.length === 0 ? (
        <div className="changes-empty">{t('changes.empty')}</div>
      ) : (
        <div className="changes-list">
          {timeline.map((entry) => {
            const { name, dir } = fileParts(entry)
            return (
              <div
                key={entry.path}
                className="changes-row"
                onClick={() => open(entry)}
                title={entry.path}
              >
                <span className={`changes-ico ${entry.isNew ? 'is-new' : ''}`}>
                  {entry.isNew ? <FilePlus2 size={14} /> : <FileCode size={14} />}
                </span>
                <span className="changes-name">{name}</span>
                {dir && <span className="changes-dir">{dir}</span>}
                <span className="changes-stats">
                  {entry.added > 0 && <span className="changes-add">+{entry.added}</span>}
                  {entry.removed > 0 && <span className="changes-del">−{entry.removed}</span>}
                </span>
                <span className="changes-time">{ago(entry.at)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
