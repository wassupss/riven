import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import '../styles/remote-settings.css'
import { useT } from '../i18n'
import { useSettings } from '../state/settings'
import { ensurePairing, rePair, useRemote } from '../state/remote'
import { url as supabaseUrl, anonKey } from '../lib/supabase'
import { pairingUrl } from '../lib/remoteProtocol'
import { Button, Switch } from './ui/Controls'

// Settings › 원격 제어. Turning it on creates this machine's pairing (a channel
// and a key); the QR code hands both to a phone. The QR stays hidden until asked
// for: it is a key to this machine's agents, and a settings window is exactly
// what ends up on a shared screen.
const REMOTE_PAGE = 'https://riven-sandy.vercel.app/remote.html'

export default function RemoteSettings(): JSX.Element {
  const t = useT()
  const enabled = useSettings((s) => s.settings.remoteEnabled)
  const channel = useSettings((s) => s.settings.remoteChannel)
  const key = useSettings((s) => s.settings.remoteKey)
  const set = useSettings((s) => s.set)
  const { state, phones } = useRemote()
  const [showQr, setShowQr] = useState(false)
  const [qr, setQr] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !showQr || !channel || !key || !supabaseUrl || !anonKey) {
      setQr(null)
      return
    }
    let live = true
    const link = pairingUrl(REMOTE_PAGE, { channel, key, url: supabaseUrl, anon: anonKey })
    void QRCode.toDataURL(link, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then((d) => live && setQr(d))
    return () => {
      live = false
    }
  }, [enabled, showQr, channel, key])

  const toggle = (on: boolean): void => {
    if (on) ensurePairing()
    set({ remoteEnabled: on })
    if (!on) setShowQr(false)
  }

  const status =
    state === 'online'
      ? phones > 0
        ? t('remote.statusPhone', { n: phones })
        : t('remote.statusOnline')
      : t(`remote.status.${state}`)

  return (
    <div className="remote-set">
      <div className="section-label">{t('remote.title')}</div>
      <div className="set-row">
        <div className="set-rowinfo">
          <span className="set-rowtitle">{t('remote.enable')}</span>
          <span className="set-rowdesc">{t('remote.enableDesc')}</span>
        </div>
        <div className="set-rowctl">
          <Switch checked={enabled} onChange={toggle} />
        </div>
      </div>

      {enabled && (
        <>
          <div className="set-row">
            <div className="set-rowinfo">
              <span className="set-rowtitle">{t('remote.state')}</span>
            </div>
            <div className="set-rowctl">
              <span className={`remote-state ${state}${phones > 0 ? ' phone' : ''}`}>
                <span className="remote-dot" />
                {status}
              </span>
            </div>
          </div>

          <div className="set-row">
            <div className="set-rowinfo">
              <span className="set-rowtitle">{t('remote.pair')}</span>
              <span className="set-rowdesc">{t('remote.pairDesc')}</span>
            </div>
            <div className="set-rowctl">
              <Button onClick={() => setShowQr((v) => !v)} disabled={state === 'unconfigured'}>
                {showQr ? t('remote.hideQr') : t('remote.showQr')}
              </Button>
            </div>
          </div>
          {showQr && qr && (
            <div className="remote-qr">
              <img src={qr} alt={t('remote.pair')} width={220} height={220} />
              <span className="remote-qr-note">{t('remote.qrNote')}</span>
            </div>
          )}

          <div className="set-row">
            <div className="set-rowinfo">
              <span className="set-rowtitle">{t('remote.rePair')}</span>
              <span className="set-rowdesc">{t('remote.rePairDesc')}</span>
            </div>
            <div className="set-rowctl">
              <Button onClick={() => rePair()}>{t('remote.rePairBtn')}</Button>
            </div>
          </div>

          <p className="remote-note">{t('remote.awakeNote')}</p>
        </>
      )}
    </div>
  )
}
