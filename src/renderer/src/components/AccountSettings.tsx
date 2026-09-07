import { useEffect, useState } from 'react'
import { useAuth } from '../state/auth'
import { addTerminal } from '../dock/registry'
import { useUI } from '../state/ui'
import { useSettings } from '../state/settings'
import { promptInput } from './promptInput'
import { Button } from './ui/Controls'
import { useT } from '../i18n'

interface AiAccount {
  id: 'claude' | 'codex'
  name: string
  loggedIn: boolean | null
  plan?: string
  email?: string
  org?: string
  mode?: 'subscription' | 'apikey'
  configDir?: string
}

// Claude account profiles. riven stores only the CLAUDE_CONFIG_DIR of each; WHO
// each one is logged in as is asked of the CLI every time (`claude auth status`,
// ~180ms), so nothing here can go stale or disagree with the terminal.
function ClaudeProfiles(): JSX.Element | null {
  const t = useT()
  const profiles = useSettings((s) => s.settings.claudeProfiles)
  const activeId = useSettings((s) => s.settings.claudeProfileId)
  const set = useSettings((s) => s.set)
  const [who, setWho] = useState<Record<string, AiAccount | null>>({})

  // One query per profile, in parallel, only while this panel is open.
  useEffect(() => {
    let dead = false
    void Promise.all(
      profiles.map(async (p) => {
        const list = await window.api.chat.accounts(p.dir ?? undefined)
        return [p.id, list.find((a) => a.id === 'claude') ?? null] as const
      })
    ).then((pairs) => {
      if (!dead) setWho(Object.fromEntries(pairs))
    })
    return () => {
      dead = true
    }
  }, [profiles])

  const addProfile = async (): Promise<void> => {
    const label = await promptInput({
      title: t('settings.account.profileNamePrompt'),
      initial: t('settings.account.profileDefaultName')
    })
    if (!label?.trim()) return
    const id = Math.random().toString(36).slice(2, 10)
    const dir = await window.api.chat.profileDir(id)
    // The FIRST time, adopt the existing login as a `dir: null` profile: nothing
    // is moved and the user is never asked to sign in again for it.
    const base = profiles.length
      ? profiles
      : [{ id: 'default', label: t('settings.account.defaultProfile'), dir: null }]
    set({
      claudeProfiles: [...base, { id, label: label.trim(), dir }],
      claudeProfileId: activeId ?? base[0].id
    })
    // Sign in to the new profile in a terminal — the CLI owns that browser flow.
    addTerminal(`CLAUDE_CONFIG_DIR=${JSON.stringify(dir)} claude auth login`)
    useUI.getState().setSettingsOpen(false)
  }

  const removeProfile = (id: string): void => {
    const left = profiles.filter((p) => p.id !== id)
    set({
      // Dropping back to one profile removes the concept again: with a single
      // `dir: null` entry riven injects nothing, exactly like a fresh install.
      claudeProfiles: left.length === 1 && left[0].dir === null ? [] : left,
      claudeProfileId: activeId === id ? (left[0]?.id ?? null) : activeId
    })
  }

  if (!profiles.length)
    return (
      <div className="set-row">
        <Button onClick={() => void addProfile()}>{t('settings.account.addProfile')}</Button>
      </div>
    )

  return (
    <>
      <div className="section-label">{t('settings.account.profilesTitle')}</div>
      {profiles.map((p) => {
        const a = who[p.id]
        const detail = !a
          ? t('settings.account.aiChecking')
          : a.loggedIn
            ? [a.email, a.org, a.plan].filter(Boolean).join(' · ')
            : t('settings.account.aiSignedOut')
        return (
          <div className="ai-account-row" key={p.id}>
            <input
              type="radio"
              name="claude-profile"
              checked={activeId === p.id}
              onChange={() => set({ claudeProfileId: p.id })}
            />
            <div className="ai-account-meta">
              <span className="ai-account-name">{p.label}</span>
              <span className="ai-account-status">{detail}</span>
            </div>
            {a &&
              (a.loggedIn ? (
                <Button
                  onClick={() => {
                    setWho((w) => ({ ...w, [p.id]: null }))
                    void window.api.chat
                      .logout(p.dir ?? undefined)
                      .then(() => window.api.chat.accounts(p.dir ?? undefined))
                      .then((list) =>
                        setWho((w) => ({ ...w, [p.id]: list.find((x) => x.id === 'claude') ?? null }))
                      )
                  }}
                >
                  {t('settings.account.aiLogout')}
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    addTerminal(
                      p.dir
                        ? `CLAUDE_CONFIG_DIR=${JSON.stringify(p.dir)} claude auth login`
                        : 'claude auth login'
                    )
                    useUI.getState().setSettingsOpen(false)
                  }}
                >
                  {t('settings.account.aiLogin')}
                </Button>
              ))}
            <Button onClick={() => removeProfile(p.id)}>{t('settings.account.removeProfile')}</Button>
          </div>
        )
      })}
      <div className="set-row">
        <Button onClick={() => void addProfile()}>{t('settings.account.addProfile')}</Button>
      </div>
      <div className="set-note">{t('settings.account.profilesNote')}</div>
    </>
  )
}

// The AI CLI accounts (Claude Code, Codex) connected via their own `/login`. Read
// locally from each CLI's credential store; login/logout run in a terminal.
function AiAccounts(): JSX.Element {
  const t = useT()
  const [accounts, setAccounts] = useState<AiAccount[] | null>(null)
  const load = (): void => {
    window.api.chat.accounts().then(setAccounts)
  }
  useEffect(load, [])

  const cap = (s?: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')
  const manage = async (a: AiAccount, action: 'login' | 'logout'): Promise<void> => {
    // Logging out asks the user nothing, so it runs in the background and the row
    // refreshes in place. Only login needs a terminal: that one runs a browser
    // OAuth flow and may ask for a code to be pasted back.
    if (a.id === 'claude' && action === 'logout') {
      setAccounts(null)
      await window.api.chat.logout()
      load()
      return
    }
    addTerminal(a.id === 'codex' ? `codex ${action}` : 'claude auth login')
    useUI.getState().setSettingsOpen(false)
  }

  return (
    <>
      <div className="section-label">{t('settings.account.aiTitle')}</div>
      {accounts === null ? (
        <div className="set-note">{t('settings.account.aiChecking')}</div>
      ) : accounts.length === 0 ? (
        <div className="set-note">{t('settings.account.aiNone')}</div>
      ) : (
        accounts.map((a) => {
          const status =
            a.loggedIn === null
              ? t('settings.account.aiUnknown')
              : a.loggedIn
                ? a.mode === 'apikey'
                  ? t('settings.account.aiApiKey')
                  : [a.email, a.org, a.plan && `${cap(a.plan)} ${t('settings.account.aiPlan')}`]
                      .filter(Boolean)
                      .join(' · ') || t('settings.account.aiSignedIn')
                : t('settings.account.aiSignedOut')
          return (
            <div className="ai-account-row" key={a.id}>
              <span className={`ai-account-dot${a.loggedIn ? ' on' : a.loggedIn === false ? ' off' : ''}`} />
              <div className="ai-account-meta">
                <span className="ai-account-name">{a.name}</span>
                <span className="ai-account-status">{status}</span>
              </div>
              <Button onClick={() => void manage(a, a.loggedIn ? 'logout' : 'login')}>
                {a.loggedIn ? t('settings.account.aiLogout') : t('settings.account.aiLogin')}
              </Button>
            </div>
          )
        })
      )}
      <div className="set-note">{t('settings.account.aiNote')}</div>
      <ClaudeProfiles />
    </>
  )
}

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
        <AiAccounts />
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
        <AiAccounts />
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
      <AiAccounts />
    </>
  )
}
