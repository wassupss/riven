import { useEffect, useState } from 'react'
import { Bot, Forward, Pencil, TerminalSquare, X as XIcon } from 'lucide-react'
import { useT } from '../../../i18n'
import type { Delegation } from '../../../state/delegations'
import { scrollWithin } from '../../../lib/scrollWithin'
import { fmtDur } from './format'

// The strips above a chat composer: work going on elsewhere (background
// commands, delegated agents, running subagents) and what is typed but not
// sent yet. Shared by the chat panes.

/** A second-resolution clock, running only while something needs it. */
export function useTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [on])
  return now
}

// Work this pane handed to another agent without waiting (riven_ask_agent
// wait=false). Same row as a background command: something is still going on
// that this conversation will hear back from.
export function DelegationChip({ d }: { d: Delegation }): JSX.Element {
  const t = useT()
  const now = useTicker(true)
  return (
    <div className="chat-bgtask chat-delegation" title={t('chat.delegationHint', { what: d.toTitle })}>
      <span className="chat-bgtask-dot" />
      <Forward size={11} />
      <span className="chat-bgtask-state">{t('chat.bgTaskRunning')}</span>
      <span className="chat-bgtask-label">
        {t('chat.delegating')} · {d.toTitle}
      </span>
      <span className="chat-bgtask-time">{fmtDur(now - d.startedAt)}</span>
    </div>
  )
}

// A command the agent left running in the background. It outlives the turn
// that started it, so it gets its own row with its own clock. The state is
// said in words, not implied by a dot.
export function BgTaskChip({ task, since }: { task: { id: string; label: string }; since?: number }): JSX.Element {
  const t = useT()
  const now = useTicker(true)
  return (
    <div className="chat-bgtask" title={t('chat.bgTaskHint', { what: task.label })}>
      <span className="chat-bgtask-dot" />
      <TerminalSquare size={11} />
      <span className="chat-bgtask-state">{t('chat.bgTaskRunning')}</span>
      <span className="chat-bgtask-label">{task.label || t('chat.bgTaskPlain')}</span>
      {since && <span className="chat-bgtask-time">{fmtDur(now - since)}</span>}
    </div>
  )
}

/** Background commands and delegations, in one row (nothing when empty). */
export function WorkStrip({
  tasks,
  since,
  delegations
}: {
  tasks: { id: string; label: string }[]
  since?: (id: string) => number | undefined
  delegations: Delegation[]
}): JSX.Element | null {
  if (tasks.length === 0 && delegations.length === 0) return null
  return (
    <div className="chat-bgtasks">
      {tasks.map((task) => (
        <BgTaskChip key={task.id} task={task} since={since?.(task.id)} />
      ))}
      {delegations.map((d) => (
        <DelegationChip key={d.id} d={d} />
      ))}
    </div>
  )
}

/** A subagent running right now, for the strip above the composer. */
export interface LiveAgent {
  id: string
  label: string
  steps: number
  /** When it started, if known: the strip shows how long it has run. */
  since?: number
  quiet?: boolean
  quietFor?: number
}

// A delegated agent's card sits where it appeared in the transcript, which
// stops being visible once the conversation scrolls on; the strip keeps it in
// view, says how long it has run and when it went quiet. A click scrolls to
// its card ([data-agent-id]).
export function AgentsStrip({ agents }: { agents: LiveAgent[] }): JSX.Element | null {
  const t = useT()
  const now = useTicker(agents.some((a) => a.since))
  if (agents.length === 0) return null
  return (
    <div className="chat-agents-live">
      {agents.map((a) => (
        <button
          key={a.id}
          className={`cal-item${a.quiet ? ' quiet' : ''}`}
          title={`${a.label}${a.since ? ` · ${fmtDur(now - a.since)}` : ''}${
            a.quiet && a.quietFor ? ` · ${t('chat.subagent.quiet', { t: fmtDur(a.quietFor) })}` : ''
          }`}
          onClick={() => {
            scrollWithin(document.querySelector(`[data-agent-id="${a.id}"]`), 'center', 'smooth')
          }}
        >
          <Bot size={11} className={a.quiet ? undefined : 'spin-slow'} />
          <span className="cal-label">{a.label}</span>
          {a.steps > 0 && <span className="cal-steps">{a.steps}</span>}
          {a.since && <span className="cal-time">{fmtDur(now - a.since)}</span>}
        </button>
      ))}
    </div>
  )
}

/** Something typed while a turn was running: sent when its turn comes. */
export interface QueuedItem {
  id: string
  text: string
  /** Images going with it (count), for a message that is only images. */
  images: number
}

// What is typed but not sent yet, in the order it will go out. Above the
// composer with the other "about to happen" strips, not as bubbles in the
// transcript (the transcript is what happened).
export function QueueStrip({
  items,
  sendNowHint,
  onSendNow,
  onEdit,
  onDrop
}: {
  items: QueuedItem[]
  /** What "send now" does in this pane (the chat's own words otherwise). */
  sendNowHint?: string
  onSendNow: (id: string) => void
  /** Back into the composer to change it (taken off the queue). */
  onEdit?: (id: string) => void
  onDrop: (id: string) => void
}): JSX.Element | null {
  const t = useT()
  if (items.length === 0) return null
  return (
    <div className="chat-queue">
      <div className="chat-queue-head">{t('chat.queueHead', { n: items.length })}</div>
      {items.map((q, i) => (
        <div className="chat-queue-row" key={q.id}>
          <span className="chat-queue-no">{i + 1}</span>
          <span className="chat-queue-text" title={q.text}>
            {q.text || t('chat.queueImageOnly', { n: q.images })}
          </span>
          <button className="chat-queue-act" title={sendNowHint ?? t('chat.sendNowHint')} onClick={() => onSendNow(q.id)}>
            {t('chat.sendNow')}
          </button>
          {onEdit && (
            <button className="chat-queue-act icon" title={t('chat.editQueued')} onClick={() => onEdit(q.id)}>
              <Pencil size={11} />
            </button>
          )}
          <button className="chat-queue-act icon" title={t('chat.dropQueued')} onClick={() => onDrop(q.id)}>
            <XIcon size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
