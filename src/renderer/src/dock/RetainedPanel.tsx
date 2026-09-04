import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DockviewPanelApi } from 'dockview-core'

// Hidden dock panels stay MOUNTED (so terminals/agents keep running), which means
// every store update they subscribe to still re-renders them even though nobody can
// see the result. With several workspaces × several panels that background work is
// a large share of idle CPU.
//
// This wrapper reports whether its panel is the visible tab of its group; panels
// use `useRetainedValue(value, active)` to FREEZE the inputs of expensive subtrees
// while hidden, so downstream memos keep their identity and React does no work.
// (Pattern from paseo's retained-panel / useRetainedValue.)

const RetainedActiveContext = createContext(true)

export function useRetainedActive(): boolean {
  return useContext(RetainedActiveContext)
}

// Returns `value` while active; while inactive returns the last value seen when it
// was active, so consumers see a stable reference and skip re-rendering.
export function useRetainedValue<T>(value: T, active: boolean): T {
  const held = useRef(value)
  if (active) held.current = value
  return active ? value : held.current
}

export function RetainedPanel({
  api,
  children
}: {
  api?: DockviewPanelApi
  children: ReactNode
}): JSX.Element {
  const [active, setActive] = useState(() => (api ? api.isVisible : true))
  useEffect(() => {
    if (!api) return
    setActive(api.isVisible)
    const subs = [
      api.onDidVisibilityChange(() => setActive(api.isVisible)),
      api.onDidActiveChange(() => setActive(api.isVisible))
    ]
    return () => subs.forEach((s) => s.dispose())
  }, [api])
  return <RetainedActiveContext.Provider value={active}>{children}</RetainedActiveContext.Provider>
}
