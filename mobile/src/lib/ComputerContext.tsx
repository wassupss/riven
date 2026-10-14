import { createContext, useContext, type ReactNode } from 'react'
import type { Computer } from './computers'
import type { ComputerLink } from './useComputer'

interface CtxValue {
  computer: Computer | null
  link: ComputerLink
  toast: string | null
  /** Show a short message over the computer's screens. */
  notify: (title: string, body?: string) => void
}

// One live link per computer, shared by its screens (the agent list and a
// chat), so opening a chat does not open a second connection.
const Ctx = createContext<CtxValue | null>(null)

export function ComputerProvider({ value, children }: { value: CtxValue; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useComputerCtx(): CtxValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useComputerCtx outside ComputerProvider')
  return v
}
