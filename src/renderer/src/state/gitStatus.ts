import { create } from 'zustand'

// VSCode-style working-tree decoration category for a path.
export type GitCat = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflict'

// Precedence when a folder aggregates several changed descendants.
const RANK: Record<GitCat, number> = {
  untracked: 0,
  added: 1,
  renamed: 2,
  modified: 3,
  deleted: 4,
  conflict: 5
}

// Single-letter badge shown on the row, like VSCode's git decorations.
export const GIT_BADGE: Record<GitCat, string> = {
  modified: 'M',
  added: 'A',
  untracked: 'U',
  deleted: 'D',
  renamed: 'R',
  conflict: '!'
}

interface StatusFile {
  path: string
  x: string
  y: string
  untracked: boolean
}

function categorize(f: StatusFile): GitCat {
  if (f.untracked) return 'untracked'
  if (f.x === 'U' || f.y === 'U' || (f.x === 'A' && f.y === 'A') || (f.x === 'D' && f.y === 'D')) {
    return 'conflict'
  }
  const codes = f.x + f.y
  if (codes.includes('D')) return 'deleted'
  if (codes.includes('R')) return 'renamed'
  if (codes.includes('M')) return 'modified'
  if (codes.includes('A')) return 'added'
  return 'modified'
}

interface GitStatusState {
  files: Record<string, GitCat>
  dirs: Record<string, GitCat>
  refresh: (workspace: string) => Promise<void>
  clear: () => void
}

export const useGitStatus = create<GitStatusState>((set) => ({
  files: {},
  dirs: {},
  refresh: async (workspace) => {
    const res = await window.api.git.status(workspace).catch(() => null)
    if (!res || !res.isRepo) {
      set({ files: {}, dirs: {} })
      return
    }
    const files: Record<string, GitCat> = {}
    const dirs: Record<string, GitCat> = {}
    const bumpDir = (dir: string, cat: GitCat): void => {
      const prev = dirs[dir]
      if (prev === undefined || RANK[cat] > RANK[prev]) dirs[dir] = cat
    }
    for (const f of res.files as StatusFile[]) {
      const cat = categorize(f)
      const isDir = f.path.endsWith('/')
      const abs = (workspace + '/' + f.path).replace(/\/+$/, '')
      if (isDir) bumpDir(abs, cat)
      else files[abs] = cat
      // Propagate to every ancestor folder up to (and including) the workspace.
      let dir = abs.slice(0, abs.lastIndexOf('/'))
      while (dir.length >= workspace.length) {
        bumpDir(dir, cat)
        if (dir === workspace) break
        dir = dir.slice(0, dir.lastIndexOf('/'))
      }
    }
    set({ files, dirs })
  },
  clear: () => set({ files: {}, dirs: {} })
}))
