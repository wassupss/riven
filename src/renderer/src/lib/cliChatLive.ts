// What the rest of riven sees of a CLI chat pane (the roster, notifications,
// the pet, delegation, a paired phone), folded from the same 'clichat:event'
// stream the pane draws from. Pure, so it is tested without a window; the
// side effects live in state/cliChats.ts.
//
// It runs for every CLI chat of the window, mounted or not: the Rust session
// keeps working while its workspace is unmounted, and that is exactly when
// the roster and the notification have to come from somewhere else.

import { questionsOf, toolSummary, type AgentProgress, type CliEvent, type CliMenu } from './cliChat'

export interface CliLive {
  busy: boolean
  waiting: boolean
  dead: boolean
  parked: boolean
  sessionId: string | null
  title: string | null
  model: string | null
  mode: string | null
  /** Last time the session said anything (delegation waits on silence). */
  lastActivityAt: number
  background: { id: string; type?: string; status?: string; description?: string }[]
  agents: AgentProgress[]
  /** The menu on screen, if any (plan approval, a dialog). */
  menu: CliMenu | null
}

export const emptyLive = (now = 0): CliLive => ({
  busy: false,
  waiting: false,
  dead: false,
  parked: false,
  sessionId: null,
  title: null,
  model: null,
  mode: null,
  lastActivityAt: now,
  background: [],
  agents: [],
  menu: null
})

export interface TurnDone {
  reply: string
  error: string | null
  interrupted: boolean
}

/** One event into a pane's live record; `done` when it ended a turn. */
export function foldLive(prev: CliLive | undefined, e: CliEvent, now: number): { live: CliLive; done: TurnDone | null } {
  const l: CliLive = { ...(prev ?? emptyLive(now)), lastActivityAt: now }
  switch (e.kind) {
    case 'state':
      l.busy = e.busy
      l.waiting = e.waiting
      l.dead = e.dead
      l.parked = !!e.parked
      l.sessionId = e.sessionId ?? l.sessionId
      l.model = e.model ?? null
      l.mode = e.mode ?? null
      l.background = e.background ?? []
      l.menu = e.menu ?? null
      break
    case 'meta':
      l.title = e.title
      break
    case 'agents':
      l.agents = e.agents
      break
    case 'exit':
      l.busy = false
      l.dead = true
      l.menu = null
      break
    case 'turnDone':
      l.busy = false
      return { live: l, done: { reply: e.reply ?? '', error: e.error ?? null, interrupted: !!e.interrupted } }
    case 'question':
    case 'permission':
      l.waiting = true
      break
  }
  return { live: l, done: null }
}

/** The roster's view: busy, waiting on the person, a completion. */
export function rosterPatch(l: CliLive): { busy: boolean; attention: 'needs_input' | null } {
  const waiting = l.waiting || !!l.menu
  return { busy: l.busy && !waiting, attention: waiting ? 'needs_input' : null }
}

/** The pane's work besides its conversation, for chatWork (the phone's strip). */
export function liveWork(
  l: CliLive,
  now: number
): {
  bg: { id: string; label: string }[]
  agents: { id: string; label: string; since: number; steps: number; lastActivityAt: number }[]
  delegations: never[]
} {
  return {
    bg: l.background.map((b) => ({ id: b.id, label: b.description || b.type || b.id })),
    agents: l.agents
      .filter((a) => !a.done)
      .map((a) => ({ id: a.agentId, label: a.description || a.agentType, since: now, steps: a.tools, lastActivityAt: now })),
    delegations: []
  }
}

// ---- the question queue ------------------------------------------------------------
//
// A card the CLI chat draws (a permission, an AskUserQuestion, a menu on the
// screen) is also put in riven's ask queue (state/askUser), which is what a
// paired phone answers through ('answer'). One ask per question; the card's
// own answer goes back once each of its questions has one.

export interface MirrorAsk {
  question: string
  options: string[]
}

export interface Labels {
  allow: string
  deny: string
  permTitle: (tool: string) => string
}

/** The asks for a permission card: one yes/no question. */
export function permissionAsks(tool: string, input: unknown, labels: Labels): MirrorAsk[] {
  const what = toolSummary(tool, input)
  return [{ question: what ? `${labels.permTitle(tool)}\n${what}` : labels.permTitle(tool), options: [labels.allow, labels.deny] }]
}

/** The asks for an AskUserQuestion: one per question, its option labels. */
export function questionAsks(input: unknown): MirrorAsk[] {
  return questionsOf(input).map((q) => ({
    question: q.header ? `${q.header}: ${q.question}` : q.question,
    options: q.options.map((o) => o.label)
  }))
}

/** The asks for a menu on screen: its title, its rows. */
export function menuAsks(menu: CliMenu): MirrorAsk[] {
  return [{ question: menu.title, options: menu.options.map((o) => o.label) }]
}

/** A menu's identity: the same menu redrawn is not a new question. */
export function menuId(menu: CliMenu): string {
  return `${menu.title}\u0000${menu.options.map((o) => o.label).join('\u0000')}`
}

/** A permission answer from the chosen text: allow only for the allow label. */
export function permissionDecision(choice: string, labels: Labels): 'allow' | 'deny' {
  return choice.trim() === labels.allow ? 'allow' : 'deny'
}

/**
 * AskUserQuestion's answers from one choice per question (a label, or text
 * typed on the phone, which the CLI takes as the "other" answer). Null until
 * every question has one.
 */
export function questionAnswersFrom(input: unknown, choices: (string | undefined)[]): Record<string, string> | null {
  const qs = questionsOf(input)
  const out: Record<string, string> = {}
  for (let i = 0; i < qs.length; i++) {
    const c = choices[i]?.trim()
    if (!c) return null
    out[qs[i].question] = c
  }
  return qs.length ? out : null
}

/**
 * A menu row from the chosen text: the row with that label, else typed text
 * for the menu's text row (plan feedback), else nothing.
 */
export function menuPick(menu: CliMenu, choice: string): { index: number; text?: string } | null {
  const c = choice.trim()
  const exact = menu.options.findIndex((o) => o.label === c)
  if (exact >= 0 && !menu.options[exact].input) return { index: exact }
  const input = menu.options.findIndex((o) => o.input)
  if (input >= 0 && c && exact < 0) return { index: input, text: c }
  return exact >= 0 ? { index: exact } : null
}

/** A notification body from a reply: prose only, one line, clipped. */
export function notifyBody(reply: string, fallback: string): string {
  const s = reply
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return fallback
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}
