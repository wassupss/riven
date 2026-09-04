import { create } from 'zustand'

// A URL handed to the API client panel (e.g. from a port chip). The panel picks it
// up on mount/update and loads it into its address field.
interface ApiTargetState {
  url: string | null
  setUrl: (url: string | null) => void
}

export const useApiTarget = create<ApiTargetState>((set) => ({
  url: null,
  setUrl: (url) => set({ url })
}))
