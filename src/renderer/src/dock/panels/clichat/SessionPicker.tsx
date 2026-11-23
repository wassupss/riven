import { useEffect, useState } from 'react'
import { GitBranch, History, Pencil, Plus, Trash2 } from 'lucide-react'
import { useT, type TFn } from '../../../i18n'
import { getSettings } from '../../../state/settings'

// Past conversations of this workspace, from the CLI's own transcripts (the
// same list the chat pane's /resume shows): resume one, resume a copy
// (--fork-session), rename, delete, or start a new one. The conversation
// running in the pane is renamed through the CLI itself (/rename), so the
// CLI's later copy of the title cannot undo it.

interface Row {
  id: string
  title: string
  mtime: number
  messages: number
}

function ago(ts: number, t: TFn): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return t('chat.time.now')
  if (s < 3600) return t('chat.time.min', { n: Math.floor(s / 60) })
  if (s < 86400) return t('chat.time.hour', { n: Math.floor(s / 3600) })
  return t('chat.time.day', { n: Math.floor(s / 86400) })
}

export default function SessionPicker({
  chatKey,
  cwd,
  configDir,
  current,
  onOpen,
  onNew,
  onClose
}: {
  chatKey: string
  cwd: string
  configDir?: string
  current: string | null
  onOpen: (id: string, fork: boolean) => void
  onNew: () => void
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const reload = (): void => {
    void window.api.chat.sessions(cwd, configDir).then(setRows)
  }
  useEffect(reload, [cwd, configDir])

  const commitRename = async (id: string): Promise<void> => {
    const name = draft.trim()
    setEditing(null)
    if (!name) return
    setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, title: name } : r)) ?? prev)
    if (id === current) await window.api.cliChat.rename(chatKey, name)
    else await window.api.chat.sessionRename(cwd, id, name, configDir)
    // The CLI writes its title line a moment after the command runs.
    setTimeout(reload, id === current ? 1500 : 0)
  }
  const remove = async (r: Row): Promise<void> => {
    if (getSettings().confirmDeleteSession && !window.confirm(t('chat.sessionDeleteConfirm', { title: r.title }))) return
    setRows((prev) => prev?.filter((x) => x.id !== r.id) ?? prev)
    await window.api.chat.sessionDelete(cwd, r.id, configDir)
    reload()
  }

  return (
    <div
      className="chat-card cli-chat-sessions"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !editing) {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div className="chat-card-head">
        <History size={14} />
        <span>{t('chat.resumeTitle')}</span>
        <span className="cli-chat-spacer" />
        <button className="cli-chat-btn" onClick={onNew}>
          <Plus size={12} /> {t('clichat.session.new')}
        </button>
      </div>
      {rows === null ? (
        <div className="set-note">…</div>
      ) : rows.length === 0 ? (
        <div className="set-note">{t('chat.resumeEmpty')}</div>
      ) : (
        <div className="chat-card-scroll">
          {rows.map((r) => (
            <div key={r.id} className={`picker-row${r.id === current ? ' active' : ''}`}>
              {editing === r.id ? (
                <input
                  className="picker-rename"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitRename(r.id)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commitRename(r.id)
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <button className="picker-item" onClick={() => r.id !== current && onOpen(r.id, false)}>
                  <span className="picker-title">
                    {r.title}
                    {r.id === current && <span className="cli-chat-current"> · {t('clichat.session.current')}</span>}
                  </span>
                  <span className="picker-meta">
                    {ago(Number(r.mtime), t)} · {r.messages}
                  </span>
                </button>
              )}
              {editing !== r.id && (
                <span className="picker-acts">
                  <button className="picker-act" title={t('chat.sessionFork')} onClick={() => onOpen(r.id, true)}>
                    <GitBranch size={12} />
                  </button>
                  <button
                    className="picker-act"
                    title={t('chat.sessionRename')}
                    onClick={() => {
                      setDraft(r.title.replace(/…$/, ''))
                      setEditing(r.id)
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  {r.id !== current && (
                    <button className="picker-act danger" title={t('chat.sessionDelete')} onClick={() => void remove(r)}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
