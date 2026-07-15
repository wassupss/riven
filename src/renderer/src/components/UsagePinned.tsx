import { useEffect } from 'react'
import { PinOff } from 'lucide-react'
import { useUsage, resetIn, remaining, remainingColor, fmtTokens, type PlanLimit } from '../state/usage'
import { useSettings } from '../state/settings'
import { useT } from '../i18n'

function fmtReset(t: ReturnType<typeof useT>, iso: string | null): string {
  const r = resetIn(iso)
  return r ? t('usage.resetIn', { t: r }) : ''
}

function Bar({ label, l, reset }: { label: string; l: PlanLimit; reset: string }): JSX.Element {
  const rem = remaining(l)
  const color = remainingColor(rem)
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
      {reset && <div className="usage-limit-reset">{reset}</div>}
    </div>
  )
}

// Pinned usage view — lives at the bottom of the left sidebar for people who want
// it always in view. Shares the usage store with the status-bar widget.
export default function UsagePinned(): JSX.Element | null {
  const t = useT()
  const today = useUsage((s) => s.today)
  const limits = useUsage((s) => s.limits)
  const setSetting = useSettings((s) => s.set)
  useEffect(() => {
    const u = useUsage.getState()
    u.acquire()
    return () => u.release()
  }, [])
  const hasLimits = !!(limits?.session || limits?.weekly)
  const hasToday = !!today && today.totalTokens > 0
  if (!hasLimits && !hasToday) return null

  return (
    <div className="usage-pinned">
      <div className="usage-pinned-head">
        <span>{t('usage.limitsHead')}</span>
        <button
          className="usage-pin"
          title={t('usage.unpin')}
          onClick={() => setSetting({ usagePinned: false })}
        >
          <PinOff size={12} />
        </button>
      </div>
      {limits?.session && (
        <Bar label={t('usage.session')} l={limits.session} reset={fmtReset(t, limits.session.resetsAt)} />
      )}
      {limits?.weekly && (
        <Bar label={t('usage.weekly')} l={limits.weekly} reset={fmtReset(t, limits.weekly.resetsAt)} />
      )}
      {hasToday && (
        <div className="usage-pinned-today">
          {t('usage.today')} · ${today!.totalCost.toFixed(2)} · {fmtTokens(today!.totalTokens)}
        </div>
      )}
    </div>
  )
}
