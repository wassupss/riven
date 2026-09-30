import { create } from 'zustand'

// A registry of the open chat panes so they can act as delegatable "agents"
// (riven_agents / riven_ask_agent(s) / group_* / start_pipeline). Each ChatPanel
// registers a controller on mount; the agent MCP tools resolve a target by id,
// title or role, send it a message, and await its next completed reply.

export interface AgentController {
  chatKey: string
  workspace: string
  getTitle: () => string
  // Adopt a title chosen OUTSIDE the panel (a tab rename). Without this the
  // pane's own titleRef keeps the auto-generated name, so the rail roster, the
  // notification title and `riven_ask_agent`'s name lookup all stay stale while
  // the tab shows something else.
  setTitle?: (title: string) => void
  isBusy: () => boolean
  send: (text: string) => void
  // Append context into the composer without sending (browser "send to chat").
  attach?: (text: string) => void
  // Resolves with the assistant reply text of the next turn that completes.
  waitNext: () => Promise<string>
  // Send THIS message and resolve with the answer to it specifically (the pane
  // ties the promise to the turn the message starts). Preferred over
  // send + waitNext, which cannot tell one turn's answer from another's.
  ask?: (message: string) => Promise<string>
  // The pane was opened with a first message it hasn't sent yet.
  hasPendingOpening?: () => boolean
  // When this pane last showed a sign of life (text, a tool call, a tool's
  // heartbeat, thinking). Delegation waits on silence, not on elapsed time —
  // see askChatTurnNow. A pane that does not report it falls back to a plain
  // wall-clock deadline.
  lastActivityAt?: () => number
  // Start a turn with `text` that the transcript shows as the `notices` lines
  // rather than as something the user typed — how an answer to work this pane
  // handed off in the background is brought back to it (see returnToCaller).
  wake?: (text: string, notices: string[]) => void
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// One question at a time per pane.
//
// askChatTurn waits for the pane to be idle and then sends — and two callers
// could pass that check in the same breath (riven_ask_agents with the same
// target twice, or a lead and a member both asking the same agent). The second
// send then landed mid-turn, which INTERRUPTS it, and both callers were handed
// the same text. Asks are queued per pane instead, so each one gets the pane to
// itself and its own answer.
const paneQueue = new Map<string, Promise<unknown>>()
function queued<T>(chatKey: string, run: () => Promise<T>): Promise<T> {
  const prev = paneQueue.get(chatKey) ?? Promise.resolve()
  const next = prev.then(run, run)
  // Keep the chain going but never let a rejection poison the queue, and drop
  // the entry once it is the last one (a pane that is never asked again must
  // not hold its result forever).
  paneQueue.set(
    chatKey,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  void next.finally(() => {
    if (paneQueue.get(chatKey) === undefined) paneQueue.delete(chatKey)
  })
  return next
}

// Put a message to a chat pane and return the answer to THAT message.
//
// Sending while the pane was mid-turn (or before it had sent the message it was
// opened with) queued the message behind that turn, and waitNext resolved with
// whatever turn finished first — the caller got the answer to the earlier
// message, and the pane then answered the real question again. Across two
// agents that looked like the same exchange repeating. So: let the running turn
// and the opening message finish first, then send and wait for the next reply.
export function askChatTurn(
  target: AgentController,
  message: string,
  timeoutMs: number,
  timeoutText: string
): Promise<string> {
  return queued(target.chatKey, () => askChatTurnNow(target, message, timeoutMs, timeoutText))
}

/**
 * Gives up only after the target has been SILENT for `quietMs`.
 *
 * It used to be a flat deadline: five minutes after asking, the caller was told
 * there was no reply. Real delegated work runs longer than that, so a lead was
 * routinely told its member had gone quiet while the member was mid-build — and
 * the answer, when it finally came, had nobody holding it and was dropped. The
 * member then sat there finished, with its report undelivered.
 *
 * The CLI now reports activity continuously (text, tool calls, a long tool's
 * heartbeat, thinking), so silence is a real signal and elapsed time is not.
 * Waiting costs nothing: the lead is parked inside a tool call, generating
 * nothing.
 */
function quietGuard(
  target: AgentController,
  quietMs: number,
  text: string,
  since: number
): { promise: Promise<string>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<string>((resolve) => {
    const tick = (): void => {
      const last = Math.max(since, target.lastActivityAt?.() ?? 0)
      const left = quietMs - (Date.now() - last)
      if (left <= 0) return resolve(text)
      // Re-check at most every 5s: the pane may have spoken since this timer
      // was set, which pushes the deadline out.
      timer = setTimeout(tick, Math.min(left, 5_000))
    }
    timer = setTimeout(tick, Math.min(quietMs, 5_000))
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

async function askChatTurnNow(
  target: AgentController,
  message: string,
  timeoutMs: number,
  timeoutText: string
): Promise<string> {
  const guard = quietGuard(target, timeoutMs, timeoutText, Date.now())
  try {
    let gaveUp = false
    for (;;) {
      if (target.hasPendingOpening?.()) {
        const raced = await Promise.race([pause(150).then(() => null), guard.promise])
        if (raced !== null) return timeoutText
        continue
      }
      if (target.isBusy()) {
        const raced = await Promise.race([target.waitNext().then(() => null), guard.promise])
        if (raced !== null) {
          gaveUp = true
          break
        }
        continue
      }
      // Busy is published a render after a send, so an opening message sent a
      // moment ago can still read as idle. Look once more before going.
      await pause(120)
      if (!target.isBusy() && !target.hasPendingOpening?.()) break
    }
    if (gaveUp) return timeoutText
    // `ask` ties the answer to this message's own turn; waitNext is the fallback
    // for a pane that predates it (and for terminals, which have no turn ids).
    const reply = target.ask ? target.ask(message) : (() => {
      const p = target.waitNext()
      target.send(message)
      return p
    })()
    return Promise.race([reply, guard.promise])
  } finally {
    guard.cancel()
  }
}

// Answers to work a pane handed off without waiting, not yet given back to it.
const returning = new Map<string, Array<{ text: string; notice: string }>>()

/**
 * Give an answer back to the pane that handed the work off — once that pane is
 * free. A pane in the middle of a turn is not interrupted: the answer waits for
 * the turn to end, and answers that pile up meanwhile go back together, as ONE
 * turn, rather than one turn each.
 */
export function returnToCaller(chatKey: string, text: string, notice: string): void {
  returning.set(chatKey, [...(returning.get(chatKey) ?? []), { text, notice }])
  void queued(chatKey, async () => {
    for (;;) {
      const c = controllers.get(chatKey)
      // The pane closed while the work was out: nobody left to tell.
      if (!c?.wake) {
        returning.delete(chatKey)
        return
      }
      if (c.hasPendingOpening?.()) {
        await pause(150)
        continue
      }
      if (c.isBusy()) {
        await c.waitNext()
        continue
      }
      await pause(120)
      if (c.isBusy() || c.hasPendingOpening?.()) continue
      const batch = returning.get(chatKey) ?? []
      returning.delete(chatKey)
      // An earlier run already took this one along with its own.
      if (!batch.length) return
      c.wake(
        batch.map((b) => b.text).join('\n\n'),
        batch.map((b) => b.notice)
      )
      return
    }
  })
}

interface AgentsState {
  // Bumped whenever the roster changes, so UIs re-read the (non-reactive) map.
  version: number
  bump: () => void
}

export const useAgents = create<AgentsState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 }))
}))

const controllers = new Map<string, AgentController>()

// Rich per-agent activity for the rail's status indicator (native parity):
//   idle → static dot · busy → radar pulse · waiting → breathing (approval) ·
//   done → a checkmark that draws itself, then settles back to idle.
export type AgentActivity = 'idle' | 'busy' | 'waiting' | 'done'
const statuses = new Map<string, AgentActivity>()

export function setAgentStatus(chatKey: string, s: AgentActivity): void {
  if ((statuses.get(chatKey) ?? 'idle') === s) return
  if (s === 'idle') statuses.delete(chatKey)
  else statuses.set(chatKey, s)
  useAgents.getState().bump()
}
export function getAgentStatus(chatKey: string): AgentActivity {
  return statuses.get(chatKey) ?? 'idle'
}

export function registerAgent(c: AgentController): () => void {
  controllers.set(c.chatKey, c)
  useAgents.getState().bump()
  return () => {
    controllers.delete(c.chatKey)
    statuses.delete(c.chatKey)
    useAgents.getState().bump()
  }
}

interface AgentInfo {
  id: string
  title: string
  busy: boolean
  status: AgentActivity
}
const infoOf = (c: AgentController): AgentInfo => ({
  id: c.chatKey,
  title: c.getTitle(),
  busy: c.isBusy(),
  status: getAgentStatus(c.chatKey)
})

// Push a title chosen outside the panel into the controller, so every consumer
// of getTitle() (rail roster, delegation, notifications) matches the tab.
export function renameAgent(chatKey: string, title: string): void {
  const c = controllers.get(chatKey)
  if (!c) return
  c.setTitle?.(title)
  useAgents.getState().bump()
}

// `ws` scopes the roster to one workspace. Agent tools ALWAYS pass the caller's
// workspace: delegation across workspaces is the bug where "ask the agent in the
// next pane" reached a same-named pane in an unrelated workspace.
export function listAgents(ws?: string | null): AgentInfo[] {
  return [...controllers.values()].filter((c) => !ws || c.workspace === ws).map(infoOf)
}

// Agents belonging to a workspace, for the workspace-card roster.
export function agentsForWorkspace(ws: string): AgentInfo[] {
  return [...controllers.values()].filter((c) => c.workspace === ws).map(infoOf)
}

// Resolve an agent reference (chatKey, exact title, or case-insensitive title
// contains) to a controller, excluding the caller if given. `ws` restricts the
// search to one workspace — title matching is fuzzy, so without it "coder"
// happily resolves to a "coder" pane in a workspace the caller cannot see.
export function resolveAgent(
  ref: string,
  exclude?: string,
  ws?: string | null
): AgentController | null {
  const list = [...controllers.values()].filter(
    (c) => c.chatKey !== exclude && (!ws || c.workspace === ws)
  )
  const byKey = list.find((c) => c.chatKey === ref)
  if (byKey) return byKey
  const byTitle = list.find((c) => c.getTitle() === ref)
  if (byTitle) return byTitle
  const lc = ref.toLowerCase()
  return list.find((c) => c.getTitle().toLowerCase().includes(lc)) ?? null
}

export function agentCount(): number {
  return controllers.size
}

// Attach browser/editor context into a workspace's native chat composer (prefer a
// non-busy pane). Returns false when the workspace has no native chat open (the
// caller then falls back to the terminal contextBus).
export function attachToWorkspaceAgent(ws: string, text: string): boolean {
  const list = [...controllers.values()].filter((c) => c.workspace === ws && c.attach)
  const target = list.find((c) => !c.isBusy()) ?? list[0]
  if (!target?.attach) return false
  target.attach(text)
  return true
}
