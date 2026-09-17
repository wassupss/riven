import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  useUsage,
  resetIn,
  used,
  usedColor,
  remaining,
  remainingColor,
  fmtTokens,
  type AccountUsage,
  type PlanLimit
} from '../state/usage'
import { useSettings } from '../state/settings'
import { useSession } from '../state/session'
import { useT } from '../i18n'

type T = ReturnType<typeof useT>

// One number per window, and it means the same thing everywhere: the status bar
// and this list both follow the "used / left" setting. The popover used to show
// "65%" left under a status bar that said "35%" used, with nothing saying which.
function pctOf(l: PlanLimit, showUsed: boolean): { v: number; color: string } {
  const v = showUsed ? used(l) : remaining(l)
  return { v, color: showUsed ? usedColor(v) : remainingColor(v) }
}

function pctText(v: number, showUsed: boolean, t: T): string {
  return showUsed ? t('usage.usedPct', { n: v }) : t('usage.leftPct', { n: v })
}

function Window({
  name,
  span,
  l,
  showUsed,
  t
}: {
  name: string
  span: string
  l: PlanLimit
  showUsed: boolean
  t: T
}): JSX.Element {
  const { v, color } = pctOf(l, showUsed)
  const reset = resetIn(l.resetsAt)
  return (
    <div className="usage-win">
      <div className="usage-win-top">
        <span className="usage-win-name">{name}</span>
        <span className="usage-win-span">{span}</span>
        <span className="usage-win-pct" style={{ color }}>
          {pctText(v, showUsed, t)}
        </span>
      </div>
      <div className="usage-limit-track">
        <div className="usage-limit-fill" style={{ width: `${v}%`, background: color }} />
      </div>
      {reset && <div className="usage-win-reset">{t('usage.resetIn', { t: reset })}</div>}
    </div>
  )
}

// "claude-opus-5" → "opus-5", "claude-haiku-4-5-20251001" → "haiku-4-5": the
// vendor prefix and the snapshot date are the same on every row.
function modelLabel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

// Usage per account.
//
// Usage belongs to whichever ACCOUNT ran the agent, so a single set of bars is a
// lie as soon as a second account exists: the workspace you are looking at may be
// pinned to a different Claude login than the global default. The current
// workspace's account opens by default; the rest fold to a one-line summary.
export default function UsageAccounts(): JSX.Element | null {
  const t = useT()
  const accounts = useUsage((s) => s.accounts)
  const profiles = useSettings((s) => s.settings.claudeProfiles)
  const byWs = useSettings((s) => s.settings.claudeProfileByWorkspace)
  const globalId = useSettings((s) => s.settings.claudeProfileId)
  const showUsed = useSettings((s) => s.settings.usageShowUsed)
  const activeWs = useSession((s) => s.activeWorkspace)
  const [openId, setOpenId] = useState<string | null>(null)

  // Rows come from SETTINGS (reactive), data is looked up by id. Deriving the row
  // list from the fetched data instead made accounts appear late: the first fetch
  // runs before settings finish loading, so a second account stayed invisible
  // until something refreshed the store.
  type Row = { id: string; cli: 'claude' | 'codex'; label: string }
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const all: Row[] = profiles.length
    ? profiles.map((p) => ({ id: p.id, cli: 'claude', label: p.label }))
    : [{ id: 'claude', cli: 'claude', label: '' }]
  if (accounts.some((a) => a.cli === 'codex')) all.push({ id: 'codex', cli: 'codex', label: '' })
  // An account with nothing to report is a row that only says "none". Still
  // loading is different — that row stays so it can fill in.
  const hasData = (a: AccountUsage | undefined): boolean =>
    !a || !!a.limits?.session || !!a.limits?.weekly || (a.today?.totalTokens ?? 0) > 0
  const withData = all.filter((r) => hasData(byId.get(r.id)))
  const rows = withData.length ? withData : all.slice(0, 1)
  if (!rows.length) return null

  // The account this workspace's agents actually run as (workspace override
  // first, then the global default, then the single implicit login).
  const currentId = (activeWs && byWs[activeWs]) || globalId || 'claude'
  const known = rows.some((r) => r.id === currentId)
  const open = openId ?? (known ? currentId : rows[0].id)
  const foldable = rows.length > 1

  const title = (cli: 'claude' | 'codex'): string =>
    cli === 'codex' ? t('usage.cli.codex') : t('usage.cli.claude')

  // A folded row still answers "how much, for which agent" in words.
  const summary = (a: AccountUsage | undefined): JSX.Element => {
    if (!a) return <span className="usage-acc-sum dim">{t('settings.account.aiChecking')}</span>
    const l = a.limits?.session ?? a.limits?.weekly
    if (l) {
      const { v, color } = pctOf(l, showUsed)
      return (
        <span className="usage-acc-sum" style={{ color }}>
          {pctText(v, showUsed, t)}
        </span>
      )
    }
    return <span className="usage-acc-sum dim">{fmtTokens(a.today?.totalTokens ?? 0)}</span>
  }

  return (
    <div className="usage-accs">
      {rows.map((row) => {
        const a = byId.get(row.id)
        const isOpen = !foldable || row.id === open
        const today = a?.today && a.today.totalTokens > 0 ? a.today : null
        const models = today ? [...today.perModel].sort((x, y) => y.cost - x.cost || y.input - x.input) : []
        const codexDays = Math.round((a?.codexWindowMinutes ?? 0) / 1440)
        return (
          <section className={`usage-acc${isOpen ? ' open' : ''}`} key={row.id}>
            <button
              className={`usage-acc-head${foldable ? '' : ' static'}`}
              onClick={() => foldable && setOpenId(isOpen ? '' : row.id)}
              aria-expanded={isOpen}
            >
              {foldable && <ChevronRight size={12} className="usage-acc-chev" />}
              <span className="usage-acc-name">{title(row.cli)}</span>
              {/* The account name only matters once there are several to tell apart. */}
              {row.cli === 'claude' && profiles.length > 1 && row.label && (
                <span className="usage-acc-sub">{row.label}</span>
              )}
              {foldable && row.id === currentId && <span className="usage-acc-here">{t('usage.thisWorkspace')}</span>}
              {!isOpen && summary(a)}
            </button>
            {isOpen && a && (
              <div className="usage-acc-body">
                {a.limits?.session && (
                  <Window
                    name={t('usage.sessionShort')}
                    span={t('usage.span5h')}
                    l={a.limits.session}
                    showUsed={showUsed}
                    t={t}
                  />
                )}
                {a.limits?.weekly && (
                  <Window
                    name={row.cli === 'codex' && codexDays && codexDays !== 7 ? t('usage.windowShort') : t('usage.weeklyShort')}
                    span={row.cli === 'codex' && codexDays ? t('usage.spanDays', { d: String(codexDays) }) : t('usage.span7d')}
                    l={a.limits.weekly}
                    showUsed={showUsed}
                    t={t}
                  />
                )}
                {/* The endpoint rate limits, so bars can be a cached read rather
                    than vanishing. Say which it is instead of quietly showing an
                    old number. */}
                {a.limits?.stale && (a.limits.session || a.limits.weekly) && (
                  <div className="usage-acc-note">{t('usage.stale')}</div>
                )}
                {!a.limits?.session && !a.limits?.weekly && (
                  <div className="usage-acc-note">{t('usage.noLimits')}</div>
                )}
                <div className="usage-today">
                  <div className="usage-today-head">
                    <span>{t('usage.todayShort')}</span>
                    {today ? (
                      <span className="usage-today-total">
                        {/* Codex tokens are counted but not priced: its models
                            are not in riven's Claude rate table, so a dollar
                            figure would be made up. */}
                        {row.cli === 'claude' && <b>${today.totalCost.toFixed(2)}</b>}
                        <span>{t('usage.tokens', { n: fmtTokens(today.totalTokens) })}</span>
                      </span>
                    ) : (
                      <span className="usage-today-total dim">{t('usage.noneToday')}</span>
                    )}
                  </div>
                  {models.length > 1 &&
                    models.map((m) => (
                      <div key={m.model} className="usage-row" title={m.model}>
                        <span className="usage-model">{modelLabel(m.model)}</span>
                        <span className="usage-tok">{fmtTokens(m.input + m.output + m.cacheWrite + m.cacheRead)}</span>
                        {row.cli === 'claude' && <span className="usage-cost">${m.cost.toFixed(2)}</span>}
                      </div>
                    ))}
                </div>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
