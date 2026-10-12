import { useT } from '../i18n'

// A time as three selects: 오전/오후, hour, minute.
//
// It replaces the native <input type="time">, whose Korean rendering is
// "오전 09:00" in three segments that each have to be clicked and typed in turn.
// Minutes come in 5s; a job saved at some other minute keeps it as an option.
const HOURS12 = Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i))
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)

export function MinuteSelect({
  minute,
  onChange
}: {
  minute: number
  onChange: (minute: number) => void
}): JSX.Element {
  const t = useT()
  const options = MINUTES.includes(minute) ? MINUTES : [...MINUTES, minute].sort((a, b) => a - b)
  return (
    <select className="sf-sel" value={minute} aria-label={t('sched.minute')} onChange={(e) => onChange(Number(e.target.value))}>
      {options.map((m) => (
        <option key={m} value={m}>
          {String(m).padStart(2, '0')}
          {t('sched.minute')}
        </option>
      ))}
    </select>
  )
}

export default function TimeField({
  hour,
  minute,
  onChange
}: {
  hour: number
  minute: number
  onChange: (hour: number, minute: number) => void
}): JSX.Element {
  const t = useT()
  const pm = hour >= 12
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const to24 = (h: number, isPm: boolean): number => (h % 12) + (isPm ? 12 : 0)
  return (
    <span className="tf">
      <select
        className="sf-sel"
        value={pm ? 'pm' : 'am'}
        aria-label={t('sched.time')}
        onChange={(e) => onChange(to24(h12, e.target.value === 'pm'), minute)}
      >
        <option value="am">{t('sched.am')}</option>
        <option value="pm">{t('sched.pm')}</option>
      </select>
      <select
        className="sf-sel"
        value={h12}
        aria-label={t('sched.hour')}
        onChange={(e) => onChange(to24(Number(e.target.value), pm), minute)}
      >
        {HOURS12.map((h) => (
          <option key={h} value={h}>
            {h}
            {t('sched.hour')}
          </option>
        ))}
      </select>
      <MinuteSelect minute={minute} onChange={(m) => onChange(hour, m)} />
    </span>
  )
}
