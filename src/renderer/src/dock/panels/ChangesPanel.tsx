import { useEffect } from 'react'
import { useSession } from '../../state/session'
import { useAgentEdits, cacheSet, type TimelineEntry } from '../../state/agentEdits'
import { ensureEditor } from '../registry'
import { useT } from '../../i18n'
import { FileCode, FilePlus2, Check, Undo2, CheckCheck } from 'lucide-react'

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

// The changes timeline: a running summary of files an agent edited this session.
// Accept (keep) or revert (restore the pre-edit content) per file or in bulk;
// clicking a row opens the file with its inline diff.
export default function ChangesPanel(): JSX.Element {
  const t = useT()
  const timeline = useAgentEdits((s) => s.timeline)
  const editsMap = useAgentEdits((s) => s.edits)
  const markSeen = useAgentEdits((s) => s.markSeen)
  const resolve = useAgentEdits((s) => s.resolve)
  const acceptAll = useAgentEdits((s) => s.acceptAll)
  const requestReload = useAgentEdits((s) => s.requestReload)
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

  // Restore a file's pre-edit content, reload it if open, then drop the entry.
  const revertOne = async (path: string): Promise<void> => {
    const edit = useAgentEdits.getState().edits[path]
    if (edit) {
      await window.api.workspace.writeFile(path, edit.before)
      cacheSet(path, edit.before)
      requestReload(path)
    }
    resolve(path)
  }

  const revertAll = async (): Promise<void> => {
    const { edits, timeline: tl } = useAgentEdits.getState()
    await Promise.all(
      tl.map(async (en) => {
        const edit = edits[en.path]
        if (!edit) return
        await window.api.workspace.writeFile(en.path, edit.before)
        cacheSet(en.path, edit.before)
        requestReload(en.path)
      })
    )
    acceptAll()
  }

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <span className="changes-title">
          {t('title.changes')}
          {timeline.length > 0 && <span className="changes-count">{timeline.length}</span>}
        </span>
        {timeline.length > 0 && (
          <div className="changes-actions">
            <button className="changes-act accept" onClick={acceptAll} title={t('changes.acceptAll')}>
              <CheckCheck size={13} /> {t('changes.acceptAll')}
            </button>
            <button className="changes-act revert" onClick={revertAll} title={t('changes.revertAll')}>
              <Undo2 size={13} /> {t('changes.revertAll')}
            </button>
          </div>
        )}
      </div>

      {timeline.length === 0 ? (
        <div className="changes-empty">{t('changes.empty')}</div>
      ) : (
        <div className="changes-list">
          {timeline.map((entry) => {
            const { name, dir } = fileParts(entry)
            const hasEdit = entry.path in editsMap
            return (
              <div key={entry.path} className="changes-row" onClick={() => open(entry)} title={entry.path}>
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
                <span className="changes-row-actions">
                  <button
                    className="changes-row-act"
                    title={t('changes.accept')}
                    onClick={(e) => {
                      e.stopPropagation()
                      resolve(entry.path)
                    }}
                  >
                    <Check size={13} />
                  </button>
                  <button
                    className="changes-row-act revert"
                    title={t('changes.revert')}
                    disabled={!hasEdit}
                    onClick={(e) => {
                      e.stopPropagation()
                      void revertOne(entry.path)
                    }}
                  >
                    <Undo2 size={13} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
