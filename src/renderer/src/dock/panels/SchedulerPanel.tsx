import { useEffect, useMemo, useState } from 'react'
import { Clock, Play, Plus, Trash2, Check, X as XIcon, AlertTriangle } from 'lucide-react'
import { useT } from '../../i18n'
import { listAgents } from '../../state/agents'
import { useJobs, nextRunOf, type Job, type JobTarget, type RunStatus } from '../../state/jobs'
import { runJob } from '../../state/jobRunner'
import { triggerLabel, untilLabel, type Trigger } from '../../lib/schedule'
import { CLAUDE_MODELS, CODEX_MODELS } from '../../lib/models'

// Scheduled work for this workspace.
//
// The list answers the three questions a schedule raises — what runs, when it
// runs next, and what happened last time — before any of them have to be asked.
// A run's outcome is the part riven used to drop entirely: the old scheduler
// sent its message and remembered nothing, so "did the 9am one go out?" had no
// answer anywhere in the app.

type Preset = Trigger['kind']

const PRESETS: Preset[] = ['daily', 'weekdays', 'weekly', 'hourly', 'every', 'once']

function buildTrigger(preset: Preset, hour: number, minute: number, day: number, every: number): Trigger {
  switch (preset) {
    case 'once': {
      const at = new Date()
      at.setHours(hour, minute, 0, 0)
      // A time already past today means tomorrow — nobody schedules the past.
      if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
      return { kind: 'once', at: at.getTime() }
    }
    case 'every':
      return { kind: 'every', minutes: every }
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

function RunDot({ status }: { status: RunStatus }): JSX.Element {
  const t = useT()
  const label =
    status === 'ok' ? t('sched.ranOk') : status === 'failed' ? t('sched.ranFailed') : t('sched.ranMissed')
  return <span className={`sched-run ${status}`} title={label} />
}

function JobRow({ job, ws, now }: { job: Job; ws: string; now: number }): JSX.Element {
  const t = useT()
  const { update, remove, recordRun } = useJobs()
  const next = nextRunOf(job, now)
  const last = job.runs[job.runs.length - 1]
  return (
    <div className={`sched-item${job.enabled ? '' : ' off'}`}>
      <button
        className="sched-toggle"
        title={job.enabled ? t('sched.pause') : t('sched.resume')}
        onClick={() => update(ws, job.id, { enabled: !job.enabled })}
      >
        <span className={`sched-dot${job.enabled ? ' on' : ''}`} />
      </button>
      <div className="sched-main">
        <div className="sched-line">
          <span className="sched-name">{job.name}</span>
          <span className="sched-when">{triggerLabel(job.trigger)}</span>
        </div>
        <div className="sched-sub">
          <span className="sched-prompt">{job.prompt}</span>
        </div>
        <div className="sched-meta">
          <span>
            {job.enabled ? t('sched.next', { when: untilLabel(next, now) }) : t('sched.paused')}
          </span>
          {job.target.kind === 'pane' ? (
            <span className="sched-target">→ {job.target.title}</span>
          ) : (
            <span className="sched-target">→ {t('sched.newPane')}</span>
          )}
          {job.runs.length > 0 && (
            <span className="sched-runs">
              {job.runs.slice(-8).map((r, i) => (
                <RunDot key={i} status={r.status} />
              ))}
            </span>
          )}
          {last?.status === 'failed' && (
            <span className="sched-warn">
              <AlertTriangle size={11} /> {last.note}
            </span>
          )}
          {last?.status === 'missed' && <span className="sched-warn">{t('sched.wasMissed')}</span>}
        </div>
      </div>
      <button
        className="sched-act"
        title={t('sched.runNow')}
        onClick={() => {
          const result = runJob(job)
          recordRun(ws, job.id, { at: Date.now(), ...result })
        }}
      >
        <Play size={12} />
      </button>
      <button className="sched-act danger" title={t('sched.delete')} onClick={() => remove(ws, job.id)}>
        <Trash2 size={12} />
      </button>
    </div>
  )
}

export default function SchedulerPanel({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  const jobs = useJobs((s) => s.byWorkspace[workspace]) ?? EMPTY
  const add = useJobs((s) => s.add)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preset, setPreset] = useState<Preset>('daily')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [day, setDay] = useState(1)
  const [every, setEvery] = useState(30)
  const [cli, setCli] = useState<'claude' | 'codex'>('claude')
  const [model, setModel] = useState('default')
  const [targetPane, setTargetPane] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [hint, setHint] = useState<string | null>(null)

  // The countdown is the point of the list, so it has to move.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const panes = useMemo(() => listAgents(workspace), [workspace, open])
  const trigger = buildTrigger(preset, hour, minute, day, every)

  const create = (): void => {
    const text = prompt.trim()
    if (!text) {
      setHint(t('sched.needPrompt'))
      return
    }
    setHint(null)
    const target: JobTarget = targetPane
      ? { kind: 'pane', chatKey: targetPane, title: panes.find((p) => p.id === targetPane)?.title ?? targetPane }
      : { kind: 'new', cli, model }
    add(workspace, {
      name: name.trim() || text.split('\n')[0].slice(0, 30),
      prompt: text,
      trigger,
      target,
      enabled: true,
      graceMinutes: 60
    })
    setName('')
    setPrompt('')
    setOpen(false)
  }

  return (
    <div className="sched-panel">
      <div className="sched-head">
        <Clock size={14} />
        <span className="sched-title">{t('sched.title')}</span>
        <button className="sched-new" onClick={() => setOpen((v) => !v)}>
          {open ? <XIcon size={13} /> : <Plus size={13} />}
        </button>
      </div>

      {open && (
        <div className="sched-form">
          {/* The instruction first: it is the only thing a schedule cannot do
              without, and burying it under an optional name is how you end up
              filling in the name, pressing 저장, and getting nothing back from
              a disabled button that never said why. */}
          <textarea
            className="sched-input sched-prompt-input"
            placeholder={t('sched.promptPlaceholder')}
            value={prompt}
            rows={3}
            autoFocus
            onChange={(e) => setPrompt(e.target.value)}
          />
          <input
            className="sched-input"
            placeholder={t('sched.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="sched-row">
            <select className="sched-sel" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {t(`sched.preset.${p}`)}
                </option>
              ))}
            </select>
            {preset === 'weekly' && (
              <select className="sched-sel" value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {['일', '월', '화', '수', '목', '금', '토'].map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            )}
            {preset === 'every' ? (
              <input
                className="sched-num"
                type="number"
                min={1}
                value={every}
                onChange={(e) => setEvery(Number(e.target.value))}
              />
            ) : (
              <>
                {preset !== 'hourly' && (
                  <input
                    className="sched-num"
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                  />
                )}
                <input
                  className="sched-num"
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))}
                />
              </>
            )}
            <span className="sched-preview">{triggerLabel(trigger)}</span>
          </div>
          <div className="sched-row">
            <select className="sched-sel" value={targetPane} onChange={(e) => setTargetPane(e.target.value)}>
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
                  className="sched-sel"
                  value={cli}
                  onChange={(e) => {
                    setCli(e.target.value as 'claude' | 'codex')
                    setModel('default')
                  }}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
                <select className="sched-sel" value={model} onChange={(e) => setModel(e.target.value)}>
                  {(cli === 'codex' ? CODEX_MODELS : CLAUDE_MODELS).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button className="sched-save" onClick={create}>
              <Check size={12} /> {t('sched.save')}
            </button>
          </div>
          {hint && <div className="sched-hint">{hint}</div>}
        </div>
      )}

      <div className="sched-list">
        {jobs.length === 0 && !open && <div className="sched-empty">{t('sched.empty')}</div>}
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} ws={workspace} now={now} />
        ))}
      </div>
    </div>
  )
}

// Outside the selector: a fresh [] per render makes zustand re-render for ever.
const EMPTY: Job[] = []
