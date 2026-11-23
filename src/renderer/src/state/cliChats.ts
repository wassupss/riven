import { foldLive, liveWork, menuAsks, menuId, menuPick, notifyBody, permissionAsks, permissionDecision, questionAnswersFrom, questionAsks, rosterPatch, type CliLive, type Labels, type MirrorAsk, type TurnDone } from '../lib/cliChatLive'
import type { CliEvent } from '../lib/cliChat'
import { getActiveApi, hasInitialText } from '../dock/registry'
import { t } from '../i18n'
import { getAgentStatus, registerAgent, setAgentStatus, type AgentController } from './agents'
import { useAskUser } from './askUser'
import { publishWork } from './chatWork'
import { forgetCliChat, markCliChat } from './cliChatKeys'
import { useRoster, workspaceOfPane } from './roster'
import { useSession } from './session'
import { getSettings } from './settings'

// The CLI chat as the rest of riven sees it: one app-level listener on
// 'clichat:event' for every CLI chat pane of this window (lib/cliChatLive has
// the pure half). It does what the headless ChatPanel does for itself from
// inside the panel:
//
// - the roster (rail, workspace cards, tray, the pet's busy count) and the
//   pane status: busy, waiting on the person, a completion until it is seen;
// - the desktop notification when a turn ends or the CLI asks something;
// - turn waiters, so riven_ask_agent(s), groups, pipelines, scheduled jobs and
//   a phone get the answer to what they sent;
// - the cards (permission, AskUserQuestion, a menu on screen) mirrored into
//   the ask queue, which is what a paired phone answers through;
// - the pane's background work for the phone's strip (chatWork).
//
// The panel registers the pane as an agent (registerCliChatAgent); the state
// behind it is here, so it stays right while the panel is not mounted.

const live = new Map<string, CliLive>()
const waiters = new Map<string, Array<(reply: string) => void>>()
const turnListeners = new Set<(key: string, done: TurnDone) => void>()

export function cliLive(key: string): CliLive | null {
  return live.get(key) ?? null
}

/** Resolves with the answer of the next turn of this pane that ends. */
export function waitTurn(key: string): Promise<string> {
  return new Promise((resolve) => {
    const list = waiters.get(key) ?? []
    list.push(resolve)
    waiters.set(key, list)
  })
}

/** Every finished CLI chat turn (the pet listens). */
export function onCliTurnDone(fn: (key: string, done: TurnDone) => void): () => void {
  turnListeners.add(fn)
  return () => turnListeners.delete(fn)
}

// ---- the ask queue mirror ------------------------------------------------------------

const labels = (): Labels => ({
  allow: t('clichat.perm.allow'),
  deny: t('clichat.perm.deny'),
  permTitle: (tool) => t('clichat.perm.title', { tool })
})

interface Mirror {
  key: string
  askIds: string[]
}
// Card id (or "menu:<pane>") -> the asks standing for it.
const mirrors = new Map<string, Mirror>()
const menuShown = new Map<string, string>()

function dropMirror(id: string): void {
  const m = mirrors.get(id)
  if (!m) return
  mirrors.delete(id)
  const q = useAskUser.getState()
  for (const a of m.askIds) if (q.pending.some((r) => r.id === a)) q.dismiss(a)
}

function enqueue(id: string, key: string, asks: MirrorAsk[], answered: (choices: string[]) => void): void {
  dropMirror(id)
  const choices: string[] = []
  const askIds = asks.map((a, i) => {
    const askId = `clichat-${crypto.randomUUID()}`
    useAskUser.getState().enqueue({
      id: askId,
      chatKey: key,
      question: a.question,
      options: a.options,
      mirror: true,
      resolve: (choice) => {
        choices[i] = choice
        // Every question of the card answered: the card's answer goes out.
        if (asks.every((_, j) => choices[j] !== undefined)) {
          mirrors.delete(id)
          answered(choices)
        }
      }
    })
    return askId
  })
  mirrors.set(id, { key, askIds })
}

function mirrorCard(e: Extract<CliEvent, { kind: 'question' | 'permission' }>): void {
  const key = e.key
  if (e.kind === 'permission') {
    const tool = e.tool ?? '?'
    enqueue(e.id, key, permissionAsks(tool, e.input, labels()), ([c]) =>
      window.api.cliChat.answer(key, e.id, permissionDecision(c, labels()))
    )
    return
  }
  const asks = questionAsks(e.input)
  if (!asks.length) return
  enqueue(e.id, key, asks, (choices) => {
    const answers = questionAnswersFrom(e.input, choices)
    if (answers) window.api.cliChat.question(key, e.id, answers)
  })
}

function mirrorMenu(key: string, l: CliLive): void {
  const id = `menu:${key}`
  const menu = l.menu
  if (!menu) {
    menuShown.delete(key)
    dropMirror(id)
    return
  }
  const sig = menuId(menu)
  if (menuShown.get(key) === sig) return
  menuShown.set(key, sig)
  enqueue(id, key, menuAsks(menu), ([c]) => {
    const pick = menuPick(menu, c)
    if (pick) window.api.cliChat.menu(key, pick.index, pick.text)
  })
}

function dropAllMirrors(key: string): void {
  for (const [id, m] of [...mirrors]) if (m.key === key) dropMirror(id)
  menuShown.delete(key)
}

// ---- notifications -------------------------------------------------------------------

function looking(key: string): boolean {
  return (
    document.hasFocus() &&
    useSession.getState().activeWorkspace === workspaceOfPane(key) &&
    getActiveApi()?.activePanel?.id === key
  )
}

const titleOf = (key: string): string =>
  useRoster.getState().live[key]?.tabTitle || live.get(key)?.title || t('clichat.title')

function notifyDone(key: string, done: TurnDone): void {
  try {
    const cfg = getSettings()
    const wanted = done.error ? cfg.notifyOnFailure : cfg.notifyOnDone
    if (!cfg.notifications || !wanted || looking(key)) return
    window.api.notify.show(titleOf(key), notifyBody(done.error ?? done.reply, t('chat.done')), { force: true, paneId: key })
  } catch {
    /* notifications unavailable */
  }
}

function notifyWaiting(key: string): void {
  try {
    const cfg = getSettings()
    if (!cfg.notifications || !cfg.notifyOnNeedsInput || looking(key)) return
    window.api.notify.show(titleOf(key), t('clichat.waiting'), { force: true, paneId: key })
  } catch {
    /* notifications unavailable */
  }
}

// ---- the listener --------------------------------------------------------------------

function onEvent(e: CliEvent): void {
  const key = e.key
  markCliChat(key)
  const prev = live.get(key)
  const { live: l, done } = foldLive(prev, e, Date.now())
  live.set(key, l)
  const roster = useRoster.getState()
  roster.patch(key, rosterPatch(l))

  if (e.kind === 'question' || e.kind === 'permission') {
    mirrorCard(e)
    setAgentStatus(key, 'waiting')
    notifyWaiting(key)
  } else if (e.kind === 'permissionDone') {
    dropMirror(e.id)
  } else if (e.kind === 'state') {
    mirrorMenu(key, l)
    if (l.menu && !prev?.menu) notifyWaiting(key)
    const status = getAgentStatus(key)
    if (l.busy && !l.waiting && !l.menu) {
      if (status !== 'busy') setAgentStatus(key, 'busy')
      // A new turn: the last completion is old news.
      if (!prev?.busy) roster.patch(key, { done: false })
    } else if (l.waiting || l.menu) setAgentStatus(key, 'waiting')
    else if (status === 'busy' || status === 'waiting') setAgentStatus(key, 'idle')
  } else if (e.kind === 'agents') {
    // Only the change is published: the phone's strip is debounced anyway.
  } else if (e.kind === 'exit') {
    dropAllMirrors(key)
    if (getAgentStatus(key) !== 'done') setAgentStatus(key, 'idle')
  }

  if (done) {
    // A completion stays until the person looks (markPaneSeen), as for a chat.
    const ok = !done.error && !done.interrupted
    roster.patch(key, { busy: false, done: ok })
    setAgentStatus(key, ok ? 'done' : 'idle')
    dropAllMirrors(key)
    const list = waiters.get(key)
    waiters.delete(key)
    for (const w of list ?? []) w(done.error && !done.reply ? `(the turn failed: ${done.error})` : done.reply)
    for (const fn of turnListeners) fn(key, done)
    if (!done.interrupted) notifyDone(key, done)
  }
  if (e.kind === 'state' || e.kind === 'agents' || e.kind === 'exit') publishWork(key, l.dead ? null : liveWork(l, Date.now()))
}

/** Call once at startup, next to startRoster. */
export function startCliChats(): () => void {
  return window.api.cliChat.onEvent((e) => onEvent(e as unknown as CliEvent))
}

/** A pane closed: forget what was known about it. */
export function dropCliChat(key: string): void {
  live.delete(key)
  waiters.delete(key)
  dropAllMirrors(key)
  forgetCliChat(key)
  publishWork(key, null)
}

// ---- the pane as an agent ---------------------------------------------------------------

export interface CliAgentHooks {
  chatKey: string
  workspace: string
  getTitle: () => string
  setTitle: (title: string) => void
  /** Send a message the way the composer does. */
  send: (text: string) => void
  attach: (text: string) => void
  remote?: AgentController['remote']
}

/**
 * Register a mounted CLI chat pane as a delegatable agent (riven_agents,
 * riven_ask_agent(s), groups, pipelines, scheduled jobs, the phone). Busy,
 * activity and answers come from the hub, so they are right for a turn that
 * started before the panel mounted.
 */
export function registerCliChatAgent(h: CliAgentHooks): () => void {
  const key = h.chatKey
  markCliChat(key)
  return registerAgent({
    chatKey: key,
    workspace: h.workspace,
    getTitle: h.getTitle,
    setTitle: h.setTitle,
    isBusy: () => {
      const l = live.get(key)
      return !!l && (l.busy || l.waiting || !!l.menu)
    },
    send: h.send,
    attach: h.attach,
    // The CLI has no "notice" turn: the answer comes back as a message.
    wake: (text) => h.send(text),
    waitNext: () => waitTurn(key),
    ask: (message) => {
      const answer = waitTurn(key)
      h.send(message)
      return answer
    },
    hasPendingOpening: () => hasInitialText(key),
    lastActivityAt: () => live.get(key)?.lastActivityAt ?? 0,
    remote: h.remote
  })
}
