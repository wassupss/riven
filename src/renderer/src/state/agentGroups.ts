import { create } from 'zustand'
import { useSession } from './session'

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
  // Which agent runs this member (claude | codex). Absent = claude, which is
  // all a member could be before Codex panes existed.
  cli?: 'claude' | 'codex'
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

// Where the roster USED to live. Kept only to migrate an existing install: it
// is per renderer origin, while the panes it names live in sessions.json, so the
// two could (and did) drift apart — a group pointing at panes that were never
// restored, with no way to tell which half was stale.
const LS_KEY = 'agentGroups:v1'

function loadLegacy(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw) as Store
  } catch {
    /* ignore malformed cache */
  }
  return {}
}

// The roster is saved with the workspace it belongs to, beside its panes.
//
// Never before the tree has been adopted: this store starts empty, so a write
// that beat the load would persist "no groups" over the real ones. Observed
// doing exactly that — a group created in one run was gone after a restart, and
// the file on disk had been rewritten without it.
function persist(store: Store, ws?: string): void {
  adopt()
  const st = useSession.getState()
  if (!st.ready) return
  if (ws) st.patch(ws, { groups: store[ws] ?? [] })
  else for (const [w, groups] of Object.entries(store)) st.patch(w, { groups })
}

/**
 * The roster to start from: what the workspace tree holds, falling back to the
 * old localStorage copy for a workspace the tree has nothing for (the one-time
 * migration). Pure so the merge is testable.
 */
export function mergeRosters(
  fromTree: Record<string, AgentGroup[]>,
  legacy: Record<string, AgentGroup[]>
): Store {
  const out: Store = {}
  for (const [ws, groups] of Object.entries(fromTree)) out[ws] = groups.length ? groups : legacy[ws] ?? []
  for (const [ws, groups] of Object.entries(legacy)) if (!out[ws]?.length) out[ws] = groups
  return out
}

// Sessions load asynchronously, so adopt the tree's rosters the moment it is
// ready (and write back anything that came from the old store).
let adopted = false
function adopt(): void {
  if (adopted) return
  const st = useSession.getState()
  if (!st.ready) return
  adopted = true
  const fromTree: Record<string, AgentGroup[]> = {}
  for (const [ws, s] of Object.entries(st.sessions)) fromTree[ws] = (s.groups ?? []) as AgentGroup[]
  const merged = mergeRosters(fromTree, loadLegacy())
  useAgentGroups.setState({ byWorkspace: merged })
  for (const [ws, groups] of Object.entries(merged)) {
    if (groups.length && !(fromTree[ws] ?? []).length) st.patch(ws, { groups })
  }
}
// Both paths, because neither is enough on its own: the subscription only fires
// on LATER changes (this module may be imported long after the load), and an
// eager call does nothing if the sessions have not arrived yet.
useSession.subscribe(adopt)
adopt()

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
    patch: Partial<Pick<GroupMember, 'name' | 'persona' | 'model' | 'parent' | 'avatar' | 'agent' | 'cli'>>
  ) => void
  // Rename a group (its tab key).
  renameGroup: (ws: string, oldName: string, newName: string) => void
  // Remove the whole group from the roster (panes are closed by the caller).
  deleteGroup: (ws: string, group: string) => void
}

export const useAgentGroups = create<AgentGroupsState>((set) => ({
  byWorkspace: {},

  createGroup: (ws, group, members) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).filter((g) => g.group !== group)
      const next = { ...s.byWorkspace, [ws]: [...list, { group, members }] }
      persist(next, ws)
      return { byWorkspace: next }
    }),

  addMember: (ws, group, member) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).map((g) =>
        g.group === group ? { ...g, members: [...g.members, member] } : g
      )
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next, ws)
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
      persist(next, ws)
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
      persist(next, ws)
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
      persist(next, ws)
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
      persist(next, ws)
      return { byWorkspace: next }
    }),

  deleteGroup: (ws, group) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).filter((g) => g.group !== group)
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next, ws)
      return { byWorkspace: next }
    })
}))

// Non-reactive selector for imperative code.
export function groupsForWorkspace(ws: string): AgentGroup[] {
  return useAgentGroups.getState().byWorkspace[ws] ?? []
}
