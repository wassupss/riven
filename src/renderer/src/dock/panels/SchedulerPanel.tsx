import { useEffect, useState } from 'react'
import { Clock, Play, Plus, Pencil, Trash2, X as XIcon, AlertTriangle } from 'lucide-react'
import { useT } from '../../i18n'
import { useJobs, nextRunOf, type Job, type RunStatus } from '../../state/jobs'
import { runJob } from '../../state/jobRunner'
import { triggerLabel, untilLabel } from '../../lib/schedule'
import ScheduleForm from '../../components/ScheduleForm'

// Scheduled work for this workspace.
//
// The list answers the three questions a schedule raises — what runs, when it
// runs next, and what happened last time — before any of them have to be asked.
// A run's outcome is the part riven used to drop entirely: the old scheduler
// sent its message and remembered nothing, so "did the 9am one go out?" had no
// answer anywhere in the app.

function RunDot({ status }: { status: RunStatus }): JSX.Element {
  const t = useT()
  const label =
    status === 'ok' ? t('sched.ranOk') : status === 'failed' ? t('sched.ranFailed') : t('sched.ranMissed')
  return <span className={`sched-run ${status}`} title={label} />
}

function JobRow({
  job,
  ws,
  now,
  onEdit
}: {
  job: Job
  ws: string
  now: number
  onEdit: (job: Job) => void
}): JSX.Element {
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
      <button className="sched-act" title={t('sched.edit')} onClick={() => onEdit(job)}>
        <Pencil size={12} />
      </button>
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
  // null = not editing; a Job = editing that one; 'new' = creating.
  const [editing, setEditing] = useState<Job | 'new' | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // The countdown is the point of the list, so it has to move.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="sched-panel">
      <div className="sched-head">
        <Clock size={14} />
        <span className="sched-title">{t('sched.title')}</span>
        <button
          className="sched-new"
          title={editing ? t('sched.cancel') : t('sched.createHere')}
          onClick={() => setEditing(editing ? null : 'new')}
        >
          {editing ? <XIcon size={13} /> : <Plus size={13} />}
        </button>
      </div>

      {editing && (
        <div className="sched-formwrap">
          <ScheduleForm
            workspace={workspace}
            job={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      <div className="sched-list">
        {jobs.length === 0 && !editing && <div className="sched-empty">{t('sched.empty')}</div>}
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} ws={workspace} now={now} onEdit={setEditing} />
        ))}
      </div>
    </div>
  )
}

// Outside the selector: a fresh [] per render makes zustand re-render for ever.
const EMPTY: Job[] = []
