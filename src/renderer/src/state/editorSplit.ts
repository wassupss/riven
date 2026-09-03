import { create } from 'zustand'

// Free-form, VS Code-style editor splitting INSIDE the editor panel.
//
// The layout is a recursive tree of editor groups. A `leaf` is one group (its own
// tab strip + Monaco); a `branch` arranges its children in a row (side by side) or
// a column (stacked), and can nest arbitrarily deep and in any direction. You
// split by dragging a file tab onto one of the four edge drop-zones of a group.
//
// The PRIMARY group (`editor`) is backed by the workspace session (its openTabs /
// activePath persist + restore); every other group is stored here in `groups`.

export type Edge = 'left' | 'right' | 'top' | 'bottom'

export type SplitNode =
  | { type: 'leaf'; group: string }
  | { type: 'branch'; dir: 'row' | 'col'; children: SplitNode[]; sizes: number[] }

interface Group {
  openTabs: string[]
  activePath: string | null
}

interface WsEditor {
  tree: SplitNode
  groups: Record<string, Group> // non-primary groups only ('editor' lives in session)
  activeGroup: string
  seq: number
}

interface DragInfo {
  ws: string
  group: string
  path: string
}

interface EditorSplitState {
  byWs: Record<string, WsEditor>
  drag: DragInfo | null
  setDrag: (d: DragInfo | null) => void
  // Layout accessors (default = a single primary leaf).
  tree: (ws: string) => SplitNode
  activeGroup: (ws: string) => string
  focusGroup: (ws: string, group: string) => void
  setSizes: (ws: string, path: number[], sizes: number[]) => void
  // Group tab operations (non-primary groups; primary uses the session store).
  openInGroup: (ws: string, group: string, path: string) => void
  closeInGroup: (ws: string, group: string, path: string) => void
  reorderInGroup: (ws: string, group: string, from: number, to: number) => void
  // Split `targetGroup` by dropping `path` into a NEW group on the given edge.
  // `sourceGroup` is where the tab came from (removed there afterwards).
  splitWith: (ws: string, targetGroup: string, edge: Edge, sourceGroup: string, path: string) => void
  // Move an open tab into an existing group (drop onto its tab strip).
  moveTab: (ws: string, sourceGroup: string, targetGroup: string, path: string) => void
  // Prune a non-primary group when it empties, collapsing single-child branches.
  pruneEmpty: (ws: string) => void
}

const PRIMARY = 'editor'

function defaultWs(): WsEditor {
  return { tree: { type: 'leaf', group: PRIMARY }, groups: {}, activeGroup: PRIMARY, seq: 1 }
}

// Deep-clone a tree so edits never mutate React-held state.
function clone(n: SplitNode): SplitNode {
  return n.type === 'leaf'
    ? { type: 'leaf', group: n.group }
    : { type: 'branch', dir: n.dir, sizes: [...n.sizes], children: n.children.map(clone) }
}

// Replace the leaf holding `group` with `make(leaf)` (returns the new subtree).
function replaceLeaf(
  n: SplitNode,
  group: string,
  make: (leaf: SplitNode) => SplitNode
): SplitNode {
  if (n.type === 'leaf') return n.group === group ? make(n) : n
  return { ...n, children: n.children.map((c) => replaceLeaf(c, group, make)) }
}

// Remove the leaf holding `group`; collapse a branch left with one child.
function removeLeaf(n: SplitNode, group: string): SplitNode | null {
  if (n.type === 'leaf') return n.group === group ? null : n
  const kids: SplitNode[] = []
  const sizes: number[] = []
  n.children.forEach((c, i) => {
    const r = removeLeaf(c, group)
    if (r) {
      kids.push(r)
      sizes.push(n.sizes[i] ?? 100 / n.children.length)
    }
  })
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
  const total = sizes.reduce((a, b) => a + b, 0) || 1
  return { type: 'branch', dir: n.dir, children: kids, sizes: sizes.map((s) => (s / total) * 100) }
}

// Set the sizes array of the branch at `path` (indices from the root).
function setSizesAt(n: SplitNode, path: number[], sizes: number[]): SplitNode {
  if (path.length === 0) {
    if (n.type === 'branch') return { ...n, sizes }
    return n
  }
  if (n.type !== 'branch') return n
  const [i, ...rest] = path
  return {
    ...n,
    children: n.children.map((c, j) => (j === i ? setSizesAt(c, rest, sizes) : c))
  }
}

export const useEditorSplit = create<EditorSplitState>((set, get) => ({
  byWs: {},
  drag: null,
  setDrag: (d) => set({ drag: d }),

  tree: (ws) => get().byWs[ws]?.tree ?? { type: 'leaf', group: PRIMARY },
  activeGroup: (ws) => get().byWs[ws]?.activeGroup ?? PRIMARY,

  focusGroup: (ws, group) =>
    set((s) => {
      const w = s.byWs[ws] ?? defaultWs()
      if (w.activeGroup === group) return s
      return { byWs: { ...s.byWs, [ws]: { ...w, activeGroup: group } } }
    }),

  setSizes: (ws, path, sizes) =>
    set((s) => {
      const w = s.byWs[ws]
      if (!w) return s
      return { byWs: { ...s.byWs, [ws]: { ...w, tree: setSizesAt(w.tree, path, sizes) } } }
    }),

  openInGroup: (ws, group, path) =>
    set((s) => {
      const w = s.byWs[ws] ?? defaultWs()
      const g = w.groups[group] ?? { openTabs: [], activePath: null }
      const openTabs = g.openTabs.includes(path) ? g.openTabs : [...g.openTabs, path]
      return {
        byWs: {
          ...s.byWs,
          [ws]: { ...w, activeGroup: group, groups: { ...w.groups, [group]: { openTabs, activePath: path } } }
        }
      }
    }),

  closeInGroup: (ws, group, path) => {
    set((s) => {
      const w = s.byWs[ws]
      if (!w) return s
      const g = w.groups[group]
      if (!g) return s
      const i = g.openTabs.indexOf(path)
      const openTabs = g.openTabs.filter((p) => p !== path)
      let activePath = g.activePath
      if (activePath === path) activePath = openTabs[Math.max(0, i - 1)] ?? openTabs[0] ?? null
      return {
        byWs: { ...s.byWs, [ws]: { ...w, groups: { ...w.groups, [group]: { openTabs, activePath } } } }
      }
    })
    get().pruneEmpty(ws)
  },

  reorderInGroup: (ws, group, from, to) =>
    set((s) => {
      const w = s.byWs[ws]
      if (!w) return s
      const g = w.groups[group]
      if (!g) return s
      const openTabs = [...g.openTabs]
      const [moved] = openTabs.splice(from, 1)
      openTabs.splice(to, 0, moved)
      return { byWs: { ...s.byWs, [ws]: { ...w, groups: { ...w.groups, [group]: { ...g, openTabs } } } } }
    }),

  splitWith: (ws, targetGroup, edge, sourceGroup, path) =>
    set((s) => {
      const w = s.byWs[ws] ?? defaultWs()
      const newGroup = `g${w.seq + 1}`
      const dir: 'row' | 'col' = edge === 'left' || edge === 'right' ? 'row' : 'col'
      const before = edge === 'left' || edge === 'top'
      const newLeaf: SplitNode = { type: 'leaf', group: newGroup }

      const tree = replaceLeaf(clone(w.tree), targetGroup, (leaf) => ({
        type: 'branch',
        dir,
        children: before ? [newLeaf, leaf] : [leaf, newLeaf],
        sizes: [50, 50]
      }))

      // Move the tab: add to the new group, remove from the source.
      const groups = { ...w.groups }
      groups[newGroup] = { openTabs: [path], activePath: path }
      if (sourceGroup !== PRIMARY) {
        const src = groups[sourceGroup]
        if (src) {
          const i = src.openTabs.indexOf(path)
          const openTabs = src.openTabs.filter((p) => p !== path)
          let activePath = src.activePath
          if (activePath === path) activePath = openTabs[Math.max(0, i - 1)] ?? openTabs[0] ?? null
          groups[sourceGroup] = { openTabs, activePath }
        }
      }
      return {
        byWs: { ...s.byWs, [ws]: { tree, groups, activeGroup: newGroup, seq: w.seq + 1 } }
      }
    }),
  // NOTE: when the source is the PRIMARY group, the caller also removes the tab
  // from the session (the primary group is session-backed, not stored here).

  moveTab: (ws, sourceGroup, targetGroup, path) => {
    set((s) => {
      const w = s.byWs[ws] ?? defaultWs()
      const groups = { ...w.groups }
      // Add into target (non-primary target only; primary handled by caller).
      if (targetGroup !== PRIMARY) {
        const tg = groups[targetGroup] ?? { openTabs: [], activePath: null }
        const openTabs = tg.openTabs.includes(path) ? tg.openTabs : [...tg.openTabs, path]
        groups[targetGroup] = { openTabs, activePath: path }
      }
      // Remove from source (non-primary source only).
      if (sourceGroup !== PRIMARY && sourceGroup !== targetGroup) {
        const src = groups[sourceGroup]
        if (src) {
          const i = src.openTabs.indexOf(path)
          const openTabs = src.openTabs.filter((p) => p !== path)
          let activePath = src.activePath
          if (activePath === path) activePath = openTabs[Math.max(0, i - 1)] ?? openTabs[0] ?? null
          groups[sourceGroup] = { openTabs, activePath }
        }
      }
      return { byWs: { ...s.byWs, [ws]: { ...w, groups, activeGroup: targetGroup } } }
    })
    get().pruneEmpty(ws)
  },

  pruneEmpty: (ws) =>
    set((s) => {
      const w = s.byWs[ws]
      if (!w) return s
      let tree = w.tree
      const groups = { ...w.groups }
      let changed = false
      // Remove any non-primary group with no open tabs.
      for (const gid of Object.keys(groups)) {
        if (groups[gid].openTabs.length === 0) {
          delete groups[gid]
          const r = removeLeaf(tree, gid)
          tree = r ?? { type: 'leaf', group: PRIMARY }
          changed = true
        }
      }
      if (!changed) return s
      const activeGroup = groups[w.activeGroup] || w.activeGroup === PRIMARY ? w.activeGroup : PRIMARY
      return { byWs: { ...s.byWs, [ws]: { ...w, tree, groups, activeGroup } } }
    })
}))

// Backwards-compatible helper used by openEditorSplit(): split the primary group
// to the right, moving `path` into a new group.
export function splitPrimaryRight(ws: string, path: string): void {
  useEditorSplit.getState().splitWith(ws, PRIMARY, 'right', PRIMARY, path)
}
