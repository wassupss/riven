import { create } from 'zustand'

// Per-directory version counter. Bumping a directory tells its TreeNode (and the
// root) to re-read children — used for file create/rename/delete and fs watch.
interface TreeState {
  versions: Record<string, number>
  collapseToken: number
  bump: (dir: string) => void
  collapseAll: () => void
}

export const useTree = create<TreeState>((set) => ({
  versions: {},
  collapseToken: 0,
  bump: (dir) => set((s) => ({ versions: { ...s.versions, [dir]: (s.versions[dir] ?? 0) + 1 } })),
  collapseAll: () => set((s) => ({ collapseToken: s.collapseToken + 1 }))
}))
