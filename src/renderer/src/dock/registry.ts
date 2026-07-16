import type { DockviewApi } from 'dockview'
import { t } from '../i18n'
import { isPaneBusy } from '../state/workspaceStatus'
import { focusPane, focusEditor } from '../keybindings/focus'

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

export type FocusDir = 'left' | 'right' | 'up' | 'down'

// Move focus to the split group spatially adjacent to the active one, in the
// given direction (Ctrl+Cmd+Arrow). Uses the groups' on-screen rects so it's
// truly directional (unlike cyclePanel's flat next/prev), matching how tiling
// window managers navigate splits.
export function focusGroupInDirection(dir: FocusDir): void {
  const api = activeApi
  if (!api) return
  const groups = api.groups
  if (groups.length < 2) return
  const active = api.activeGroup ?? groups[0]
  const from = active.element.getBoundingClientRect()
  const fx = from.left + from.width / 2
  const fy = from.top + from.height / 2
  const horizontal = dir === 'left' || dir === 'right'
  const sign = dir === 'left' || dir === 'up' ? -1 : 1

  let best: { g: (typeof groups)[number]; score: number } | null = null
  for (const g of groups) {
    if (g === active) continue
    const r = g.element.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // Primary axis: how far in the requested direction; must be a real step.
    const primary = (horizontal ? cx - fx : cy - fy) * sign
    if (primary < 1) continue
    // Cross axis: penalize groups offset perpendicular to the direction so we
    // prefer the neighbor most directly in line with the current group.
    const cross = Math.abs(horizontal ? cy - fy : cx - fx)
    const score = primary + cross * 2
    if (!best || score < best.score) best = { g, score }
  }
  const target = best?.g
  const panel = target?.activePanel
  if (!panel) return
  // Activate the tab, then route to the real focuser so the caret actually
  // lands there — dockview's panel.focus() only calls setActive(), which shows
  // the pane but leaves keyboard focus in the group you came from.
  panel.api.setActive()
  if (panel.id.startsWith('term-')) {
    const paneId = Number(panel.id.slice('term-'.length))
    if (Number.isFinite(paneId)) focusPane(paneId)
  } else if (panel.id === 'editor') {
    focusEditor()
  } else {
    panel.focus()
  }
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

// Auto-open the changes timeline when an agent edit arrives (idempotent). Opens
// it on the left WITHOUT stealing focus from the terminal the user is typing in,
// so agent activity surfaces the summary without hijacking the cursor.
export function ensureChanges(): void {
  const api = activeApi
  if (!api || api.getPanel('changes')) return
  const prev = api.activePanel
  api.addPanel({
    id: 'changes',
    component: 'changes',
    title: t('title.changes'),
    renderer: 'always',
    // A directional split with no size defaults to ~50/50; the Changes timeline
    // is a narrow summary list, so open it at a sidebar width instead of half
    // the workbench.
    initialWidth: 280,
    position: { direction: 'left' }
  })
  prev?.api.setActive()
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
