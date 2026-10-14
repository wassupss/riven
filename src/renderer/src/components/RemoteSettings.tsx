import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import '../styles/remote-settings.css'
import { useT } from '../i18n'
import { useSettings } from '../state/settings'
import { cancelInvite, newInvite, resetRemote, revokeDevice, useRemote } from '../state/remote'
import { useUI } from '../state/ui'
import { Button, Switch } from './ui/Controls'

// Settings › 원격 제어. Adding a phone shows a QR code carrying a one-time
// invite that lapses after 10 minutes; the phone app scans it and this machine
// then asks the user to approve that phone (RemotePairPrompt). Each approved
// phone is listed here and can be unpaired on its own.

export default function RemoteSettings(): JSX.Element {
  const t = useT()
  const enabled = useSettings((s) => s.settings.remoteEnabled)
  const devices = useSettings((s) => s.settings.remoteDevices)
  const set = useSettings((s) => s.set)
  const { state, present, invite } = useRemote()
  const [qr, setQr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  // The countdown, and the QR's removal once the invite has lapsed or been used.
  useEffect(() => {
    if (!invite) {
      setQr(null)
      return
    }
    const id = setInterval(() => {
      setNow(Date.now())
      if (Date.now() > invite.expiresAt) cancelInvite()
    }, 1000)
    return () => clearInterval(id)
  }, [invite])

  // Leaving the page takes the QR down with it.
  useEffect(() => () => cancelInvite(), [])

  const showQr = (): void => {
    const text = newInvite()
    if (!text) return
    void QRCode.toDataURL(text, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then(setQr)
  }

  const toggle = (on: boolean): void => {
    set({ remoteEnabled: on })
    if (!on) cancelInvite()
  }

  const left = invite ? Math.max(0, Math.round((invite.expiresAt - now) / 1000)) : 0
  const status =
    state === 'online'
      ? present.length > 0
        ? t('remote.statusPhone', { n: present.length })
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
              <span className={`remote-state ${state}${present.length > 0 ? ' phone' : ''}`}>
                <span className="remote-dot" />
                {status}
              </span>
            </div>
          </div>

          {state === 'signed-out' && (
            <div className="set-row">
              <div className="set-rowinfo">
                <span className="set-rowdesc">{t('remote.signInNeeded')}</span>
              </div>
              <div className="set-rowctl">
                <Button onClick={() => useUI.getState().openSettings('account')}>{t('remote.signIn')}</Button>
              </div>
            </div>
          )}

          <div className="set-row">
            <div className="set-rowinfo">
              <span className="set-rowtitle">{t('remote.pair')}</span>
              <span className="set-rowdesc">{t('remote.pairDesc')}</span>
            </div>
            <div className="set-rowctl">
              {invite ? (
                <Button onClick={() => cancelInvite()}>{t('remote.hideQr')}</Button>
              ) : (
                <Button onClick={showQr} disabled={state === 'unconfigured' || state === 'signed-out'}>
                  {t('remote.showQr')}
                </Button>
              )}
            </div>
          </div>
          {invite && qr && (
            <div className="remote-qr">
              <img src={qr} alt={t('remote.pair')} width={220} height={220} />
              <span className="remote-qr-left">
                {t('remote.qrLeft', { m: Math.floor(left / 60), s: String(left % 60).padStart(2, '0') })}
              </span>
              <span className="remote-qr-note">{t('remote.qrNote')}</span>
            </div>
          )}

          <div className="section-label">{t('remote.devices')}</div>
          {devices.length === 0 ? (
            <p className="remote-note">{t('remote.noDevices')}</p>
          ) : (
            devices.map((d) => (
              <div className="set-row" key={d.id}>
                <div className="set-rowinfo">
                  <span className="set-rowtitle">
                    {d.name}
                    {present.includes(d.id) && <span className="remote-live">{t('remote.live')}</span>}
                  </span>
                  <span className="set-rowdesc">
                    {d.platform} · {t('remote.addedAt', { when: new Date(d.addedAt).toLocaleDateString() })}
                  </span>
                </div>
                <div className="set-rowctl">
                  <Button onClick={() => revokeDevice(d.id)}>{t('remote.revoke')}</Button>
                </div>
              </div>
            ))
          )}

          <div className="set-row">
            <div className="set-rowinfo">
              <span className="set-rowtitle">{t('remote.reset')}</span>
              <span className="set-rowdesc">{t('remote.resetDesc')}</span>
            </div>
            <div className="set-rowctl">
              <Button onClick={() => resetRemote()}>{t('remote.resetBtn')}</Button>
            </div>
          </div>

          <p className="remote-note">{t('remote.awakeNote')}</p>
        </>
      )}
    </div>
  )
}
