import { create } from 'zustand'

// A registry of the open chat panes so they can act as delegatable "agents"
// (riven_agents / riven_ask_agent(s) / group_* / start_pipeline). Each ChatPanel
// registers a controller on mount; the agent MCP tools resolve a target by id,
// title or role, send it a message, and await its next completed reply.

export interface AgentController {
  chatKey: string
  workspace: string
  getTitle: () => string
  isBusy: () => boolean
  send: (text: string) => void
  // Append context into the composer without sending (browser "send to chat").
  attach?: (text: string) => void
  // Resolves with the assistant reply text of the next turn that completes.
  waitNext: () => Promise<string>
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

export function listAgents(): AgentInfo[] {
  return [...controllers.values()].map(infoOf)
}

// Agents belonging to a workspace, for the workspace-card roster.
export function agentsForWorkspace(ws: string): AgentInfo[] {
  return [...controllers.values()].filter((c) => c.workspace === ws).map(infoOf)
}

// Resolve an agent reference (chatKey, exact title, or case-insensitive title
// contains) to a controller, excluding the caller if given.
export function resolveAgent(ref: string, exclude?: string): AgentController | null {
  const list = [...controllers.values()].filter((c) => c.chatKey !== exclude)
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
