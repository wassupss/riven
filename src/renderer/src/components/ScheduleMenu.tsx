import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock, Plus } from 'lucide-react'
import { useT } from '../i18n'
import { togglePanel } from '../dock/registry'
import { useJobs, nextRunOf, type Job } from '../state/jobs'
import { triggerLabel, untilLabel } from '../lib/schedule'

// Scheduled work, from the top bar.
//
// It sat in the workspace rail's header first, which was wrong on two counts: a
// schedule is not a property of the workspace list (it spans all of them), and a
// bare icon next to "워크스페이스" read as another way to add one. Up here it is
// beside the other app-level action, and it opens a MENU — because the question
// it answers ("what is armed, and when does the next one go?") is worth an
// answer in place, without opening a panel to find out.

function nextUp(jobs: Job[], now: number): Array<{ job: Job; at: number | null }> {
  return jobs
    .map((job) => ({ job, at: nextRunOf(job, now) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
}

export default function ScheduleMenu(): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState<{ x: number; y: number; w: number } | null>(null)
  const byWorkspace = useJobs((s) => s.byWorkspace)
  const all = Object.values(byWorkspace).flat()
  const armed = all.filter((j) => j.enabled)
  const now = Date.now()
  const next = nextUp(armed, now)[0] ?? null

  return (
    <>
      <button
        className={`ws-sched-row${armed.length ? ' armed' : ''}`}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          // Hung under the row and as wide as it: the rail is at the window's
          // left edge, so a menu measured from anywhere else grows off screen.
          setOpen(open ? null : { x: r.left, y: r.bottom + 2, w: r.width })
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
            <div className="sched-menu-scrim" onClick={() => setOpen(null)} />
            <div className="sched-menu" style={{ left: open.x, top: open.y, minWidth: open.w }}>
              <div className="sched-menu-head">{t('ws.scheduler')}</div>
              {armed.length === 0 && <div className="sched-menu-empty">{t('sched.menuEmpty')}</div>}
              {nextUp(armed, now)
                .slice(0, 6)
                .map(({ job, at }) => (
                  <button
                    key={job.id}
                    className="sched-menu-item"
                    onClick={() => {
                      setOpen(null)
                      togglePanel('scheduler', job.workspace)
                    }}
                  >
                    <span className="sched-menu-name">{job.name}</span>
                    <span className="sched-menu-when">{triggerLabel(job.trigger)}</span>
                    <span className="sched-menu-next">{untilLabel(at, now)}</span>
                  </button>
                ))}
              <button
                className="sched-menu-item action"
                onClick={() => {
                  setOpen(null)
                  togglePanel('scheduler')
                }}
              >
                <Plus size={12} />
                {all.length ? t('sched.manage') : t('sched.createFirst')}
              </button>
            </div>
          </>,
          document.body
        )}
    </>
  )
}
