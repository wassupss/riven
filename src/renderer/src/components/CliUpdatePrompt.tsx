import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CliUpdateState } from '../../../preload/index'
import { useT } from '../i18n'

// Asked once an update of a CLI finishes while agents on it are open: apply the
// new build to them now, or leave them be.
//
// Not automatic, on purpose. Applying replaces each pane's process (in place,
// resuming the same conversation), and when that happens is the user's call —
// right after an update is not always a good moment. "Later" is not a loss:
// a pane gets the new build anyway the next time it reattaches to its process
// (a reload, or reopening the window), or from 설정 › AI › 에이전트 다시 시작.
//
// Lives at the app root, not in settings: the update runs in the background
// and may finish after the settings window was closed.

const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

export default function CliUpdatePrompt(): JSX.Element | null {
  const t = useT()
  const [ask, setAsk] = useState<CliUpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const consider = (u: CliUpdateState): void => {
      if (u.status === 'done' && !u.answered && u.open > 0 && u.from !== u.to) setAsk(u)
      else setAsk((cur) => (cur && cur.cmd === u.cmd ? null : cur))
    }
    void window.api.cli.updateStatus().then((list) => list.forEach(consider))
    return window.api.cli.onUpdate(consider)
  }, [])

  if (!ask) return null
  const later = (): void => {
    void window.api.cli.deferUpdate(ask.cmd)
    setAsk(null)
  }
  const apply = async (): Promise<void> => {
    setBusy(true)
    await window.api.cli.applyUpdate(ask.cmd)
    setBusy(false)
    setAsk(null)
  }
  return createPortal(
    <div className="modal-overlay" onClick={later}>
      <div className="modal input-modal cli-update-prompt" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('cliUpdate.title', { name: NAMES[ask.cmd] ?? ask.cmd, to: ask.to ?? '' })}</span>
        </div>
        <div className="input-modal-body">
          <p className="cli-update-q">{t('cliUpdate.question', { n: String(ask.open) })}</p>
          <p className="set-note">{t('cliUpdate.how')}</p>
          <div className="input-modal-actions">
            <button className="btn-small" onClick={later} disabled={busy}>
              {t('cliUpdate.later')}
            </button>
            <button className="btn-small primary" onClick={() => void apply()} disabled={busy}>
              {busy ? t('cliUpdate.applying') : t('cliUpdate.apply')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
