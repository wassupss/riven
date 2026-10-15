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
  type ChatInfo,
  type Choice,
  type DeskMsg,
  type NewJob,
  type PhoneMsg,
  type RemoteAgent,
  type RemoteJob,
  type RemoteWork
} from '@riven/remote'
import { closeChannel, joinChannel, openChannel } from './relay'
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
  tools?: number // tool calls the agent made in this message
  toolList?: Array<{ name: string; detail: string }>
}

export type LinkState = 'connecting' | 'online' | 'relay-error' | 'revoked'

/** A chat's live work, with how far the computer's clock is ahead of this one. */
export type ChatWork = RemoteWork & { offset: number }

export interface JobsView {
  workspaces: Choice[]
  jobs: RemoteJob[]
  models: Choice[]
}

/** What the computer said to a request: done, or why not. */
export type Ack = { ok: true } | { ok: false; error: string }

export interface ComputerLink {
  state: LinkState
  deskOnline: boolean
  agents: RemoteAgent[]
  asks: Ask[]
  logs: Record<string, LogLine[]>
  /** Chats whose history has arrived from the computer. */
  loaded: Record<string, boolean>
  send: (chatKey: string, text: string) => void
  /** Ask the computer for a chat's conversation so far. */
  loadHistory: (chatKey: string) => void
  answer: (id: string, choice: string) => void
  setPushToken: (token: string | null) => void
  /** Each chat's model and permission mode, once asked for. */
  chatInfo: Record<string, ChatInfo>
  loadChatInfo: (chatKey: string) => void
  setModel: (chatKey: string, model: string) => Promise<Ack>
  setMode: (chatKey: string, mode: string) => Promise<Ack>
  stop: (chatKey: string) => Promise<Ack>
  /** What the watched chat has running besides its turn. */
  work: Record<string, ChatWork>
  /** The chat on screen (null when none): its work is kept current while it is. */
  watch: (chatKey: string | null) => void
  /** The computer's scheduled jobs, once asked for (kept current after that). */
  jobs: JobsView | null
  loadJobs: () => void
  setJobEnabled: (id: string, enabled: boolean) => Promise<Ack>
  runJob: (id: string) => Promise<Ack>
  deleteJob: (id: string) => Promise<Ack>
  addJob: (job: NewJob) => Promise<Ack>
}

// A request the computer never answers (it went to sleep mid-way) gives up.
const ACK_TIMEOUT_MS = 20_000

type Req<T extends PhoneMsg['t']> = Omit<Extract<PhoneMsg, { t: T }>, 'reqId'>

export function useComputer(c: Computer | null, onEvent?: (title: string, body: string) => void): ComputerLink {
  const [state, setState] = useState<LinkState>('connecting')
  const [deskOnline, setDeskOnline] = useState(false)
  const [agents, setAgents] = useState<RemoteAgent[]>([])
  const [asks, setAsks] = useState<Ask[]>([])
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  // What the receiver reads to find which chat a reply belongs to.
  const logsRef = useRef(logs)
  useEffect(() => {
    logsRef.current = logs
  }, [logs])
  const [loaded, setLoaded] = useState<Record<string, boolean>>({})
  const [chatInfo, setChatInfo] = useState<Record<string, ChatInfo>>({})
  const [jobs, setJobs] = useState<JobsView | null>(null)
  const waiting = useRef(new Map<string, (a: Ack) => void>())
  const [work, setWork] = useState<Record<string, ChatWork>>({})
  const watchRef = useRef<string | null>(null)
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
    const ch = openChannel(c.owner, c.channel, `phone-${c.deviceId}`)
    if (!ch) {
      setState('relay-error')
      return
    }
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
        case 'ack': {
          const done = waiting.current.get(msg.reqId)
          if (done) {
            waiting.current.delete(msg.reqId)
            done(msg.ok ? { ok: true } : { ok: false, error: msg.error ?? 'failed' })
            break
          }
          if (!msg.ok) settle(msg.reqId, { who: 'error', text: '보내지 못했어요. 이 패널이 컴퓨터에서 닫혀 있어요.' })
          break
        }
        case 'reply': {
          // A reply carries only the final text. The turn as the computer's chat
          // shows it (each tool call, in order) is in the transcript, so the
          // chat's history is fetched again for it.
          const key = Object.keys(logsRef.current).find((k) =>
            logsRef.current[k].some((l) => l.reqId === msg.reqId)
          )
          settle(msg.reqId, { who: 'agent', text: msg.text })
          eventRef.current?.('답변이 도착했어요', '')
          if (key) post({ t: 'history', chatKey: key })
          break
        }
        case 'work':
          setWork((all) => ({
            ...all,
            [msg.chatKey]: { ...msg.work, offset: msg.now - Date.now() }
          }))
          break
        case 'taskDone': {
          const word = msg.outcome === 'done' ? '완료' : msg.outcome === 'stopped' ? '중지됨' : '실패'
          eventRef.current?.(`백그라운드 작업 ${word}`, [msg.title, msg.label].filter(Boolean).join(' · '))
          break
        }
        case 'event':
          eventRef.current?.(msg.kind === 'done' ? '작업이 끝났어요' : '확인이 필요해요', msg.title)
          break
        case 'history': {
          const lines: LogLine[] = (Array.isArray(msg.items) ? msg.items : []).map((h) => ({
            who: h.role === 'user' ? 'me' : 'agent',
            text: h.text,
            ...(h.tools ? { tools: h.tools } : {}),
            ...(h.toolList?.length ? { toolList: h.toolList } : {})
          }))
          // The conversation as the computer has it, plus anything sent from
          // here that is still waiting for its answer.
          setLogs((all) => ({
            ...all,
            [msg.chatKey]: [...lines, ...(all[msg.chatKey] ?? []).filter((l) => l.who === 'wait')]
          }))
          setLoaded((l) => ({ ...l, [msg.chatKey]: true }))
          break
        }
        case 'chatInfo':
          if (msg.info?.chatKey) setChatInfo((all) => ({ ...all, [msg.info.chatKey]: msg.info }))
          break
        case 'jobs':
          setJobs({
            workspaces: Array.isArray(msg.workspaces) ? msg.workspaces : [],
            jobs: Array.isArray(msg.jobs) ? msg.jobs : [],
            models: Array.isArray(msg.models) ? msg.models : []
          })
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
    joinChannel(ch, (status) => {
      if (status === 'SUBSCRIBED') {
        setState((s) => (s === 'revoked' ? s : 'online'))
        void ch.track({ role: 'phone' })
        post({ t: 'hello' })
        if (watchRef.current) post({ t: 'watch', chatKey: watchRef.current })
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setState('relay-error')
    })

    // Back from the background: ask for the current picture again.
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return
      post({ t: 'hello' })
      if (watchRef.current) post({ t: 'watch', chatKey: watchRef.current })
    })
    return () => {
      sub.remove()
      chRef.current = null
      closeChannel(ch)
      for (const done of waiting.current.values()) done({ ok: false, error: 'closed' })
      waiting.current.clear()
    }
  }, [c, post])

  const send = useCallback(
    (chatKey: string, text: string) => {
      const reqId = randomId(9)
      setLogs((all) => ({
        ...all,
        [chatKey]: [
          ...(all[chatKey] ?? []),
          { who: 'me' as const, text },
          { who: 'wait' as const, text: '', reqId }
          // As many as a history can bring (one per tool call), so sending does
          // not cut the conversation already on screen.
        ].slice(-240)
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

  const loadHistory = useCallback((chatKey: string) => post({ t: 'history', chatKey }), [post])

  const setPushToken = useCallback((token: string | null) => post({ t: 'push', token }), [post])

  /** Send a request and wait for the computer's ack to it. */
  const request = useCallback(
    <T extends PhoneMsg['t']>(msg: Req<T>): Promise<Ack> =>
      new Promise<Ack>((resolve) => {
        const reqId = randomId(9)
        const timer = setTimeout(() => {
          waiting.current.delete(reqId)
          resolve({ ok: false, error: 'timeout' })
        }, ACK_TIMEOUT_MS)
        waiting.current.set(reqId, (a) => {
          clearTimeout(timer)
          resolve(a)
        })
        post({ ...msg, reqId } as unknown as PhoneMsg)
      }),
    [post]
  )

  const loadChatInfo = useCallback((chatKey: string) => post({ t: 'chatInfo', chatKey }), [post])
  const setModel = useCallback(
    (chatKey: string, model: string) => request<'setModel'>({ t: 'setModel', chatKey, model }),
    [request]
  )
  const setMode = useCallback(
    (chatKey: string, mode: string) => request<'setMode'>({ t: 'setMode', chatKey, mode }),
    [request]
  )
  const stop = useCallback((chatKey: string) => request<'stop'>({ t: 'stop', chatKey }), [request])
  const loadJobs = useCallback(() => post({ t: 'jobs' }), [post])
  const watch = useCallback(
    (chatKey: string | null) => {
      watchRef.current = chatKey
      post({ t: 'watch', chatKey })
    },
    [post]
  )
  const setJobEnabled = useCallback(
    (id: string, enabled: boolean) => request<'jobSet'>({ t: 'jobSet', id, enabled }),
    [request]
  )
  const runJob = useCallback((id: string) => request<'jobRun'>({ t: 'jobRun', id }), [request])
  const deleteJob = useCallback((id: string) => request<'jobDelete'>({ t: 'jobDelete', id }), [request])
  const addJob = useCallback((job: NewJob) => request<'jobAdd'>({ t: 'jobAdd', job }), [request])

  return {
    state,
    deskOnline,
    agents,
    asks,
    logs,
    loaded,
    send,
    loadHistory,
    answer,
    setPushToken,
    chatInfo,
    loadChatInfo,
    setModel,
    setMode,
    stop,
    work,
    watch,
    jobs,
    loadJobs,
    setJobEnabled,
    runJob,
    deleteJob,
    addJob
  }
}
