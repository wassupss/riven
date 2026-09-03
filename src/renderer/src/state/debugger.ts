import { create } from 'zustand'
import { useOutput } from './outputLog'
import { useNav } from './nav'
import { useSession, pathOf } from './session'

// Renderer-side debug session state. Bridges main's Node/CDP debugger (see
// src/main/debugger.ts) to the editor gutter + Debug drawer.

export interface DebugFrame {
  id: string
  name: string
  file: string
  line: number
  column: number
}
export interface DebugScope {
  type: string
  name?: string
  objectId?: string
}

type Status = 'idle' | 'running' | 'paused'
const DEBUG_CHANNEL = 'Debug Console'

interface State {
  status: Status
  frames: DebugFrame[]
  scopes: DebugScope[]
  activeFrameId: string | null
  current: { file: string; line: number } | null // execution pointer for highlight
  breakpoints: Record<string, number[]> // file -> 1-based lines
  start: (file: string) => Promise<void>
  stop: () => void
  cont: () => void
  stepOver: () => void
  stepInto: () => void
  stepOut: () => void
  setActiveFrame: (id: string) => void
  toggleBreakpoint: (file: string, line: number) => void
  bpLines: (file: string) => number[]
}

let wired = false
function ensureWired(): void {
  if (wired) return
  wired = true
  window.api.debug.onEvent(({ type, payload }) => {
    const s = useDebugger.getState()
    const p = payload as Record<string, unknown>
    switch (type) {
      case 'started':
        useDebugger.setState({ status: 'running' })
        useOutput.getState().ensure(DEBUG_CHANNEL)
        useOutput.getState().append(DEBUG_CHANNEL, '=== debug session started ===')
        break
      case 'paused': {
        const frames = (p.frames as DebugFrame[]) ?? []
        const scopes = (p.scopes as DebugScope[]) ?? []
        const top = frames[0]
        useDebugger.setState({
          status: 'paused',
          frames,
          scopes,
          activeFrameId: top?.id ?? null,
          current: top && top.file ? { file: top.file, line: top.line } : null
        })
        // Jump the editor to the paused location.
        if (top?.file) {
          const ws = useSession
            .getState()
            .openWorkspaces.find((w) => top.file.startsWith(pathOf(w) + '/'))
          if (ws) useSession.getState().setActiveWorkspace(ws)
          useSession.getState().openFile(top.file)
          useNav.getState().requestReveal(top.file, top.line, top.column)
        }
        break
      }
      case 'resumed':
        useDebugger.setState({ status: 'running', current: null, frames: [], scopes: [] })
        break
      case 'output':
        useOutput.getState().ensure(DEBUG_CHANNEL)
        useOutput.getState().append(DEBUG_CHANNEL, String(p.text ?? '').replace(/\n$/, ''))
        break
      case 'terminated':
        useDebugger.setState({ status: 'idle', current: null, frames: [], scopes: [], activeFrameId: null })
        useOutput.getState().append(DEBUG_CHANNEL, `=== debug session ended (code ${String(p?.code)}) ===`)
        break
    }
    void s
  })
}

export const useDebugger = create<State>((set, get) => {
  ensureWired()
  return {
    status: 'idle',
    frames: [],
    scopes: [],
    activeFrameId: null,
    current: null,
    breakpoints: {},
    start: async (file) => {
      ensureWired()
      const ws = useSession.getState().activeWorkspace
      const cwd = ws ? pathOf(ws) : undefined
      useOutput.getState().ensure(DEBUG_CHANNEL)
      // Push all breakpoints first so they're armed before the program runs.
      for (const [f, lines] of Object.entries(get().breakpoints)) {
        await window.api.debug.setBreakpoints(f, lines)
      }
      const res = await window.api.debug.start({ file, cwd })
      if (!res.ok) {
        useOutput.getState().append(DEBUG_CHANNEL, `failed to start: ${res.error ?? 'unknown'}`)
        set({ status: 'idle' })
      }
    },
    stop: () => void window.api.debug.stop(),
    cont: () => void window.api.debug.cont(),
    stepOver: () => void window.api.debug.stepOver(),
    stepInto: () => void window.api.debug.stepInto(),
    stepOut: () => void window.api.debug.stepOut(),
    setActiveFrame: (id) => set({ activeFrameId: id }),
    toggleBreakpoint: (file, line) => {
      const cur = get().breakpoints[file] ?? []
      const next = cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b)
      set({ breakpoints: { ...get().breakpoints, [file]: next } })
      void window.api.debug.setBreakpoints(file, next)
    },
    bpLines: (file) => get().breakpoints[file] ?? []
  }
})
