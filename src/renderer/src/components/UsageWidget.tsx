import { useEffect, useState } from 'react'
import { Pin } from 'lucide-react'
import {
  useUsage,
  resetIn,
  used,
  usedColor,
  remaining,
  remainingColor,
  fmtTokens,
  pickAccount,
  tightestLimit,
  type PlanLimit
} from '../state/usage'
import { useSettings } from '../state/settings'
import { useSession } from '../state/session'
import UsageAccounts from './UsageAccounts'
import { useT } from '../i18n'

// Compact status-bar usage: session/weekly remaining % (colored by threshold),
// expands to full bars + today's per-model spend. Can be pinned to the sidebar.
export default function UsageWidget(): JSX.Element | null {
  const t = useT()
  const today = useUsage((s) => s.today)
  const limits = useUsage((s) => s.limits)
  const pinned = useSettings((s) => s.settings.usagePinned)
  const setSetting = useSettings((s) => s.set)
  const accounts = useUsage((s) => s.accounts)
  const byWorkspace = useSettings((s) => s.settings.claudeProfileByWorkspace)
  const globalId = useSettings((s) => s.settings.claudeProfileId)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  // MUST stay above the early return below — a hook after a conditional return
  // changes the hook count when the widget flips empty->has-data (first launch /
  // post-login), which crashes the whole React tree ("rendered more hooks").
  const showUsed = useSettings((s) => s.settings.usageShowUsed)
  // Poll usage only while this widget is mounted (see useUsage.acquire).
  useEffect(() => {
    const u = useUsage.getState()
    u.acquire()
    return () => u.release()
  }, [])
  const [open, setOpen] = useState(false)

  const hasLimits = !!(limits?.session || limits?.weekly)
  const hasToday = !!today && today.totalTokens > 0
  // When pinned to the sidebar, hide the compact status-bar copy.
  if (pinned || (!hasLimits && !hasToday)) return null

  const val = (l: PlanLimit): number => (showUsed ? used(l) : remaining(l))
  const valColor = (v: number): string => (showUsed ? usedColor(v) : remainingColor(v))
  // The per-window bars in the popover come from UsageAccounts, which draws
  // them per account — the widget itself only needs the headline.

  // The header shows ONE bar: the account this workspace runs as, and its
  // tightest window. Two bare percentages side by side said neither whose they
  // were nor which window was which — with Codex and several Claude logins in
  // play, a number with no name on it can't be acted on. The rest (both
  // windows, every account, today's spend) is one click away, below.
  const account = pickAccount(accounts, { byWorkspace, globalId, workspace: activeWorkspace })
  const headline = tightestLimit(account) ?? limits?.session ?? limits?.weekly ?? null
  const agentName = account?.cli === 'codex' ? t('usage.cli.codex') : t('usage.cli.claude')
  const headlineValue = headline ? val(headline) : 0
  const headlineColor = headline ? valColor(headlineValue) : undefined
  const reset = headline ? resetIn(headline.resetsAt) : ''
  const compactTitle = [
    agentName,
    headline ? (showUsed ? t('usage.usedPct', { n: headlineValue }) : t('usage.leftPct', { n: headlineValue })) : '',
    reset ? t('usage.resetIn', { t: reset }) : '',
    hasToday ? `$${today!.totalCost.toFixed(2)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <span
      className="status-item click usage-item"
      title={compactTitle || t('usage.title')}
      onClick={() => setOpen((o) => !o)}
    >
      {headline ? (
        <>
          <span className="usage-agent">{agentName}</span>
          <span className="usage-track">
            <span className="usage-track-fill" style={{ width: `${headlineValue}%`, background: headlineColor }} />
          </span>
          <span className="usage-pct" style={{ color: headlineColor }}>
            {headlineValue}%
          </span>
        </>
      ) : (
        <>
          <span className="usage-agent">{agentName}</span>
          <span>{`$${today!.totalCost.toFixed(2)}`}</span>
        </>
      )}
      {open && (
        <div className="usage-pop usage-pop-right" onClick={(e) => e.stopPropagation()}>
          <div className="usage-pop-headrow">
            <span className="usage-pop-head">{t('usage.limitsHead')}</span>
            <button
              className="usage-pin"
              title={t('usage.pin')}
              onClick={() => {
                setSetting({ usagePinned: true })
                setOpen(false)
              }}
            >
              <Pin size={12} /> {t('usage.pin')}
            </button>
          </div>
          {/* Per-account accordion: which CLI, which login, and the current
              workspace's account open by default. */}
          <UsageAccounts />
          {hasToday && (
            <>
              <div className="usage-pop-head">
                {t('usage.today')} — ${today!.totalCost.toFixed(2)} · {fmtTokens(today!.totalTokens)}
              </div>
              {today!.perModel.map((m) => (
                <div key={m.model} className="usage-row">
                  <span className="usage-model">{m.model}</span>
                  <span className="usage-tok">{fmtTokens(m.input + m.output + m.cacheWrite + m.cacheRead)}</span>
                  <span className="usage-cost">${m.cost.toFixed(2)}</span>
                </div>
              ))}
            </>
          )}
          <div className="usage-note">{t('usage.note')}</div>
        </div>
      )}
    </span>
  )
}
