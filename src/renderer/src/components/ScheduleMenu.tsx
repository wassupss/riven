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
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const byWorkspace = useJobs((s) => s.byWorkspace)
  const all = Object.values(byWorkspace).flat()
  const armed = all.filter((j) => j.enabled)
  const now = Date.now()

  return (
    <>
      <button
        className={`ws-rail-add sched-btn${armed.length ? ' armed' : ''}`}
        title={t('ws.scheduler')}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          // Anchored to the button's RIGHT edge: the rail sits at the window's
          // left, so a menu hung from the left edge of a 22px button had
          // nowhere to grow.
          setOpen(open ? null : { x: Math.max(8, r.right - 240), y: r.bottom + 4 })
        }}
      >
        <Clock size={14} />
        {armed.length > 0 && <span className="ws-rail-badge">{armed.length}</span>}
      </button>
      {open &&
        createPortal(
          <>
            <div className="sched-menu-scrim" onClick={() => setOpen(null)} />
            <div className="sched-menu" style={{ left: open.x, top: open.y }}>
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
