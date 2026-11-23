import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { useSettings } from '../state/settings'
import { setPaneState, useSession } from '../state/session'
import { PANEL_BG_KIND_LABEL, PANEL_BG_LOOK, sanitizeBg, sanitizePaneBg, type PanelBg, type PanelBgKind } from '../state/panelBackground'
import { scheduleBackgroundGc } from '../lib/panelBackground'
import type { Host } from '../lib/hostWindow'
import { Segmented } from '../components/ui/Controls'
import PanelBgEditor, { BgThumb } from '../components/PanelBgEditor'

// Tab menu > 배경 설정: one panel's own background. Kind default (absent in the
// pane state), none ('none'), or its own (a PanelBg), saved with the pane in
// sessions.json. Changes apply as they are made; the dialog only closes.

type Mode = 'default' | 'own' | 'none'

export default function PanelBgDialog({
  workspace,
  panelId,
  kind,
  title,
  host,
  onClose
}: {
  workspace: string
  panelId: string
  kind: PanelBgKind
  title: string
  host: Host
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const stored = sanitizePaneBg(useSession((s) => s.sessions[workspace]?.panes?.[panelId]?.bg))
  const kindBg = sanitizeBg(useSettings((s) => s.settings.panelBgs?.[kind]))
  const storedMode: Mode = stored === 'none' ? 'none' : stored ? 'own' : 'default'
  // 'own' with no image picked yet lives only here until one is.
  const [draftOwn, setDraftOwn] = useState(false)
  const mode: Mode = draftOwn && storedMode !== 'own' ? 'own' : storedMode
  const own = stored && stored !== 'none' ? stored : null

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    host.win.addEventListener('keydown', onKey)
    return () => host.win.removeEventListener('keydown', onKey)
  }, [host, onClose])

  const save = (bg: PanelBg | 'none' | undefined): void => {
    setPaneState(workspace, panelId, { bg })
    scheduleBackgroundGc()
  }

  const pickMode = (m: Mode): void => {
    if (m === mode) return
    if (m === 'own') {
      // Starts as a copy of the kind's default, so tuning one panel is one
      // drag away; with no default, the image is picked first.
      if (kindBg) save({ ...kindBg })
      else setDraftOwn(true)
      return
    }
    setDraftOwn(false)
    save(m === 'none' ? 'none' : undefined)
  }

  const onEdit = (v: PanelBg | null): void => {
    setDraftOwn(false)
    // Removing this panel's image means this panel shows none.
    save(v ?? 'none')
  }

  return createPortal(
    // React events bubble out of a portal to its React parent, the tab: keep
    // a double-click (centre the image) from starting a tab rename.
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="modal pbg-modal" role="dialog" aria-label={t('bg.dialogTitle', { name: title })}>
        <div className="modal-header">
          <span className="pbg-modal-title">{t('bg.dialogTitle', { name: title })}</span>
          <button type="button" className="btn-small" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        <div className="modal-body pbg-modal-body">
          <div className="set-row">
            <Segmented<Mode>
              value={mode}
              onChange={pickMode}
              options={[
                { value: 'default', label: t('bg.useDefault') },
                { value: 'own', label: t('bg.own') },
                { value: 'none', label: t('bg.off') }
              ]}
            />
          </div>
          {mode === 'default' && (
            <div className="set-row">
              <div className="set-rowinfo">
                <span className="set-rowtitle">{t('bg.kindDefault', { kind: t(PANEL_BG_KIND_LABEL[kind]) })}</span>
                <span className="set-rowdesc">{t('bg.kindDefaultDesc')}</span>
              </div>
              <div className="set-rowctl">
                <BgThumb bg={kindBg} />
              </div>
            </div>
          )}
          {mode === 'own' && (
            <PanelBgEditor value={own} onChange={onEdit} seed={kindBg ?? PANEL_BG_LOOK} />
          )}
        </div>
      </div>
    </div>,
    host.doc.body
  )
}
