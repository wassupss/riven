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

  // The header names whose budget this is and shows BOTH windows as bars:
  // the 5-hour session is what stops you this afternoon, the weekly one what
  // stops you on Thursday, and showing only the tighter of the two hid
  // whichever was not currently winning. Details stay one click away.
  const account = pickAccount(accounts, { byWorkspace, globalId, workspace: activeWorkspace })
  const session = account?.limits?.session ?? limits?.session ?? null
  const weekly = account?.limits?.weekly ?? limits?.weekly ?? null
  const agentName = account?.cli === 'codex' ? t('usage.cli.codex') : t('usage.cli.claude')
  // Codex reports its own window length; "weekly" is only right when it is 7 days.
  const codexDays = account?.cli === 'codex' ? Math.round((account.codexWindowMinutes ?? 0) / 1440) : 0
  const weeklyLabel = codexDays && codexDays !== 7 ? t('usage.daysShort', { d: String(codexDays) }) : t('usage.weeklyShort')
  const windows = [
    session && { key: 'session', label: t('usage.sessionShort'), l: session },
    weekly && { key: 'weekly', label: weeklyLabel, l: weekly }
  ].filter(Boolean) as Array<{ key: string; label: string; l: PlanLimit }>

  const describe = (label: string, l: PlanLimit): string => {
    const v = val(l)
    const reset = resetIn(l.resetsAt)
    return [
      `${label} ${showUsed ? t('usage.usedPct', { n: v }) : t('usage.leftPct', { n: v })}`,
      reset ? t('usage.resetIn', { t: reset }) : ''
    ]
      .filter(Boolean)
      .join(' ')
  }
  const compactTitle = [
    agentName,
    ...windows.map((w) => describe(w.label, w.l)),
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
      <span className="usage-agent">{agentName}</span>
      {windows.length ? (
        windows.map((w) => {
          const v = val(w.l)
          const color = valColor(v)
          return (
            <span key={w.key} className="usage-window">
              <span className="usage-window-label">{w.label}</span>
              <span className="usage-track">
                <span className="usage-track-fill" style={{ width: `${v}%`, background: color }} />
              </span>
              <span className="usage-pct" style={{ color }}>
                {v}%
              </span>
            </span>
          )
        })
      ) : (
        <span>{`$${today!.totalCost.toFixed(2)}`}</span>
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
