import { createContext, useContext, type ReactNode } from 'react'
import type { Computer } from './computers'
import type { ComputerLink } from './useComputer'

// One live link per computer, shared by its screens (the agent list and a
// chat), so opening a chat does not open a second connection.
const Ctx = createContext<{ computer: Computer | null; link: ComputerLink; toast: string | null } | null>(null)

export function ComputerProvider({
  value,
  children
}: {
  value: { computer: Computer | null; link: ComputerLink; toast: string | null }
  children: ReactNode
}): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useComputerCtx(): { computer: Computer | null; link: ComputerLink; toast: string | null } {
  const v = useContext(Ctx)
  if (!v) throw new Error('useComputerCtx outside ComputerProvider')
  return v
}
