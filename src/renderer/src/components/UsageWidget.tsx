import { useEffect, useState } from 'react'
import { Gauge, Pin } from 'lucide-react'
import {
  useUsage,
  resetIn,
  used,
  usedColor,
  remaining,
  remainingColor,
  fmtTokens,
  type PlanLimit
} from '../state/usage'
import { useSettings } from '../state/settings'
import { useT } from '../i18n'

// Compact status-bar usage: session/weekly remaining % (colored by threshold),
// expands to full bars + today's per-model spend. Can be pinned to the sidebar.
export default function UsageWidget(): JSX.Element | null {
  const t = useT()
  const today = useUsage((s) => s.today)
  const limits = useUsage((s) => s.limits)
  const pinned = useSettings((s) => s.settings.usagePinned)
  const setSetting = useSettings((s) => s.set)
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
  const pct = (l: PlanLimit): JSX.Element => {
    const v = val(l)
    return <span style={{ color: valColor(v) }}>{v}%</span>
  }
  const bar = (label: string, l: PlanLimit | null): JSX.Element | null => {
    if (!l) return null
    const u = val(l)
    const color = valColor(u)
    const reset = resetIn(l.resetsAt)
    return (
      <div className="usage-limit">
        <div className="usage-limit-top">
          <span className="usage-limit-label">{label}</span>
          <span className="usage-limit-pct" style={{ color }}>
            {u}%
          </span>
        </div>
        <div className="usage-limit-track">
          <div className="usage-limit-fill" style={{ width: `${u}%`, background: color }} />
        </div>
        {reset && <div className="usage-limit-reset">{t('usage.resetIn', { t: reset })}</div>}
      </div>
    )
  }

  return (
    <span className="status-item click usage-item" title={t('usage.title')} onClick={() => setOpen((o) => !o)}>
      <Gauge size={13} />
      <span className="usage-item-label">{t('usage.limitsHead')}</span>
      {hasLimits ? (
        <>
          {limits?.session && pct(limits.session)}
          {limits?.weekly && (
            <>
              <span className="usage-sep">·</span>
              {pct(limits.weekly)}
            </>
          )}
        </>
      ) : (
        `$${today!.totalCost.toFixed(2)}`
      )}
      {open && (
        <div className="usage-pop usage-pop-right" onClick={(e) => e.stopPropagation()}>
          <div className="usage-pop-headrow">
            <span className="usage-pop-head">
              {t('usage.limitsHead')} · {t('usage.product')}
            </span>
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
          {bar(t('usage.session'), limits?.session ?? null)}
          {bar(t('usage.weekly'), limits?.weekly ?? null)}
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
