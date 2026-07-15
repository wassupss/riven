import type { DockviewApi } from 'dockview'
import { t } from '../i18n'
import { isPaneBusy } from '../state/workspaceStatus'

// Confirm before closing a terminal whose agent is actively running (busy).
// Returns true when it's OK to proceed with the close.
export function confirmTerminalClose(panelId: string): boolean {
  if (!panelId.startsWith('term-')) return true
  const paneId = Number(panelId.slice('term-'.length))
  if (!Number.isFinite(paneId) || !isPaneBusy(paneId)) return true
  return window.confirm(t('term.closeBusyConfirm'))
}

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
    title: initialCommand ? `❯ ${initialCommand}` : `❯ ${t('title.terminal')}`,
    params: { paneId, initialCommand },
    renderer: 'always'
  })
}

// Split: add a terminal beside/below the active panel (cmux-style pane splits).
export function splitTerminal(direction: 'right' | 'below'): void {
  const api = activeApi
  if (!api) return
  const paneId = nextPaneId()
  const ref = api.activePanel
  api.addPanel({
    id: `term-${paneId}`,
    component: 'terminal',
    title: '❯ 터미널',
    params: { paneId },
    renderer: 'always',
    position: ref ? { referencePanel: ref.id, direction } : undefined
  })
}

// Cycle tabs within the active group (next/prev terminal tab).
export function cycleGroupTab(delta: number): void {
  const api = activeApi
  const group = api?.activeGroup
  if (!api || !group) return
  const panels = group.panels
  if (panels.length < 2) return
  const i = panels.findIndex((p) => p.id === group.activePanel?.id)
  const next = panels[(((i < 0 ? 0 : i) + delta) % panels.length + panels.length) % panels.length]
  next.api.setActive()
}

// Focus the nth terminal (1-based) in the active workspace.
export function selectTerminal(n: number): void {
  const api = activeApi
  if (!api) return
  const terms = api.panels.filter((p) => p.id.startsWith('term-'))
  terms[n - 1]?.api.setActive()
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
    title: t('title.editor'),
    renderer: 'always',
    position: term ? { referencePanel: term.id, direction: 'right' } : undefined
  })
}

const SINGLETONS: Record<string, { titleKey: string; direction: 'left' | 'right' | 'below' }> = {
  editor: { titleKey: 'title.editor', direction: 'right' },
  preview: { titleKey: 'title.preview', direction: 'right' },
  search: { titleKey: 'title.search', direction: 'left' },
  git: { titleKey: 'title.git', direction: 'left' },
  changes: { titleKey: 'title.changes', direction: 'left' }
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
    api.addPanel({
      id,
      component: id,
      title: t(cfg.titleKey),
      renderer: 'always',
      position: { direction: cfg.direction }
    })
  }
}
