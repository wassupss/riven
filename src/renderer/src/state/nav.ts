import { create } from 'zustand'

// A pending "reveal this location" request (from search results / go-to). The
// editor consumes it once the target file is loaded.
interface NavState {
  reveal: { path: string; line: number; column: number } | null
  requestReveal: (path: string, line: number, column: number) => void
  clearReveal: () => void
}

export const useNav = create<NavState>((set) => ({
  reveal: null,
  requestReveal: (path, line, column) => set({ reveal: { path, line, column } }),
  clearReveal: () => set({ reveal: null })
}))
