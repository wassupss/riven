import { create } from 'zustand'
import { useOutput } from './outputLog'

// Results of the last project-wide tsc/eslint run. The Problems panel merges these
// with the live Monaco (LSP) markers so issues in files that aren't open still show
// — just like VS Code. Keyed by source ('tsc'/'eslint') so a re-run of one tool
// replaces only its own results.

export interface ProjectDiagnostic {
  path: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source: string
  code?: string
}

interface State {
  bySource: Record<string, ProjectDiagnostic[]>
  running: Record<string, boolean>
  items: () => ProjectDiagnostic[]
  run: (root: string, kind: 'eslint' | 'tsc') => Promise<void>
  clear: () => void
}

export const useProjectDiagnostics = create<State>((set, get) => ({
  bySource: {},
  running: {},
  items: () => Object.values(get().bySource).flat(),
  run: async (root, kind) => {
    if (!root || get().running[kind]) return
    set((s) => ({ running: { ...s.running, [kind]: true } }))
    const channel = kind === 'tsc' ? 'TypeScript (tsc)' : 'ESLint'
    useOutput.getState().ensure(channel)
    useOutput.getState().append(channel, `\n=== ${kind} — ${new Date().toLocaleTimeString()} ===`)
    try {
      const res = await window.api.diagnostics.run(root, kind)
      useOutput.getState().append(channel, res.log || res.error || '(no output)')
      set((s) => ({ bySource: { ...s.bySource, [kind]: res.ok ? res.diagnostics : [] } }))
    } catch (e) {
      useOutput.getState().append(channel, `error: ${String(e)}`)
    } finally {
      set((s) => ({ running: { ...s.running, [kind]: false } }))
    }
  },
  clear: () => set({ bySource: {} })
}))
