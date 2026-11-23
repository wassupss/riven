import type { AgentStatus } from '@riven/remote'
import { C } from './theme'

// An agent's status, in words and colour: the agent list and the terminal list.
export const STATUS: Record<AgentStatus, { label: string; color: string }> = {
  busy: { label: '실행 중', color: C.accent },
  waiting: { label: '확인 필요', color: C.warn },
  done: { label: '완료', color: C.ok },
  idle: { label: '대기', color: C.dim }
}
