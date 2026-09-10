import { create } from 'zustand'

// Per-panel status dot shown on the dockview tab (next to the title). Terminals
// set 'busy' while an agent works and 'attn' when a background pane needs
// attention (bell / task done) — replacing the old blinking overlay chip.
// 'attn' = waiting on the user (a permission prompt). 'done' = a turn finished
// and nobody has looked yet. Collapsing those two into one dot meant a finished
// CLI looked like it still wanted something.
export type TabBadge = 'busy' | 'attn' | 'done' | null

interface TabBadgeState {
  badges: Record<string, TabBadge>
  set: (panelId: string, badge: TabBadge) => void
}

export const useTabBadge = create<TabBadgeState>((set) => ({
  badges: {},
  set: (panelId, badge) =>
    set((s) => {
      if (s.badges[panelId] === badge) return s
      const next = { ...s.badges }
      if (badge) next[panelId] = badge
      else delete next[panelId]
      return { badges: next }
    })
}))
