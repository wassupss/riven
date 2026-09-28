import { useCallback, useEffect, useState } from 'react'
import { Check, X as XIcon, HelpCircle, RotateCw } from 'lucide-react'
import { useT } from '../i18n'
import { Button } from './ui/Controls'

// What macOS has granted riven.
//
// Each of these is something the app uses and fails silently without — the
// screenshot tool returns a black frame, a site in the browser panel gets a dead
// microphone, a finished turn notifies nobody — and none of those failures says
// which permission is missing. So the screen says it, and offers the only two
// things that can actually change it: ask (mic/camera) or open the exact pane of
// System Settings (screen recording, notifications).

type State = string

interface Report {
  notifications: State
  screen: State
  microphone: State
  camera: State
  supported: boolean
}

const ROWS: Array<{ key: keyof Omit<Report, 'supported'>; askable: boolean }> = [
  { key: 'notifications', askable: false },
  { key: 'screen', askable: false },
  { key: 'microphone', askable: true },
  { key: 'camera', askable: true }
]

function StateTag({ state }: { state: State }): JSX.Element {
  const t = useT()
  if (state === 'granted')
    return (
      <span className="perm-state granted">
        <Check size={11} /> {t('perm.granted')}
      </span>
    )
  if (state === 'denied' || state === 'restricted')
    return (
      <span className="perm-state denied">
        <XIcon size={11} /> {t('perm.denied')}
      </span>
    )
  if (state === 'not-determined')
    return <span className="perm-state">{t('perm.notAsked')}</span>
  return (
    <span className="perm-state" title={t('perm.unknownHint')}>
      <HelpCircle size={11} /> {t('perm.unknown')}
    </span>
  )
}

export default function OsPermissions(): JSX.Element {
  const t = useT()
  const [report, setReport] = useState<Report | null>(null)

  const refresh = useCallback(() => {
    void window.api.permissions.report().then((r) => setReport(r as Report))
  }, [])

  useEffect(() => {
    refresh()
    // Granting happens in another app entirely, so the answer here goes stale
    // the moment the user leaves — re-read when the window comes back.
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  if (!report) return <div className="set-note">{t('perm.loading')}</div>
  if (!report.supported) return <div className="set-note">{t('perm.notMac')}</div>

  return (
    <>
      {ROWS.map(({ key, askable }) => {
        const state = report[key]
        return (
          <div className="set-row" key={key}>
            <div className="set-rowinfo">
              <span className="set-rowtitle">{t(`perm.${key}`)}</span>
              <span className="set-rowdesc">{t(`perm.${key}Desc`)}</span>
            </div>
            <div className="set-rowctl">
              <StateTag state={state} />
              {askable && state === 'not-determined' ? (
                <Button
                  onClick={() => {
                    void window.api.permissions.ask(key as 'microphone' | 'camera').then(refresh)
                  }}
                >
                  {t('perm.ask')}
                </Button>
              ) : (
                <Button onClick={() => void window.api.permissions.open(key)}>{t('perm.open')}</Button>
              )}
            </div>
          </div>
        )
      })}
      <div className="set-row">
        <div className="set-rowinfo">
          <span className="set-rowdesc">{t('perm.refreshHint')}</span>
        </div>
        <div className="set-rowctl">
          <Button onClick={refresh}>
            <RotateCw size={12} /> {t('perm.refresh')}
          </Button>
        </div>
      </div>
    </>
  )
}
