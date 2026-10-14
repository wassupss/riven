import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { RealtimeChannel } from '@supabase/supabase-js'
import {
  ReplayGuard,
  isWire,
  openWire,
  randomId,
  seal,
  sharedKey,
  type DeskMsg,
  type PhoneMsg,
  type RemoteAgent
} from '@riven/remote'
import { closeChannel, openChannel } from './relay'
import type { Computer } from './computers'

// The live link to one paired computer: who is there, its agents, the questions
// it is waiting on, and what this phone sent and got back.

export interface Ask {
  id: string
  title: string
  question: string
  options: string[]
}

export interface LogLine {
  who: 'me' | 'agent' | 'wait' | 'error'
  text: string
  reqId?: string
}

export type LinkState = 'connecting' | 'online' | 'relay-error' | 'revoked'

export interface ComputerLink {
  state: LinkState
  deskOnline: boolean
  agents: RemoteAgent[]
  asks: Ask[]
  logs: Record<string, LogLine[]>
  send: (chatKey: string, text: string) => void
  answer: (id: string, choice: string) => void
  setPushToken: (token: string | null) => void
}

export function useComputer(c: Computer | null, onEvent?: (title: string, body: string) => void): ComputerLink {
  const [state, setState] = useState<LinkState>('connecting')
  const [deskOnline, setDeskOnline] = useState(false)
  const [agents, setAgents] = useState<RemoteAgent[]>([])
  const [asks, setAsks] = useState<Ask[]>([])
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  const chRef = useRef<RealtimeChannel | null>(null)
  const sharedRef = useRef<Uint8Array | null>(null)
  const eventRef = useRef(onEvent)
  eventRef.current = onEvent

  const post = useCallback(
    (msg: PhoneMsg) => {
      const ch = chRef.current
      const shared = sharedRef.current
      if (!ch || !shared || !c) return
      void ch.send({ type: 'broadcast', event: 'm', payload: seal(shared, c.deviceId, { ...msg, from: 'phone' }) })
    },
    [c]
  )

  useEffect(() => {
    if (!c) return
    const shared = sharedKey(c.desk, c.keys.secretKey)
    sharedRef.current = shared
    const guard = new ReplayGuard()
    const ch = openChannel(c.url, c.anon, c.channel, `phone-${c.deviceId}`)
    chRef.current = ch
    setState('connecting')

    const settle = (reqId: string, line: LogLine): void =>
      setLogs((all) => {
        const next = { ...all }
        for (const key of Object.keys(next)) {
          const i = next[key].findIndex((x) => x.reqId === reqId && x.who === 'wait')
          if (i >= 0) {
            next[key] = next[key].map((x, j) => (j === i ? line : x))
            break
          }
        }
        return next
      })

    const receive = (m: Record<string, unknown>): void => {
      const msg = m as unknown as DeskMsg
      switch (msg.t) {
        case 'roster':
          setAgents(Array.isArray(msg.agents) ? msg.agents : [])
          break
        case 'ask':
          setAsks((a) => [...a.filter((x) => x.id !== msg.id), msg])
          eventRef.current?.('질문이 도착했어요', (msg.title ? msg.title + ': ' : '') + msg.question)
          break
        case 'askGone':
          setAsks((a) => a.filter((x) => x.id !== msg.id))
          break
        case 'ack':
          if (!msg.ok) settle(msg.reqId, { who: 'error', text: '보내지 못했어요. 이 패널이 컴퓨터에서 닫혀 있어요.' })
          break
        case 'reply':
          settle(msg.reqId, { who: 'agent', text: msg.text })
          eventRef.current?.('답변이 도착했어요', '')
          break
        case 'event':
          eventRef.current?.(msg.kind === 'done' ? '작업이 끝났어요' : '확인이 필요해요', msg.title)
          break
        case 'revoked':
          setState('revoked')
          break
      }
    }

    ch.on('broadcast', { event: 'm' }, ({ payload }) => {
      if (!isWire(payload) || payload.d !== c.deviceId) return
      const m = openWire(shared, payload)
      if (!m || m.from !== 'desk' || !guard.accept(m.ts, payload.nonce)) return
      receive(m)
    })
    ch.on('presence', { event: 'sync' }, () => setDeskOnline(Object.keys(ch.presenceState()).includes('desk')))
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setState((s) => (s === 'revoked' ? s : 'online'))
        void ch.track({ role: 'phone' })
        post({ t: 'hello' })
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setState('relay-error')
    })

    // Back from the background: ask for the current picture again.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') post({ t: 'hello' })
    })
    return () => {
      sub.remove()
      chRef.current = null
      closeChannel(c.url, c.anon, ch)
    }
  }, [c, post])

  const send = useCallback(
    (chatKey: string, text: string) => {
      const reqId = randomId(9)
      setLogs((all) => ({
        ...all,
        [chatKey]: [...(all[chatKey] ?? []), { who: 'me' as const, text }, { who: 'wait' as const, text: '', reqId }].slice(-60)
      }))
      post({ t: 'send', reqId, chatKey, text })
    },
    [post]
  )

  const answer = useCallback(
    (id: string, choice: string) => {
      post({ t: 'answer', id, choice })
      setAsks((a) => a.filter((x) => x.id !== id))
    },
    [post]
  )

  const setPushToken = useCallback((token: string | null) => post({ t: 'push', token }), [post])

  return {
    state,
    deskOnline,
    agents,
    asks,
    logs,
    send,
    answer,
    setPushToken
  }
}
