import { useAuth } from '../state/auth'
import { useT } from '../i18n'

function ProviderIcon({ provider }: { provider: 'google' | 'github' }): JSX.Element {
  if (provider === 'github') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.1-.75.4-1.27.73-1.56-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.52 12.27c0-.82-.07-1.6-.2-2.36H12v4.47h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.74Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.29a12 12 0 0 0 0 10.78l3.98-3.1Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.29 6.61l3.98 3.1C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  )
}

export default function AccountSettings(): JSX.Element {
  const t = useT()
  const configured = useAuth((s) => s.configured)
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const syncStatus = useAuth((s) => s.syncStatus)
  const error = useAuth((s) => s.error)
  const signIn = useAuth((s) => s.signIn)
  const signOut = useAuth((s) => s.signOut)
  const syncNow = useAuth((s) => s.syncNow)

  if (!configured) {
    return (
      <>
        <div className="section-label">{t('settings.account.title')}</div>
        <div className="set-note">{t('settings.account.notConfigured')}</div>
        <div className="set-note account-code">
          VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
        </div>
      </>
    )
  }

  if (user) {
    const name = (user.user_metadata?.name as string) || (user.user_metadata?.full_name as string) || user.email || 'user'
    const avatar = user.user_metadata?.avatar_url as string | undefined
    const syncLabel =
      syncStatus === 'syncing'
        ? t('settings.account.syncing')
        : syncStatus === 'synced'
          ? t('settings.account.synced')
          : syncStatus === 'error'
            ? t('settings.account.syncError')
            : ''
    return (
      <>
        <div className="section-label">{t('settings.account.title')}</div>
        <div className="account-card">
          {avatar ? (
            <img className="account-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="account-avatar account-avatar-fallback">{name.slice(0, 1).toUpperCase()}</div>
          )}
          <div className="account-meta">
            <div className="account-name">{name}</div>
            {user.email && <div className="account-email">{user.email}</div>}
          </div>
          <button className="btn-small" onClick={() => void signOut()}>
            {t('settings.account.signOut')}
          </button>
        </div>

        <div className="set-row account-sync-row">
          <span className={`account-sync-status account-sync-${syncStatus}`}>{syncLabel}</span>
          <button className="btn-small" onClick={() => void syncNow()} disabled={syncStatus === 'syncing'}>
            {t('settings.account.syncNow')}
          </button>
        </div>
        <div className="set-note">{t('settings.account.syncNote')}</div>
        {error && <div className="set-note account-error">{error}</div>}
      </>
    )
  }

  const busy = status === 'loading'
  return (
    <>
      <div className="section-label">{t('settings.account.title')}</div>
      <div className="set-note">{t('settings.account.signInIntro')}</div>
      <div className="account-providers">
        <button className="account-provider-btn" disabled={busy} onClick={() => void signIn('github')}>
          <ProviderIcon provider="github" />
          <span>{t('settings.account.continueGithub')}</span>
        </button>
      </div>
      {busy && <div className="set-note">{t('settings.account.waiting')}</div>}
      <div className="set-note">{t('settings.account.syncNote')}</div>
      {error && <div className="set-note account-error">{error}</div>}
    </>
  )
}
