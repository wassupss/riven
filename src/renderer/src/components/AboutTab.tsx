import { useEffect } from 'react'
import { useUpdate } from '../state/update'
import { useT } from '../i18n'
import logoUrl from '../assets/riven-mark.svg'

// Settings → About: brand mark, version, and the update flow (check / progress /
// "restart to install") so updates are visible somewhere other than a toast.
export default function AboutTab(): JSX.Element {
  const t = useT()
  const status = useUpdate((s) => s.status)
  const version = useUpdate((s) => s.version)
  const init = useUpdate((s) => s.init)
  const check = useUpdate((s) => s.check)
  const install = useUpdate((s) => s.install)

  useEffect(() => {
    init()
  }, [init])

  let line: string
  switch (status.state) {
    case 'checking':
      line = t('about.checking')
      break
    case 'available':
      line = t('about.downloading', { v: status.version })
      break
    case 'downloading':
      line = t('about.progress', { p: String(status.percent) })
      break
    case 'downloaded':
      line = t('about.ready', { v: status.version })
      break
    case 'upToDate':
      line = t('about.upToDate')
      break
    case 'error':
      line = t('about.error', { msg: status.message })
      break
    default:
      line = ''
  }

  const busy = status.state === 'checking' || status.state === 'downloading'

  return (
    <div className="about">
      <div className="about-head">
        <img className="about-logo" src={logoUrl} alt="riven" width={64} height={64} />
        <div className="about-id">
          <div className="about-name">riven</div>
          <div className="about-ver">
            {version ? `v${version}` : ''}
            <span className="about-dim"> · {t('about.tagline')}</span>
          </div>
        </div>
      </div>

      <div className="about-update">
        {status.state === 'downloaded' ? (
          <button className="btn-small about-install" onClick={install}>
            {t('about.install')}
          </button>
        ) : (
          <button className="btn-small" onClick={check} disabled={busy}>
            {t('about.check')}
          </button>
        )}
        {line && (
          <span className={`about-status${status.state === 'error' ? ' err' : ''}`}>{line}</span>
        )}
      </div>

      <div className="about-links">
        <a href="https://github.com/wassupss/riven/releases" target="_blank" rel="noreferrer">
          {t('about.releases')}
        </a>
      </div>
    </div>
  )
}
