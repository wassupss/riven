import { useRoster, rosterFor } from './roster'
import { useAgents } from './agents'
import { useSession, pathOf } from './session'
import { useSettings } from './settings'

// What the menu bar icon shows (main/tray): every agent, in every open
// workspace, that is waiting on the user or finished something nobody has looked
// at yet — the same two states the rail marks, read from the same roster.
//
// Sent whole, and only when it changed: the roster moves on every token a busy
// pane streams, the list almost never does.

type Item = { paneId: string; title: string; workspace: string; kind: 'waiting' | 'done' }

function feed(): { enabled: boolean; items: Item[]; busy: number; ko: boolean } {
  const { openWorkspaces, names } = useSession.getState()
  const settings = useSettings.getState().settings
  const waiting: Item[] = []
  const done: Item[] = []
  let busy = 0
  for (const ws of openWorkspaces) {
    const name = names[ws] || pathOf(ws).split('/').pop() || ws
    for (const e of rosterFor(ws)) {
      if (e.busy) busy++
      if (e.attention) waiting.push({ paneId: e.id, title: e.title, workspace: name, kind: 'waiting' })
      else if (e.done) done.push({ paneId: e.id, title: e.title, workspace: name, kind: 'done' })
    }
  }
  return { enabled: settings.menuBarIcon, items: [...waiting, ...done], busy, ko: settings.language !== 'en' }
}

export function startTrayFeed(): () => void {
  let sent = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const send = (): void => {
    timer = null
    const f = feed()
    const key = JSON.stringify(f)
    if (key === sent) return
    sent = key
    window.api.tray.feed(f)
  }
  const soon = (): void => {
    if (!timer) timer = setTimeout(send, 250)
  }
  const offs = [
    useRoster.subscribe(soon),
    useAgents.subscribe(soon),
    useSettings.subscribe((s, prev) => {
      if (s.settings.menuBarIcon !== prev.settings.menuBarIcon || s.settings.language !== prev.settings.language) soon()
    }),
    useSession.subscribe((s, prev) => {
      if (s.openWorkspaces !== prev.openWorkspaces || s.names !== prev.names) soon()
    })
  ]
  send()
  return () => {
    if (timer) clearTimeout(timer)
    for (const off of offs) off()
  }
}
