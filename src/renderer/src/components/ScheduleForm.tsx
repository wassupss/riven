import { useMemo, useState } from 'react'
import { Check, X as XIcon } from 'lucide-react'
import { useT } from '../i18n'
import { listAgents } from '../state/agents'
import { useJobs, type Job, type JobTarget } from '../state/jobs'
import { nextRun, triggerLabel, untilLabel, type Trigger } from '../lib/schedule'
import { CLAUDE_MODELS, CODEX_MODELS } from '../lib/models'

// Describing a piece of scheduled work.
//
// One form, used where the schedule is created (the rail's menu) and where it is
// changed (the panel). It used to exist only in the panel, and only for
// creating: a wrong time meant deleting the job and typing it again.
//
// The controls follow what is being said rather than what is easy to render: a
// rule is chosen from the six that exist, not typed into a dropdown; a time is a
// time field, not two number spinners; and the line underneath says the rule
// back in words with the first firing, because "매일 09:00" and "다음 실행 20시간
// 후" are different questions and both get asked.

type Preset = Trigger['kind']
const PRESETS: Preset[] = ['daily', 'weekdays', 'weekly', 'hourly', 'every', 'once']
const DAYS = ['일', '월', '화', '수', '목', '금', '토']
/** The intervals people actually pick; anything else is typed. */
const EVERY_CHIPS = [10, 30, 60, 180]

const pad = (n: number): string => String(n).padStart(2, '0')

function buildTrigger(preset: Preset, hour: number, minute: number, day: number, every: number): Trigger {
  switch (preset) {
    case 'once': {
      const at = new Date()
      at.setHours(hour, minute, 0, 0)
      // A time already past today means tomorrow: nobody schedules the past.
      if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
      return { kind: 'once', at: at.getTime() }
    }
    case 'every':
      return { kind: 'every', minutes: Math.max(1, every) }
    case 'hourly':
      return { kind: 'hourly', minute }
    case 'weekly':
      return { kind: 'weekly', day, hour, minute }
    case 'weekdays':
      return { kind: 'weekdays', hour, minute }
    default:
      return { kind: 'daily', hour, minute }
  }
}

/** Put an existing job's rule back into the form's controls. */
function readTrigger(trigger: Trigger): { preset: Preset; hour: number; minute: number; day: number; every: number } {
  const base = { preset: trigger.kind, hour: 9, minute: 0, day: 1, every: 30 }
  switch (trigger.kind) {
    case 'once': {
      const d = new Date(trigger.at)
      return { ...base, hour: d.getHours(), minute: d.getMinutes() }
    }
    case 'every':
      return { ...base, every: trigger.minutes }
    case 'hourly':
      return { ...base, minute: trigger.minute }
    case 'weekly':
      return { ...base, day: trigger.day, hour: trigger.hour, minute: trigger.minute }
    default:
      return { ...base, hour: trigger.hour, minute: trigger.minute }
  }
}

export default function ScheduleForm({
  workspace,
  job,
  onDone,
  onCancel
}: {
  workspace: string
  /** Editing an existing job, or undefined to create one. */
  job?: Job
  onDone: () => void
  onCancel?: () => void
}): JSX.Element {
  const t = useT()
  const add = useJobs((s) => s.add)
  const update = useJobs((s) => s.update)
  const start = useMemo(() => (job ? readTrigger(job.trigger) : readTrigger({ kind: 'daily', hour: 9, minute: 0 })), [job])
  const [prompt, setPrompt] = useState(job?.prompt ?? '')
  const [name, setName] = useState(job?.name ?? '')
  const [preset, setPreset] = useState<Preset>(start.preset)
  const [hour, setHour] = useState(start.hour)
  const [minute, setMinute] = useState(start.minute)
  const [day, setDay] = useState(start.day)
  const [every, setEvery] = useState(start.every)
  const [targetPane, setTargetPane] = useState(job?.target.kind === 'pane' ? job.target.chatKey : '')
  const [cli, setCli] = useState<'claude' | 'codex'>(job?.target.kind === 'new' ? job.target.cli : 'claude')
  const [model, setModel] = useState(job?.target.kind === 'new' ? job.target.model ?? 'default' : 'default')
  const [hint, setHint] = useState<string | null>(null)

  const panes = useMemo(() => listAgents(workspace), [workspace])
  const trigger = buildTrigger(preset, hour, minute, day, every)
  const firstRun = nextRun(trigger, Date.now())

  const save = (): void => {
    const text = prompt.trim()
    if (!text) {
      setHint(t('sched.needPrompt'))
      return
    }
    const target: JobTarget = targetPane
      ? { kind: 'pane', chatKey: targetPane, title: panes.find((p) => p.id === targetPane)?.title ?? targetPane }
      : { kind: 'new', cli, model }
    const fields = {
      name: name.trim() || text.split('\n')[0].slice(0, 30),
      prompt: text,
      trigger,
      target
    }
    if (job) update(workspace, job.id, fields)
    else add(workspace, { ...fields, enabled: true, graceMinutes: 60 })
    onDone()
  }

  return (
    <div className="sf">
      <textarea
        className="sf-prompt"
        placeholder={t('sched.promptPlaceholder')}
        value={prompt}
        rows={3}
        autoFocus
        onChange={(e) => setPrompt(e.target.value)}
      />

      <div className="sf-chips">
        {PRESETS.map((p) => (
          <button
            key={p}
            className={`sf-chip${preset === p ? ' on' : ''}`}
            onClick={() => setPreset(p)}
          >
            {t(`sched.preset.${p}`)}
          </button>
        ))}
      </div>

      <div className="sf-when">
        {preset === 'weekly' && (
          <span className="sf-days">
            {DAYS.map((d, i) => (
              <button key={d} className={`sf-day${day === i ? ' on' : ''}`} onClick={() => setDay(i)}>
                {d}
              </button>
            ))}
          </span>
        )}
        {preset === 'every' ? (
          <>
            {EVERY_CHIPS.map((m) => (
              <button key={m} className={`sf-chip${every === m ? ' on' : ''}`} onClick={() => setEvery(m)}>
                {m % 60 === 0 ? `${m / 60}시간` : `${m}분`}
              </button>
            ))}
            <input
              className="sf-num"
              type="number"
              min={1}
              value={every}
              aria-label={t('sched.minutes')}
              onChange={(e) => setEvery(Number(e.target.value) || 1)}
            />
          </>
        ) : preset === 'hourly' ? (
          <label className="sf-inline">
            {t('sched.atMinute')}
            <input
              className="sf-num"
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
            />
          </label>
        ) : (
          // A time is a time field: two spinners for hour and minute was the
          // form asking the person to do the parsing.
          <input
            className="sf-time"
            type="time"
            value={`${pad(hour)}:${pad(minute)}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number)
              if (Number.isFinite(h)) setHour(h)
              if (Number.isFinite(m)) setMinute(m)
            }}
          />
        )}
      </div>

      <div className="sf-target">
        <select className="sf-sel" value={targetPane} onChange={(e) => setTargetPane(e.target.value)}>
          <option value="">{t('sched.newPane')}</option>
          {panes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        {!targetPane && (
          <>
            <select
              className="sf-sel"
              value={cli}
              onChange={(e) => {
                setCli(e.target.value as 'claude' | 'codex')
                setModel('default')
              }}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <select className="sf-sel" value={model} onChange={(e) => setModel(e.target.value)}>
              {(cli === 'codex' ? CODEX_MODELS : CLAUDE_MODELS).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <input
        className="sf-name"
        placeholder={t('sched.namePlaceholder')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      {/* The rule said back, with when it first fires: two different questions,
          both of which get asked out loud while filling this in. */}
      <div className="sf-preview">
        <span className="sf-rule">{triggerLabel(trigger)}</span>
        <span className="sf-next">{t('sched.next', { when: untilLabel(firstRun, Date.now()) })}</span>
      </div>

      {hint && <div className="sf-hint">{hint}</div>}

      <div className="sf-actions">
        {onCancel && (
          <button className="sf-btn" onClick={onCancel}>
            <XIcon size={12} /> {t('sched.cancel')}
          </button>
        )}
        <button className="sf-btn primary" onClick={save}>
          <Check size={12} /> {job ? t('sched.saveEdit') : t('sched.save')}
        </button>
      </div>
    </div>
  )
}
