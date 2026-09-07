import { useEffect } from 'react'
import { PinOff } from 'lucide-react'
import { useUsage } from '../state/usage'
import UsageAccounts from './UsageAccounts'
import { useSettings } from '../state/settings'
import { useT } from '../i18n'

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
      <UsageAccounts />
    </div>
  )
}
