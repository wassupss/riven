import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock, Plus, ListChecks } from 'lucide-react'
import { useT } from '../i18n'
import { togglePanel } from '../dock/registry'
import { useSession } from '../state/session'
import { useJobs, nextRunOf, type Job } from '../state/jobs'
import { triggerLabel, untilLabel } from '../lib/schedule'
import ScheduleForm from './ScheduleForm'

// Scheduled work, from the rail.
//
// The row answers "is anything pending, and when" without being clicked. The
// menu ADDS one without going anywhere: registering used to mean opening a dock
// panel and filling a form in there — three steps and a change of context for
// something that is two sentences long. The panel is where you manage what
// exists, not where you create it.

function nextUp(jobs: Job[], now: number): Array<{ job: Job; at: number | null }> {
  return jobs
    .map((job) => ({ job, at: nextRunOf(job, now) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
}

export default function ScheduleMenu(): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState<{ x: number; y: number; w: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const byWorkspace = useJobs((s) => s.byWorkspace)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const all = Object.values(byWorkspace).flat()
  const armed = all.filter((j) => j.enabled)
  const now = Date.now()
  const next = nextUp(armed, now)[0] ?? null
  const close = (): void => {
    setOpen(null)
    setAdding(false)
  }

  return (
    <>
      <button
        className={`ws-sched-row${armed.length ? ' armed' : ''}`}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          // Hung under the row and as wide as it: the rail is at the window's
          // left edge, so a menu measured from anywhere else grows off screen.
          if (open) close()
          else setOpen({ x: r.left, y: r.bottom + 2, w: r.width })
        }}
      >
        <Clock size={13} />
        {/* Empty, it asks for the thing it does. Armed, it says the next one —
            a line that only ever reads "스케줄러 등록" is a line spent on a
            label, and the rail has few to spare. */}
        <span className="ws-sched-label">
          {next ? `${next.job.name} · ${untilLabel(next.at, now)}` : t('ws.schedulerAdd')}
        </span>
        {/* Only once there is more than one: with a single job the row already
            names it, and "1" beside it says nothing. */}
        {armed.length > 1 && <span className="ws-sched-count">{armed.length}</span>}
      </button>
      {open &&
        createPortal(
          <>
            <div className="sched-menu-scrim" onClick={close} />
            <div
              className={`sched-menu${adding ? ' wide' : ''}`}
              style={{ left: open.x, top: open.y, minWidth: Math.max(open.w, adding ? 300 : 240) }}
            >
              {adding && activeWorkspace ? (
                <>
                  <div className="sched-menu-head">
                    {t('sched.newIn', { ws: activeWorkspace.split('/').pop() ?? '' })}
                  </div>
                  <ScheduleForm workspace={activeWorkspace} onDone={close} onCancel={() => setAdding(false)} />
                </>
              ) : (
                <>
                  <div className="sched-menu-head">{t('ws.scheduler')}</div>
                  {armed.length === 0 && <div className="sched-menu-empty">{t('sched.menuEmpty')}</div>}
                  {nextUp(armed, now)
                    .slice(0, 6)
                    .map(({ job, at }) => (
                      <button
                        key={job.id}
                        className="sched-menu-item"
                        onClick={() => {
                          close()
                          togglePanel('scheduler', job.workspace)
                        }}
                      >
                        <span className="sched-menu-name">{job.name}</span>
                        <span className="sched-menu-when">{triggerLabel(job.trigger)}</span>
                        <span className="sched-menu-next">{untilLabel(at, now)}</span>
                      </button>
                    ))}
                  <div className="sched-menu-foot">
                    <button
                      className="sched-menu-item action"
                      disabled={!activeWorkspace}
                      onClick={() => setAdding(true)}
                    >
                      <Plus size={12} />
                      {t('sched.createHere')}
                    </button>
                    {all.length > 0 && (
                      <button
                        className="sched-menu-item action"
                        onClick={() => {
                          close()
                          togglePanel('scheduler')
                        }}
                      >
                        <ListChecks size={12} />
                        {t('sched.manage')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
