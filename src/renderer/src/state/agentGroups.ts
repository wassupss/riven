import { create } from 'zustand'

// Agent groups (riven's orchestration surface). A group is a named set of agent
// panes with a reporting hierarchy; the main agent is the first member and every
// other member reports to another member by index. This mirrors the native
// AgentGroupPanel's group concept: creating a group spawns one chat pane per
// member and records the roster here so the panel can draw the org chart and
// manage the members later. Persisted to localStorage per workspace so the tabs
// survive restarts (the panes themselves are restored by the dock layout).

export interface GroupMember {
  name: string
  persona: string | null
  // Model id ('default' | 'opus' | 'sonnet' | 'haiku'); 'default' = account default.
  model: string
  // Index of the member this one reports to, or null for the main agent.
  parent: number | null
  // Dock chat pane key (chat-<n>). A member is "open" while that pane exists.
  chatKey: string
  // User-picked avatar override "glyph.color" (see lib/avatar). null = auto by name.
  avatar?: string | null
  // Custom agent (.claude/agents/<name>.md) this member runs as. null = plain chat.
  agent?: string | null
}

export interface AgentGroup {
  group: string
  members: GroupMember[]
}

type Store = Record<string, AgentGroup[]>

const LS_KEY = 'agentGroups:v1'

function load(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw) as Store
  } catch {
    /* ignore malformed cache */
  }
  return {}
}

function persist(store: Store): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store))
  } catch {
    /* storage may be full/disabled - the in-memory copy still works */
  }
}

interface AgentGroupsState {
  byWorkspace: Store
  // Record a group after its panes have been spawned (chatKeys already assigned).
  createGroup: (ws: string, group: string, members: GroupMember[]) => void
  // Append one more member to an existing group (its pane already spawned).
  addMember: (ws: string, group: string, member: GroupMember) => void
  // Drop a member (by pane key), reindexing any parents that pointed past it.
  removeMember: (ws: string, group: string, chatKey: string) => void
  // Re-point a member at a freshly reopened pane (closed → reopened).
  setMemberChatKey: (ws: string, group: string, oldKey: string, newKey: string) => void
  // Edit a member's editable fields (name/persona/model/parent) after creation.
  updateMember: (
    ws: string,
    group: string,
    chatKey: string,
    patch: Partial<Pick<GroupMember, 'name' | 'persona' | 'model' | 'parent' | 'avatar' | 'agent'>>
  ) => void
  // Rename a group (its tab key).
  renameGroup: (ws: string, oldName: string, newName: string) => void
  // Remove the whole group from the roster (panes are closed by the caller).
  deleteGroup: (ws: string, group: string) => void
}

export const useAgentGroups = create<AgentGroupsState>((set) => ({
  byWorkspace: load(),

  createGroup: (ws, group, members) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).filter((g) => g.group !== group)
      const next = { ...s.byWorkspace, [ws]: [...list, { group, members }] }
      persist(next)
      return { byWorkspace: next }
    }),

  addMember: (ws, group, member) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).map((g) =>
        g.group === group ? { ...g, members: [...g.members, member] } : g
      )
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    }),

  removeMember: (ws, group, chatKey) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? [])
        .map((g) => {
          if (g.group !== group) return g
          const idx = g.members.findIndex((m) => m.chatKey === chatKey)
          if (idx < 0) return g
          const members = g.members
            .filter((_, i) => i !== idx)
            .map((m) => ({
              ...m,
              parent:
                m.parent == null
                  ? null
                  : m.parent === idx
                    ? null // reported to the removed member → orphan to a root
                    : m.parent > idx
                      ? m.parent - 1
                      : m.parent
            }))
          return { ...g, members }
        })
        .filter((g) => g.members.length > 0)
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    }),

  setMemberChatKey: (ws, group, oldKey, newKey) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).map((g) =>
        g.group === group
          ? {
              ...g,
              members: g.members.map((m) =>
                m.chatKey === oldKey ? { ...m, chatKey: newKey } : m
              )
            }
          : g
      )
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    }),

  updateMember: (ws, group, chatKey, patch) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).map((g) =>
        g.group === group
          ? {
              ...g,
              members: g.members.map((m) => (m.chatKey === chatKey ? { ...m, ...patch } : m))
            }
          : g
      )
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    }),

  renameGroup: (ws, oldName, newName) =>
    set((s) => {
      const trimmed = newName.trim()
      if (!trimmed || trimmed === oldName) return s
      const cur = s.byWorkspace[ws] ?? []
      // No-op if the new name collides with another group.
      if (cur.some((g) => g.group === trimmed)) return s
      const list = cur.map((g) => (g.group === oldName ? { ...g, group: trimmed } : g))
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    }),

  deleteGroup: (ws, group) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).filter((g) => g.group !== group)
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    })
}))

// Non-reactive selector for imperative code.
export function groupsForWorkspace(ws: string): AgentGroup[] {
  return useAgentGroups.getState().byWorkspace[ws] ?? []
}
