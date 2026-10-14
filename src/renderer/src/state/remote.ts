import { create } from 'zustand'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { importRemoteKey, newChannelId, newRemoteKey, open, seal, ReplayGuard } from '../lib/remoteCrypto'
import { clipReply, parsePhoneMsg, type DeskMsg, type PhoneMsg, type RemoteAgent } from '../lib/remoteProtocol'
import { getSettings, useSettings } from './settings'
import { useSession, workspaceName } from './session'
import { useRoster, rosterFor, workspaceOfPane } from './roster'
import { askChatTurn, listAgents, resolveAgent, useAgents, type AgentController } from './agents'
import { useAskUser } from './askUser'

// Remote control: a phone drives this machine's agents through a relay.
//
// The relay is a Supabase Realtime channel whose name is an unguessable id, and
// everything on it is sealed end to end with a key the phone got from a QR code
// (lib/remoteCrypto): Supabase only ever carries ciphertext. This window is the
// hub because it already holds everything the phone needs: the roster, titles,
// the ask_user queue and the send path that puts a message in a chat pane the
// same way typing it would.
//
// Free-tier Realtime counts every message, so nothing streams: while no phone
// is present nothing is sent at all, and while one is, only state CHANGES go
// out (the roster, debounced), plus a chat's reply once its turn is over.

export type RemoteState = 'off' | 'unconfigured' | 'connecting' | 'online' | 'error'

interface RemoteStore {
  state: RemoteState
  phones: number
}
export const useRemote = create<RemoteStore>(() => ({ state: 'off', phones: 0 }))
const setState = (p: Partial<RemoteStore>): void => useRemote.setState(p)

const ROSTER_DEBOUNCE_MS = 500
// A message sent from the phone waits as long as the agent keeps working; it
// gives up only after this long of silence (see askChatTurn).
const REPLY_QUIET_MS = 30 * 60_000

/** Make sure this machine has a pairing (channel + key); returns it. */
export function ensurePairing(): { channel: string; key: string } {
  const s = getSettings()
  if (s.remoteChannel && s.remoteKey) return { channel: s.remoteChannel, key: s.remoteKey }
  const pair = { channel: newChannelId(), key: newRemoteKey() }
  useSettings.getState().set({ remoteChannel: pair.channel, remoteKey: pair.key })
  return pair
}

/** Forget every paired phone: a new channel and key, so the old QR stops working. */
export function rePair(): void {
  useSettings.getState().set({ remoteChannel: newChannelId(), remoteKey: newRemoteKey() })
}

function snapshot(): RemoteAgent[] {
  const { openWorkspaces, names } = useSession.getState()
  const out: RemoteAgent[] = []
  for (const ws of openWorkspaces) {
    const label = workspaceName(ws, names)
    for (const r of rosterFor(ws))
      out.push({ id: r.id, workspace: label, kind: r.kind, title: r.title, status: r.status, canSend: r.kind === 'chat' })
  }
  return out
}

interface Link {
  channel: RealtimeChannel
  id: string
  key: CryptoKey
  guard: ReplayGuard
  stop: () => void
}
let link: Link | null = null

async function send(msg: DeskMsg): Promise<void> {
  const l = link
  if (!l || useRemote.getState().phones === 0) return
  const env = await seal(l.key, l.id, { ...msg, from: 'desk' })
  if (link !== l) return
  void l.channel.send({ type: 'broadcast', event: 'm', payload: env })
}

// ---- outgoing state ----------------------------------------------------------

let lastRoster = ''
let rosterTimer: ReturnType<typeof setTimeout> | null = null
const lastStatus = new Map<string, string>()

function pushRoster(force = false): void {
  if (rosterTimer) clearTimeout(rosterTimer)
  rosterTimer = setTimeout(() => {
    rosterTimer = null
    const agents = snapshot()
    // What finished or started waiting since last time is worth a notification.
    for (const a of agents) {
      const prev = lastStatus.get(a.id)
      if (prev && prev !== a.status && (a.status === 'done' || a.status === 'waiting'))
        void send({ t: 'event', kind: a.status === 'done' ? 'done' : 'attention', id: a.id, title: a.title })
      lastStatus.set(a.id, a.status)
    }
    const json = JSON.stringify(agents)
    if (!force && json === lastRoster) return
    lastRoster = json
    void send({ t: 'roster', agents })
  }, force ? 0 : ROSTER_DEBOUNCE_MS)
}

const sentAsks = new Set<string>()
function pushAsks(all = false): void {
  const live = useAskUser.getState().pending.filter((r) => !r.expired)
  const ids = new Set(live.map((r) => r.id))
  for (const r of live) {
    if (!all && sentAsks.has(r.id)) continue
    sentAsks.add(r.id)
    const title = r.chatKey ? resolveAgent(r.chatKey)?.getTitle() ?? '' : ''
    void send({ t: 'ask', id: r.id, title, question: r.question, options: r.options })
  }
  for (const id of [...sentAsks])
    if (!ids.has(id)) {
      sentAsks.delete(id)
      void send({ t: 'askGone', id })
    }
}

// ---- incoming ------------------------------------------------------------------

function handle(m: PhoneMsg): void {
  switch (m.t) {
    case 'hello':
      // A phone (re)joined: give it the whole picture once.
      lastRoster = ''
      pushRoster(true)
      pushAsks(true)
      return
    case 'answer':
      useAskUser.getState().answer(m.id, m.choice)
      return
    case 'send':
      void deliverFromPhone(m)
      return
  }
}

// Exact pane key only: resolveAgent's fuzzy title match must not decide where
// a remote command lands.
const mounted = (chatKey: string): AgentController | null =>
  listAgents().some((a) => a.id === chatKey) ? resolveAgent(chatKey) : null

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The pane's controller, mounting its workspace if need be. Only the few most
 * recent workspaces stay mounted (App's LRU), and a chat in any other has no
 * controller to take a message: from the phone, almost every agent looked
 * unreachable. Switching to its workspace mounts it, as clicking it would.
 */
async function controllerFor(chatKey: string): Promise<AgentController | null> {
  const now = mounted(chatKey)
  if (now) return now
  const ws = workspaceOfPane(chatKey)
  if (!ws) return null
  useSession.getState().setActiveWorkspace(ws)
  for (let i = 0; i < 40; i++) {
    await pause(250)
    const c = mounted(chatKey)
    if (c) return c
  }
  return null
}

async function deliverFromPhone(m: Extract<PhoneMsg, { t: 'send' }>): Promise<void> {
  const target = await controllerFor(m.chatKey)
  if (!target) {
    void send({ t: 'ack', reqId: m.reqId, ok: false, error: 'not-open' })
    return
  }
  void send({ t: 'ack', reqId: m.reqId, ok: true })
  const text = await askChatTurn(target, m.text, REPLY_QUIET_MS, '(no reply: the agent went quiet)')
  void send({ t: 'reply', reqId: m.reqId, chatKey: m.chatKey, text: clipReply(text) })
}

// ---- connection ----------------------------------------------------------------

async function connect(id: string, keyB64: string): Promise<void> {
  if (!supabase) return
  setState({ state: 'connecting', phones: 0 })
  const key = await importRemoteKey(keyB64)
  const guard = new ReplayGuard()
  const channel = supabase.channel(`riven-remote-${id}`, {
    config: { broadcast: { self: false }, presence: { key: 'desk' } }
  })
  const offs: Array<() => void> = []
  const l: Link = {
    channel,
    id,
    key,
    guard,
    stop: () => {
      offs.forEach((f) => f())
      void supabase?.removeChannel(channel)
    }
  }
  link = l

  channel.on('broadcast', { event: 'm' }, ({ payload }) => {
    void open(key, id, payload).then((raw) => {
      if (link !== l || !raw || raw.from !== 'phone' || !guard.accept(raw.ts, raw.n)) return
      const m = parsePhoneMsg(raw)
      if (m) handle(m)
    })
  })
  channel.on('presence', { event: 'sync' }, () => {
    const phones = Object.keys(channel.presenceState()).filter((k) => k.startsWith('phone')).length
    const before = useRemote.getState().phones
    setState({ phones })
    if (phones > 0 && before === 0) {
      lastRoster = ''
      pushRoster(true)
      pushAsks(true)
    }
  })
  channel.subscribe((status) => {
    if (link !== l) return
    if (status === 'SUBSCRIBED') {
      setState({ state: 'online' })
      void channel.track({ role: 'desk' })
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setState({ state: 'error' })
  })

  // State that changes while a phone watches.
  offs.push(useRoster.subscribe(() => pushRoster()))
  offs.push(useAgents.subscribe(() => pushRoster()))
  offs.push(useAskUser.subscribe(() => pushAsks()))
}

function disconnect(): void {
  link?.stop()
  link = null
  lastRoster = ''
  lastStatus.clear()
  sentAsks.clear()
}

/** Call once at startup: follows the remote settings for the life of the window. */
export function startRemote(): () => void {
  let current = ''
  const apply = (): void => {
    const s = getSettings()
    const want = s.remoteEnabled && s.remoteChannel && s.remoteKey ? `${s.remoteChannel}:${s.remoteKey}` : ''
    if (want === current) return
    current = want
    disconnect()
    if (!s.remoteEnabled) setState({ state: 'off', phones: 0 })
    else if (!isSupabaseConfigured) setState({ state: 'unconfigured', phones: 0 })
    else if (want) void connect(s.remoteChannel, s.remoteKey)
    try {
      window.api.power.remote(!!want && isSupabaseConfigured)
    } catch {
      /* an older preload has no remote bridge */
    }
  }
  apply()
  const off = useSettings.subscribe(apply)
  return () => {
    off()
    disconnect()
  }
}
