import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  useUsage,
  resetIn,
  remaining,
  remainingColor,
  fmtTokens,
  type AccountUsage,
  type PlanLimit
} from '../state/usage'
import { useSettings } from '../state/settings'
import { useSession } from '../state/session'
import { useT } from '../i18n'

function Bar({ label, l, t }: { label: string; l: PlanLimit; t: ReturnType<typeof useT> }): JSX.Element {
  const rem = remaining(l)
  const color = remainingColor(rem)
  const reset = resetIn(l.resetsAt)
  return (
    <div className="usage-limit">
      <div className="usage-limit-top">
        <span className="usage-limit-label">{label}</span>
        <span className="usage-limit-pct" style={{ color }}>
          {rem}%
        </span>
      </div>
      <div className="usage-limit-track">
        <div className="usage-limit-fill" style={{ width: `${rem}%`, background: color }} />
      </div>
      {reset && <div className="usage-limit-reset">{t('usage.resetIn', { t: reset })}</div>}
    </div>
  )
}

// Usage per account, as an accordion.
//
// Usage belongs to whichever ACCOUNT ran the agent, so a single set of bars is a
// lie as soon as a second account exists: the workspace you are looking at may be
// pinned to a different Claude login than the global default. The section for the
// current workspace's account opens by default and the rest stay folded, so the
// common case reads at a glance without the panel growing with every account.
export default function UsageAccounts(): JSX.Element | null {
  const t = useT()
  const accounts = useUsage((s) => s.accounts)
  const profiles = useSettings((s) => s.settings.claudeProfiles)
  const byWs = useSettings((s) => s.settings.claudeProfileByWorkspace)
  const globalId = useSettings((s) => s.settings.claudeProfileId)
  const activeWs = useSession((s) => s.activeWorkspace)
  const [openId, setOpenId] = useState<string | null>(null)

  // Rows come from SETTINGS (reactive), data is looked up by id. Deriving the row
  // list from the fetched data instead made accounts appear late: the first fetch
  // runs before settings finish loading, so a second account stayed invisible
  // until something refreshed the store.
  type Row = { id: string; cli: 'claude' | 'codex'; label: string }
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const rows: Row[] = profiles.length
    ? profiles.map((p) => ({ id: p.id, cli: 'claude', label: p.label }))
    : [{ id: 'claude', cli: 'claude', label: '' }]
  if (accounts.some((a) => a.cli === 'codex')) rows.push({ id: 'codex', cli: 'codex', label: '' })
  if (!rows.length) return null

  // The account this workspace's agents actually run as (workspace override
  // first, then the global default, then the single implicit login).
  const currentId = (activeWs && byWs[activeWs]) || globalId || 'claude'
  const known = rows.some((r) => r.id === currentId)
  const open = openId ?? (known ? currentId : rows[0].id)

  const title = (cli: 'claude' | 'codex'): string =>
    cli === 'codex' ? t('usage.cli.codex') : t('usage.cli.claude')

  // A one-glance number for a folded row: the tightest window's remaining %, or
  // today's tokens when the account reports no window.
  const summary = (a: AccountUsage | undefined): JSX.Element => {
    if (!a) return <span className="usage-acc-sum dim">{t('settings.account.aiChecking')}</span>
    const l = a.limits?.session ?? a.limits?.weekly
    if (l) {
      const rem = remaining(l)
      return (
        <span className="usage-acc-sum" style={{ color: remainingColor(rem) }}>
          {rem}%
        </span>
      )
    }
    if (a.today?.totalTokens) return <span className="usage-acc-sum">{fmtTokens(a.today.totalTokens)}</span>
    return <span className="usage-acc-sum dim">{t('usage.noData')}</span>
  }

  return (
    <div className="usage-accs">
      {rows.map((row) => {
        const a = byId.get(row.id)
        const isOpen = row.id === open
        const hasToday = !!a?.today && a.today.totalTokens > 0
        return (
          <div className={`usage-acc${isOpen ? ' open' : ''}`} key={row.id}>
            <button
              className="usage-acc-head"
              onClick={() => setOpenId(isOpen ? '' : row.id)}
              aria-expanded={isOpen}
            >
              <ChevronRight size={12} className="usage-acc-chev" />
              <span className="usage-acc-name">{title(row.cli)}</span>
              {/* The account name only matters once there are several to tell apart. */}
              {row.cli === 'claude' && profiles.length > 0 && (
                <span className="usage-acc-sub">{row.label}</span>
              )}
              {rows.length > 1 && row.id === currentId && (
                <span className="usage-acc-here">{t('usage.thisWorkspace')}</span>
              )}
              {summary(a)}
            </button>
            {isOpen && a && (
              <div className="usage-acc-body">
                {a.limits?.session && <Bar label={t('usage.session')} l={a.limits.session} t={t} />}
                {a.limits?.weekly && (
                  <Bar
                    label={
                      row.cli === 'codex'
                        ? t('usage.codexWindow', { d: String(Math.round((a.codexWindowMinutes ?? 0) / 1440)) })
                        : t('usage.weekly')
                    }
                    l={a.limits.weekly}
                    t={t}
                  />
                )}
                {hasToday ? (
                  <div className="usage-acc-today">
                    {t('usage.today')} · {fmtTokens(a.today!.totalTokens)}
                    {/* Codex tokens are counted but not priced: its models are not
                        in riven's Claude rate table, so a dollar figure would be
                        made up. */}
                    {row.cli === 'claude' && ` · $${a.today!.totalCost.toFixed(2)}`}
                  </div>
                ) : (
                  <div className="usage-acc-today dim">{t('usage.noneToday')}</div>
                )}
                {/* The endpoint rate limits, so bars can be a cached read rather
                    than vanishing. Say which it is instead of quietly showing an
                    old number. */}
                {a.limits?.stale && (a.limits.session || a.limits.weekly) && (
                  <div className="usage-acc-today dim">{t('usage.stale')}</div>
                )}
                {!a.limits?.session && !a.limits?.weekly && (
                  <div className="usage-acc-today dim">{t('usage.noLimits')}</div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
