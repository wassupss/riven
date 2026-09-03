import { create } from 'zustand'

// Output channels (VS Code "Output" view): named log streams the app writes to —
// language-server logs, and our tsc/eslint diagnostics runs. Bounded per channel.

const CAP = 2000 // lines kept per channel

interface OutputState {
  channels: Record<string, string[]>
  version: number // bump to notify subscribers of in-place line pushes
  append: (channel: string, text: string) => void
  clear: (channel: string) => void
  ensure: (channel: string) => void
}

export const useOutput = create<OutputState>((set, get) => ({
  channels: {},
  version: 0,
  ensure: (channel) => {
    if (!get().channels[channel]) set((s) => ({ channels: { ...s.channels, [channel]: [] } }))
  },
  append: (channel, text) =>
    set((s) => {
      const prev = s.channels[channel] ?? []
      const lines = text.split('\n')
      const next = prev.concat(lines)
      if (next.length > CAP) next.splice(0, next.length - CAP)
      return { channels: { ...s.channels, [channel]: next }, version: s.version + 1 }
    }),
  clear: (channel) =>
    set((s) => ({ channels: { ...s.channels, [channel]: [] }, version: s.version + 1 }))
}))

export const LSP_CHANNEL = 'Language Server'

// Capture language-server log/notification traffic into the LSP channel. Runs once.
let wired = false
export function initOutputCapture(): void {
  if (wired) return
  wired = true
  try {
    window.api.lsp.onNotify(({ method, params }) => {
      if (method === 'window/logMessage' || method === 'window/showMessage') {
        const p = params as { message?: string; type?: number }
        if (p?.message) {
          const tag = ['', 'ERROR', 'WARN', 'INFO', 'LOG'][p.type ?? 4] ?? 'LOG'
          useOutput.getState().append(LSP_CHANNEL, `[${tag}] ${p.message}`)
        }
      }
    })
  } catch {
    /* lsp bridge unavailable */
  }
}
