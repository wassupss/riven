import { create } from 'zustand'
import { useSession } from './session'
import { getAgentStatus, type AgentActivity } from './agents'

// Every agent pane in every OPEN workspace — whether or not that workspace is
// currently mounted.
//
// The rail used to read the live controller registry, which only holds panes
// whose React component is mounted. The mounted set is LRU-bounded (App.tsx,
// MAX_MOUNTED), so visiting a fourth workspace silently emptied the roster of
// the one that fell out: its agents looked gone even though their CLI children
// and PTYs were still running and still doing work. Existence therefore comes
// from the PERSISTED dock layout, which survives unmounting, and only the live
// status is overlaid on top.
//
// A terminal counts as an agent only while a CLI agent is actually running in it
// (main's `pty:agent`), so a plain shell never shows up as a teammate.

export type PaneKind = 'chat' | 'terminal'

export interface RosterEntry {
  id: string // pane key: chat-N | term-N
  workspace: string
  kind: PaneKind
  title: string
  busy: boolean
  attention: boolean
  status: AgentActivity
}

// Live signals, keyed by pane key. Fed by ONE app-level subscription to main's
// broadcasts rather than by each panel, so a pane going off screen no longer
// takes its status with it.
interface Live {
  agent?: boolean // terminal: a CLI agent is running
  name?: string | null // terminal: the agent's name, from pty:agent
  title?: string // terminal: the pty title
  busy?: boolean
  attention?: boolean
}

interface RosterState {
  live: Record<string, Live>
  // Bumped when the layout-derived side changes, so views re-read it.
  rev: number
  patch: (key: string, p: Live) => void
  drop: (key: string) => void
  bump: () => void
}

export const useRoster = create<RosterState>((set) => ({
  live: {},
  rev: 0,
  patch: (key, p) =>
    set((s) => {
      const prev = s.live[key]
      const next = { ...prev, ...p }
      // Zustand compares by reference; skip the write when nothing moved so a
      // chatty pty:status stream doesn't re-render the whole rail.
      if (prev && (Object.keys(next) as Array<keyof Live>).every((k) => prev[k] === next[k])) return s
      return { live: { ...s.live, [key]: next } }
    }),
  drop: (key) =>
    set((s) => {
      if (!(key in s.live)) return s
      const live = { ...s.live }
      delete live[key]
      return { live }
    }),
  bump: () => set((s) => ({ rev: s.rev + 1 }))
}))

// Panes the persisted layout says exist, per workspace. dockview serializes its
// panels as { id: { contentComponent, title } }, which is exactly what we need
// and is written on every layout change.
interface LayoutPane {
  id: string
  workspace: string
  kind: PaneKind
  title: string
}

function layoutPanes(): LayoutPane[] {
  const st = useSession.getState()
  const out: LayoutPane[] = []
  for (const wid of st.openWorkspaces) {
    const layout = st.sessions[wid]?.dockLayout as
      | { panels?: Record<string, { title?: string; contentComponent?: string }> }
      | null
      | undefined
    const panels = layout?.panels
    if (!panels) continue
    for (const [id, p] of Object.entries(panels)) {
      const kind: PaneKind | null =
        p?.contentComponent === 'chat' ? 'chat' : p?.contentComponent === 'terminal' ? 'terminal' : null
      if (!kind) continue
      out.push({ id, workspace: wid, kind, title: p?.title || id })
    }
  }
  return out
}

// Which workspace a pane belongs to, from the layout — valid while unmounted,
// unlike anything derived from the live dock.
export function workspaceOfPane(paneKey: string): string | null {
  return layoutPanes().find((p) => p.id === paneKey)?.workspace ?? null
}

// The agent panes of one workspace: every native chat, plus terminals that
// currently have a CLI agent running.
export function rosterFor(workspace: string): RosterEntry[] {
  const { live } = useRoster.getState()
  const out: RosterEntry[] = []
  for (const p of layoutPanes()) {
    if (p.workspace !== workspace) continue
    const l = live[p.id] ?? {}
    if (p.kind === 'terminal' && !l.agent) continue
    // A terminal's name comes from the running agent (pty:agent); fall back to
    // the tab title so it is never blank.
    const title = p.kind === 'terminal' ? l.name || l.title || p.title : p.title
    const status = p.kind === 'chat' ? getAgentStatus(p.id) : l.attention ? 'waiting' : l.busy ? 'busy' : 'idle'
    out.push({
      id: p.id,
      workspace,
      kind: p.kind,
      title,
      busy: !!l.busy,
      attention: !!l.attention,
      status
    })
  }
  return out
}

// One app-level subscription for the whole window. Call once at startup.
export function startRoster(): () => void {
  const { patch, drop, bump } = useRoster.getState()

  const offAgent = window.api.pty.onAgent(({ key, agent, name }) =>
    patch(key, { agent, name: name ?? null })
  )
  const offStatus = window.api.pty.onStatus(({ key, busy, attention }) =>
    patch(key, { busy, attention: attention !== null })
  )
  const offTitle = window.api.pty.onTitle(({ key, title }) => patch(key, { title }))

  // Chat panes: main streams a turn's events regardless of whether the pane is
  // on screen, so busy stays truthful for a workspace that has been unmounted.
  const offChat = window.api.chat.onEvent((e) => {
    if (e.kind === 'turnDone' || e.kind === 'exit') patch(e.key, { busy: false })
    else if (e.kind === 'text' || e.kind === 'tool' || e.kind === 'usage') patch(e.key, { busy: true })
  })

  // The layout-derived half changes when a pane is added/closed or a workspace
  // opens/closes; that all lands in the session store. Closed panes leave the
  // layout, so that is also when their live signals become garbage — there is no
  // app-wide pty exit stream to hang this off (onExit is per-id).
  const offSession = useSession.subscribe(() => {
    const alive = new Set(layoutPanes().map((p) => p.id))
    for (const key of Object.keys(useRoster.getState().live)) if (!alive.has(key)) drop(key)
    bump()
  })

  return () => {
    offAgent()
    offStatus()
    offTitle()
    offChat()
    offSession()
  }
}
