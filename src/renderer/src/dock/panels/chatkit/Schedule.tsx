import { useState } from 'react'
import { Clock, X as XIcon } from 'lucide-react'
import { useT } from '../../../i18n'
import { useJobs, nextRunOf } from '../../../state/jobs'
import { type Trigger } from '../../../lib/schedule'

// "이 챗 예약": send the composer's text to THIS pane later, once or on a
// repeat. Shared by the chat panes. It is a Job with a pane target (one
// scheduler, not two), so it also shows in 예약 작업 beside everything else.

/** The popover's own vocabulary for how often; a Job trigger is built from it. */
export type Repeat = 'none' | 'hourly' | 'daily'

interface Pending {
  id: string
  text: string
  fireAt: number
  repeat: Repeat
}

export function triggerFor(fireAt: number, repeat: Repeat): Trigger {
  const when = new Date(fireAt)
  return repeat === 'hourly'
    ? { kind: 'hourly', minute: when.getMinutes() }
    : repeat === 'daily'
      ? { kind: 'daily', hour: when.getHours(), minute: when.getMinutes() }
      : { kind: 'once', at: fireAt }
}

function SchedulePopover({
  hasText,
  repeat,
  setRepeat,
  onSchedule,
  pending,
  onCancel,
  onClose
}: {
  hasText: boolean
  repeat: Repeat
  setRepeat: (r: Repeat) => void
  onSchedule: (fireAt: number) => void
  pending: Pending[]
  onCancel: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const presets: Array<[string, number]> = [
    [t('chat.schedule.p5m'), 5 * 60_000],
    [t('chat.schedule.p15m'), 15 * 60_000],
    [t('chat.schedule.p30m'), 30 * 60_000],
    [t('chat.schedule.p1h'), 60 * 60_000],
    [t('chat.schedule.p3h'), 180 * 60_000]
  ]
  const [dt, setDt] = useState('')
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const repeatTag = (r: Repeat): string =>
    r === 'hourly' ? ' · ' + t('chat.schedule.hourly') : r === 'daily' ? ' · ' + t('chat.schedule.daily') : ''
  return (
    <div className="chat-sched-pop">
      <div className="chat-sched-head">
        <span>{t('chat.schedule.title')}</span>
        <button className="chat-sched-x" onClick={onClose}>
          <XIcon size={12} />
        </button>
      </div>
      <div className="chat-sched-repeat">
        {(['none', 'hourly', 'daily'] as Repeat[]).map((r) => (
          <button key={r} className={`chat-sched-rep${repeat === r ? ' on' : ''}`} onClick={() => setRepeat(r)}>
            {r === 'none' ? t('chat.schedule.once') : r === 'hourly' ? t('chat.schedule.hourly') : t('chat.schedule.daily')}
          </button>
        ))}
      </div>
      {hasText ? (
        <>
          <div className="chat-sched-presets">
            {presets.map(([label, ms]) => (
              <button key={label} className="chat-sched-preset" onClick={() => onSchedule(Date.now() + ms)}>
                {label}
              </button>
            ))}
          </div>
          <div className="chat-sched-exact">
            <input type="datetime-local" className="ui-input" value={dt} onChange={(e) => setDt(e.target.value)} />
            <button
              className="ui-btn ui-btn-primary"
              disabled={!dt}
              onClick={() => {
                const ms = new Date(dt).getTime()
                if (Number.isFinite(ms)) onSchedule(ms)
              }}
            >
              {t('chat.schedule.set')}
            </button>
          </div>
        </>
      ) : (
        <div className="chat-sched-empty">{t('chat.schedule.needText')}</div>
      )}
      {pending.length > 0 && (
        <div className="chat-sched-list">
          {pending.map((s) => (
            <div key={s.id} className="chat-sched-item">
              <span className="chat-sched-when">
                {fmt(s.fireAt)}
                {repeatTag(s.repeat)}
              </span>
              <span className="chat-sched-text">{s.text}</span>
              <button className="chat-sched-x" onClick={() => onCancel(s.id)}>
                <XIcon size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The clock button in the composer's action row and its popover. `getText`
 * reads the composer at the moment of scheduling; `onScheduled` empties it.
 * Lives in .chat-actions; the popover is placed against .chat-composer.
 */
export default function ScheduleControl({
  workspace,
  chatKey,
  getTitle,
  getText,
  onScheduled
}: {
  workspace: string
  chatKey: string
  getTitle: () => string
  getText: () => string
  onScheduled: () => void
}): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [repeat, setRepeat] = useState<Repeat>('none')
  const jobs = useJobs((s) => s.byWorkspace[workspace])
  const pending: Pending[] = (jobs ?? [])
    .filter((j) => j.enabled && j.target.kind === 'pane' && j.target.chatKey === chatKey)
    .map((j) => ({
      id: j.id,
      text: j.prompt,
      fireAt: nextRunOf(j) ?? 0,
      repeat: (j.trigger.kind === 'hourly' ? 'hourly' : j.trigger.kind === 'daily' ? 'daily' : 'none') as Repeat
    }))
    .sort((a, b) => a.fireAt - b.fireAt)
  const schedule = (fireAt: number): void => {
    const text = getText().trim()
    if (!text || fireAt <= Date.now()) return
    useJobs.getState().add(workspace, {
      name: text.split('\n')[0].slice(0, 30),
      prompt: text,
      trigger: triggerFor(fireAt, repeat),
      target: { kind: 'pane', chatKey, title: getTitle() || 'Claude' },
      enabled: true,
      graceMinutes: 60
    })
    setOpen(false)
    setRepeat('none')
    onScheduled()
  }
  return (
    <>
      <button
        className={`chat-sched-btn${open ? ' on' : ''}${pending.length ? ' has' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={t('chat.schedule.title')}
      >
        <Clock size={14} />
        {pending.length > 0 && <span className="chat-sched-count">{pending.length}</span>}
      </button>
      {open && (
        <SchedulePopover
          hasText={getText().trim().length > 0}
          repeat={repeat}
          setRepeat={setRepeat}
          onSchedule={schedule}
          pending={pending}
          onCancel={(id) => useJobs.getState().remove(workspace, id)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
