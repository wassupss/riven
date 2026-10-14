import { create } from 'zustand'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured, url as supabaseUrl, anonKey } from '../lib/supabase'
import {
  INVITE_TTL_MS,
  PROTOCOL,
  ReplayGuard,
  channelName,
  clipReply,
  deviceIdOf,
  isWire,
  newKeyPair,
  offerToUrl,
  openPair,
  openWire,
  parsePhoneMsg,
  randomId,
  seal,
  sharedKey,
  type DeskMsg,
  type PhoneMsg,
  type RemoteAgent
} from '../lib/remote/core'
import { getSettings, useSettings, type RemoteDevice } from './settings'
import { useSession, workspaceName } from './session'
import { useRoster, rosterFor, workspaceOfPane } from './roster'
import { askChatTurn, listAgents, resolveAgent, useAgents, type AgentController } from './agents'
import { useAskUser } from './askUser'

// Remote control: the phone app (mobile/) drives this machine's agents through
// a relay. See lib/remote/core for the protocol and its security model; this
// file is the desktop end of it.
//
// This window is the hub because it already holds everything a phone needs:
// the roster, titles, the ask_user queue and the send path that puts a message
// in a chat pane the same way typing it would.
//
// Free-tier Realtime counts every message, so nothing streams: with no paired
// phone present nothing is sent at all, and while one is, only state CHANGES go
// out (the roster, debounced), plus a chat's reply once its turn is over.

export type RemoteState = 'off' | 'unconfigured' | 'connecting' | 'online' | 'error'

export interface PairPending {
  deviceId: string
  publicKey: string
  name: string
  platform: string
}

interface RemoteStore {
  state: RemoteState
  /** Paired devices present on the channel right now. */
  present: string[]
  /** The invite the QR code currently carries, if one is showing. */
  invite: { code: string; expiresAt: number } | null
  /** A phone asking to pair, waiting for the user's yes or no. */
  pending: PairPending | null
}
export const useRemote = create<RemoteStore>(() => ({ state: 'off', present: [], invite: null, pending: null }))
const setStore = (p: Partial<RemoteStore>): void => useRemote.setState(p)

const ROSTER_DEBOUNCE_MS = 500
// A message from the phone waits as long as the agent keeps working; it gives
// up only after this long of silence (see askChatTurn).
const REPLY_QUIET_MS = 30 * 60_000

let hostname = ''
void window.api.env
  .defaults()
  .then((d) => (hostname = d.hostname ?? ''))
  .catch(() => {})

// ---- pairing state -------------------------------------------------------------

/** Make sure this machine has its key pair and channel. */
function ensureIdentity(): void {
  const s = getSettings()
  if (s.remoteChannel && s.remoteDeskPublic && s.remoteDeskSecret) return
  const k = newKeyPair()
  useSettings.getState().set({ remoteChannel: randomId(), remoteDeskPublic: k.publicKey, remoteDeskSecret: k.secretKey })
}

/** A fresh one-time invite and the QR text that carries it, or null if remote is unavailable. */
export function newInvite(): string | null {
  ensureIdentity()
  const s = getSettings()
  if (!supabaseUrl || !anonKey) return null
  const invite = { code: randomId(), expiresAt: Date.now() + INVITE_TTL_MS }
  setStore({ invite })
  return offerToUrl({
    v: PROTOCOL,
    channel: s.remoteChannel,
    desk: s.remoteDeskPublic,
    invite: invite.code,
    url: supabaseUrl,
    anon: anonKey,
    name: hostname || 'riven'
  })
}

export function cancelInvite(): void {
  setStore({ invite: null })
}

/** The user's answer to a pairing request. */
export function decidePairing(allow: boolean): void {
  const p = useRemote.getState().pending
  if (!p) return
  setStore({ pending: null })
  const shared = sharedKey(p.publicKey, getSettings().remoteDeskSecret)
  if (allow) {
    const device: RemoteDevice = {
      id: p.deviceId,
      name: p.name || 'phone',
      platform: p.platform,
      publicKey: p.publicKey,
      addedAt: Date.now()
    }
    const others = getSettings().remoteDevices.filter((d) => d.id !== device.id)
    useSettings.getState().set({ remoteDevices: [...others, device] })
    rawSend(seal(shared, p.deviceId, { t: 'paired', name: hostname || 'riven', from: 'desk' }))
  } else {
    rawSend(seal(shared, p.deviceId, { t: 'denied', from: 'desk' }))
  }
}

/** Forget one phone. It is told, if it is listening, and nothing it sends is read again. */
export function revokeDevice(id: string): void {
  const d = getSettings().remoteDevices.find((x) => x.id === id)
  if (d) sendTo(d, { t: 'revoked' })
  useSettings.getState().set({ remoteDevices: getSettings().remoteDevices.filter((x) => x.id !== id) })
}

/** Forget every phone and this machine's identity: old QR codes and keys all stop working. */
export function resetRemote(): void {
  for (const d of getSettings().remoteDevices) sendTo(d, { t: 'revoked' })
  const k = newKeyPair()
  useSettings.getState().set({
    remoteChannel: randomId(),
    remoteDeskPublic: k.publicKey,
    remoteDeskSecret: k.secretKey,
    remoteDevices: []
  })
  setStore({ invite: null, pending: null })
}

// ---- wire ----------------------------------------------------------------------

let channel: RealtimeChannel | null = null
const sharedCache = new Map<string, Uint8Array>()

function sharedFor(d: RemoteDevice): Uint8Array {
  const hit = sharedCache.get(d.id)
  if (hit) return hit
  const k = sharedKey(d.publicKey, getSettings().remoteDeskSecret)
  sharedCache.set(d.id, k)
  return k
}

function rawSend(payload: unknown, event = 'm'): void {
  void channel?.send({ type: 'broadcast', event, payload })
}

function sendTo(d: RemoteDevice, msg: DeskMsg): void {
  rawSend(seal(sharedFor(d), d.id, { ...msg, from: 'desk' }))
}

/** To every paired phone that is listening. Nothing is sent to nobody. */
function broadcast(msg: DeskMsg): void {
  const present = new Set(useRemote.getState().present)
  for (const d of getSettings().remoteDevices) if (present.has(d.id)) sendTo(d, msg)
}

// ---- outgoing state ------------------------------------------------------------

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

let lastRoster = ''
let rosterTimer: ReturnType<typeof setTimeout> | null = null
const lastStatus = new Map<string, string>()

function pushRoster(): void {
  if (rosterTimer) clearTimeout(rosterTimer)
  rosterTimer = setTimeout(() => {
    rosterTimer = null
    const agents = snapshot()
    // What finished or started waiting since last time is worth an alert.
    for (const a of agents) {
      const prev = lastStatus.get(a.id)
      if (prev && prev !== a.status && (a.status === 'done' || a.status === 'waiting'))
        broadcast({ t: 'event', kind: a.status === 'done' ? 'done' : 'attention', id: a.id, title: a.title })
      lastStatus.set(a.id, a.status)
    }
    const json = JSON.stringify(agents)
    if (json === lastRoster) return
    lastRoster = json
    broadcast({ t: 'roster', agents })
  }, ROSTER_DEBOUNCE_MS)
}

const sentAsks = new Set<string>()
function pushAsks(to?: RemoteDevice): void {
  const live = useAskUser.getState().pending.filter((r) => !r.expired)
  const ids = new Set(live.map((r) => r.id))
  for (const r of live) {
    if (!to && sentAsks.has(r.id)) continue
    sentAsks.add(r.id)
    const title = r.chatKey ? (resolveAgent(r.chatKey)?.getTitle() ?? '') : ''
    const msg: DeskMsg = { t: 'ask', id: r.id, title, question: r.question, options: r.options }
    if (to) sendTo(to, msg)
    else broadcast(msg)
  }
  if (to) return
  for (const id of [...sentAsks])
    if (!ids.has(id)) {
      sentAsks.delete(id)
      broadcast({ t: 'askGone', id })
    }
}

/** Everything a phone needs to draw its screen, sent to that phone. */
function greet(d: RemoteDevice): void {
  sendTo(d, { t: 'roster', agents: snapshot() })
  pushAsks(d)
}

// ---- incoming ------------------------------------------------------------------

// Exact pane key only: resolveAgent's fuzzy title match must not decide where a
// remote command lands.
const mounted = (chatKey: string): AgentController | null =>
  listAgents().some((a) => a.id === chatKey) ? resolveAgent(chatKey) : null

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The pane's controller, mounting its workspace if need be. Only the few most
 * recent workspaces stay mounted (App's LRU), and a chat in any other has no
 * controller to take a message. Switching to its workspace mounts it, as
 * clicking it would.
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

async function deliverFromPhone(d: RemoteDevice, m: Extract<PhoneMsg, { t: 'send' }>): Promise<void> {
  const target = await controllerFor(m.chatKey)
  if (!target) {
    sendTo(d, { t: 'ack', reqId: m.reqId, ok: false, error: 'not-open' })
    return
  }
  sendTo(d, { t: 'ack', reqId: m.reqId, ok: true })
  const text = await askChatTurn(target, m.text, REPLY_QUIET_MS, '(no reply: the agent went quiet)')
  // Re-read the device: it may have been unpaired while the agent worked.
  const still = getSettings().remoteDevices.find((x) => x.id === d.id)
  if (still) sendTo(still, { t: 'reply', reqId: m.reqId, chatKey: m.chatKey, text: clipReply(text) })
}

function handle(d: RemoteDevice, m: PhoneMsg): void {
  switch (m.t) {
    case 'hello':
      greet(d)
      return
    case 'answer':
      useAskUser.getState().answer(m.id, m.choice)
      return
    case 'send':
      void deliverFromPhone(d, m)
      return
    case 'push':
      useSettings.getState().set({
        remoteDevices: getSettings().remoteDevices.map((x) => (x.id === d.id ? { ...x, pushToken: m.token } : x))
      })
      return
  }
}

function onPairRequest(payload: unknown, guard: ReplayGuard): void {
  const { invite, pending } = useRemote.getState()
  // One request per invite, one prompt at a time.
  if (!invite || pending || Date.now() > invite.expiresAt) return
  const got = openPair(payload, getSettings().remoteDeskSecret)
  if (!got || got.req.invite !== invite.code) return
  if (!guard.accept(got.ts, (payload as { nonce: string }).nonce)) return
  // The invite is spent the moment it is used, approved or not.
  setStore({
    invite: null,
    pending: { deviceId: deviceIdOf(got.publicKey), publicKey: got.publicKey, name: got.req.name, platform: got.req.platform }
  })
}

// ---- connection ----------------------------------------------------------------

function connect(id: string): () => void {
  if (!supabase) return () => {}
  setStore({ state: 'connecting', present: [] })
  sharedCache.clear()
  const guard = new ReplayGuard()
  const ch = supabase.channel(channelName(id), {
    config: { broadcast: { self: false }, presence: { key: 'desk' } }
  })
  channel = ch

  ch.on('broadcast', { event: 'm' }, ({ payload }) => {
    if (!isWire(payload)) return
    const d = getSettings().remoteDevices.find((x) => x.id === payload.d)
    if (!d) return // not (or no longer) paired: not even opened
    const raw = openWire(sharedFor(d), payload)
    if (!raw || raw.from !== 'phone' || !guard.accept(raw.ts, payload.nonce)) return
    const m = parsePhoneMsg(raw)
    if (m) handle(d, m)
  })
  ch.on('broadcast', { event: 'pair' }, ({ payload }) => onPairRequest(payload, guard))
  ch.on('presence', { event: 'sync' }, () => {
    const known = new Set(getSettings().remoteDevices.map((d) => d.id))
    const present = Object.keys(ch.presenceState())
      .filter((k) => k.startsWith('phone-'))
      .map((k) => k.slice('phone-'.length))
      .filter((did) => known.has(did))
    const before = new Set(useRemote.getState().present)
    setStore({ present })
    for (const did of present)
      if (!before.has(did)) {
        const d = getSettings().remoteDevices.find((x) => x.id === did)
        if (d) greet(d)
      }
  })
  ch.subscribe((status) => {
    if (channel !== ch) return
    if (status === 'SUBSCRIBED') {
      setStore({ state: 'online' })
      void ch.track({ role: 'desk' })
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setStore({ state: 'error' })
  })

  const offs = [
    useRoster.subscribe(() => pushRoster()),
    useAgents.subscribe(() => pushRoster()),
    useAskUser.subscribe(() => pushAsks())
  ]
  return () => {
    offs.forEach((f) => f())
    if (channel === ch) channel = null
    void supabase?.removeChannel(ch)
    lastRoster = ''
    lastStatus.clear()
    sentAsks.clear()
  }
}

/** Call once at startup: follows the remote settings for the life of the window. */
export function startRemote(): () => void {
  let current = ''
  let stop: () => void = () => {}
  const apply = (): void => {
    const s = getSettings()
    if (s.remoteEnabled) ensureIdentity()
    const now = getSettings()
    const want = now.remoteEnabled && isSupabaseConfigured ? `${now.remoteChannel}:${now.remoteDeskPublic}` : ''
    // A device list change needs no reconnect, only fresh per-device keys.
    sharedCache.clear()
    if (want === current) return
    current = want
    stop()
    stop = () => {}
    if (!now.remoteEnabled) setStore({ state: 'off', present: [], invite: null, pending: null })
    else if (!isSupabaseConfigured) setStore({ state: 'unconfigured', present: [] })
    else stop = connect(now.remoteChannel)
    try {
      window.api.power.remote(!!want)
    } catch {
      /* an older preload has no remote bridge */
    }
  }
  apply()
  const off = useSettings.subscribe(apply)
  return () => {
    off()
    stop()
  }
}
