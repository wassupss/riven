import { createPortal } from 'react-dom'
import '../styles/remote-settings.css'
import { Smartphone } from 'lucide-react'
import { useT } from '../i18n'
import { decidePairing, useRemote } from '../state/remote'
import { Button } from './ui/Controls'

// "A phone wants to control this machine": the approval every new device needs
// (state/remote). App-level, so it appears wherever the user is, not only with
// the settings open. Dismissing it is a refusal.
export default function RemotePairPrompt(): JSX.Element | null {
  const t = useT()
  const pending = useRemote((s) => s.pending)
  if (!pending) return null
  return createPortal(
    <div className="ctx-backdrop remote-pair-backdrop" onClick={() => decidePairing(false)}>
      <div className="remote-pair" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="remote-pair-icon">
          <Smartphone size={22} />
        </div>
        <div className="remote-pair-title">{t('remote.pairAsk')}</div>
        <div className="remote-pair-device">
          {pending.name || t('remote.unknownPhone')}
          {pending.platform ? ` · ${pending.platform}` : ''}
        </div>
        <p className="remote-pair-warn">{t('remote.pairWarn')}</p>
        <div className="remote-pair-actions">
          <Button onClick={() => decidePairing(false)}>{t('remote.deny')}</Button>
          <Button variant="primary" onClick={() => decidePairing(true)}>
            {t('remote.allow')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
