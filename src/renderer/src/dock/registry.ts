import type { DockviewApi } from 'dockview'

// Points at the active workspace's dockview instance so global toolbar buttons
// and keybindings can add terminals / focus singleton panels.

let activeApi: DockviewApi | null = null
export function setActiveApi(api: DockviewApi | null): void {
  activeApi = api
}
export function getActiveApi(): DockviewApi | null {
  return activeApi
}

let seq = 1
export function nextPaneId(): number {
  return seq++
}
export function bumpPaneSeq(ids: string[]): void {
  for (const id of ids) {
    const m = /term-(\d+)/.exec(id)
    if (m) seq = Math.max(seq, Number(m[1]) + 1)
  }
}

export function addTerminal(initialCommand?: string): void {
  const api = activeApi
  if (!api) return
  const paneId = nextPaneId()
  api.addPanel({
    id: `term-${paneId}`,
    component: 'terminal',
    title: initialCommand ? `❯ ${initialCommand}` : '❯ 터미널',
    params: { paneId, initialCommand },
    renderer: 'always'
  })
}

// Cycle the active dockview panel (keyboard navigation across the grid).
export function cyclePanel(delta: number): void {
  const api = activeApi
  if (!api) return
  const panels = api.panels
  if (panels.length < 2) return
  const i = panels.findIndex((p) => p.id === api.activePanel?.id)
  const next = panels[(((i < 0 ? 0 : i) + delta) % panels.length + panels.length) % panels.length]
  next.api.setActive()
}

// Pop the active panel's group out into a separate OS window (useful when the
// screen is cramped or on a second monitor).
export function popoutActive(): void {
  const api = activeApi
  const panel = api?.activePanel
  if (!api || !panel) return
  try {
    api.addPopoutGroup(panel.group)
  } catch (e) {
    console.error('[dock] popout failed', e)
  }
}

// Ensure the editor panel exists (opened when a file is selected).
export function ensureEditor(): void {
  const api = activeApi
  if (!api) return
  const existing = api.getPanel('editor')
  if (existing) {
    existing.api.setActive()
    return
  }
  const term = api.panels.find((p) => p.id.startsWith('term-'))
  api.addPanel({
    id: 'editor',
    component: 'editor',
    title: '코드',
    renderer: 'always',
    position: term ? { referencePanel: term.id, direction: 'right' } : undefined
  })
}

const SINGLETONS: Record<string, { title: string; direction: 'left' | 'right' | 'below' }> = {
  editor: { title: '코드', direction: 'right' },
  preview: { title: '프리뷰', direction: 'right' },
  search: { title: '검색', direction: 'left' },
  git: { title: 'Git', direction: 'left' },
  cli: { title: 'CLI', direction: 'left' }
}

// Close a terminal panel by its pane id (used by the focus-aware ⌘W handler).
export function closeTerminalById(paneId: number): void {
  const api = activeApi
  const panel = api?.getPanel(`term-${paneId}`)
  if (panel) api.removePanel(panel)
}

export function togglePanel(id: keyof typeof SINGLETONS): void {
  const api = activeApi
  if (!api) return
  const existing = api.getPanel(id)
  if (existing) {
    existing.api.setActive()
  } else {
    const cfg = SINGLETONS[id]
    api.addPanel({ id, component: id, title: cfg.title, renderer: 'always', position: { direction: cfg.direction } })
  }
}
