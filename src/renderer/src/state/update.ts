import { create } from 'zustand'

// Update status mirrored from the main process (electron-updater). Drives the
// Settings → About panel and the status-bar "update ready" pill.
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'upToDate' }
  | { state: 'error'; message: string }

interface UpdateState {
  status: UpdateStatus
  version: string
  ready: boolean
  init: () => void
  check: () => void
  install: () => void
}

let started = false

export const useUpdate = create<UpdateState>((set, get) => ({
  status: { state: 'idle' },
  version: '',
  ready: false,
  init: () => {
    if (started) return
    started = true
    window.api.app.version().then((version) => set({ version, ready: true }))
    window.api.update.current().then((status) => set({ status }))
    window.api.update.onStatus((status) => set({ status }))
  },
  check: () => {
    set({ status: { state: 'checking' } })
    void window.api.update.check()
  },
  install: () => void window.api.update.install()
}))

// Convenience selector: an installable update is waiting.
export function updateReady(s: UpdateStatus): boolean {
  return s.state === 'downloaded'
}
