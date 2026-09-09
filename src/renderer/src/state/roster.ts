import { create } from 'zustand'
import { activityOf, type Live, type PaneKind, type RosterEntry } from './rosterActivity'
import { useSession } from './session'
import { getAgentStatus } from './agents'

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

export type { PaneKind, RosterEntry, Live } from './rosterActivity'
export { activityOf } from './rosterActivity'

interface RosterState {
  live: Record<string, Live>
  // Bumped when the layout-derived side changes, so views re-read it.
  rev: number
  patch: (key: string, p: Live) => void
  // The user interacted with this pane, so its completion has been seen. This is
  // the ONLY thing that clears `done` — not the pane becoming visible, not the
  // window regaining focus. A completion you never looked at must still be there
  // when you come back.
  seen: (key: string) => void
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
  seen: (key) =>
    set((s) => {
      const prev = s.live[key]
      if (!prev) return s
      // A terminal's completion arrives as attention:'finished' from main, which
      // also clears it on pty:seen — but clear it here too rather than waiting on
      // that round trip, so the ring goes out the instant the user clicks.
      // needs_input is left to main: it is authoritative about whether the agent
      // is still actually blocked.
      const attention = prev.attention === 'finished' ? null : prev.attention
      if (!prev.done && attention === prev.attention) return s
      return { live: { ...s.live, [key]: { ...prev, done: false, attention } } }
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

// The user touched this pane. Clears the renderer-side completion flag and, for
// a terminal, tells main its attention flag has been delivered.
export function markPaneSeen(paneKey: string): void {
  useRoster.getState().seen(paneKey)
  if (paneKey.startsWith('term-')) window.api.pty.seen(paneKey)
}

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

// Workspaces with at least one pane mid-turn. Layout-derived existence crossed
// with the app-level live signals, so it stays true for a workspace that isn't
// mounted — which is exactly the question App.tsx's LRU has to answer before it
// unmounts one.
export function busyWorkspaces(): Set<string> {
  const { live } = useRoster.getState()
  const out = new Set<string>()
  for (const p of layoutPanes()) if (live[p.id]?.busy) out.add(p.workspace)
  return out
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
    // A mounted chat pane's own controller has the richer live view (it knows
    // mid-turn), so it gets a say; completion still comes from the roster,
    // because the panel may not exist to report it.
    const paneStatus = p.kind === 'chat' ? getAgentStatus(p.id) : null
    out.push({ id: p.id, workspace, kind: p.kind, title, ...activityOf(l, paneStatus) })
  }
  return out
}

// One app-level subscription for the whole window. Call once at startup.
export function startRoster(): () => void {
  const { patch, drop, bump } = useRoster.getState()

  const offAgent = window.api.pty.onAgent(({ key, agent, name }) =>
    patch(key, { agent, name: name ?? null })
  )
  // A terminal's attention flag is main's, and main only clears it on pty:seen —
  // i.e. on a real interaction — so `finished` persists here for free.
  const offStatus = window.api.pty.onStatus(({ key, busy, attention }) =>
    patch(key, { busy, attention })
  )
  const offTitle = window.api.pty.onTitle(({ key, title }) => patch(key, { title }))

  // Chat panes: main streams a turn's events regardless of whether the pane is
  // on screen, so both busy AND the completion stay truthful for a workspace
  // that has been unmounted — which is precisely when the panel can't record it.
  const offChat = window.api.chat.onEvent((e) => {
    if (e.kind === 'turnDone') patch(e.key, { busy: false, done: !e.error })
    else if (e.kind === 'exit') patch(e.key, { busy: false })
    else if (e.kind === 'text' || e.kind === 'tool' || e.kind === 'usage')
      patch(e.key, { busy: true, done: false })
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
