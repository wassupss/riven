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

async function askChatTurnNow(
  target: AgentController,
  message: string,
  timeoutMs: number,
  timeoutText: string
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const left = (): number => Math.max(0, deadline - Date.now())
  for (;;) {
    if (Date.now() >= deadline) return timeoutText
    if (target.hasPendingOpening?.()) {
      await pause(150)
      continue
    }
    if (target.isBusy()) {
      await Promise.race([target.waitNext(), pause(left())])
      continue
    }
    // Busy is published a render after a send, so an opening message sent a
    // moment ago can still read as idle. Look once more before going.
    await pause(120)
    if (!target.isBusy() && !target.hasPendingOpening?.()) break
  }
  // `ask` ties the answer to this message's own turn; waitNext is the fallback
  // for a pane that predates it (and for terminals, which have no turn ids).
  const reply = target.ask ? target.ask(message) : (() => {
    const p = target.waitNext()
    target.send(message)
    return p
  })()
  return Promise.race([reply, pause(left()).then(() => timeoutText)])
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
