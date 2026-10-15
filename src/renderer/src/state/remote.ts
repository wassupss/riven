import { create } from 'zustand'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured, url as supabaseUrl } from '../lib/supabase'
import {
  INVITE_TTL_MS,
  PROTOCOL,
  ReplayGuard,
  channelName,
  clipHistory,
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
  type ChatInfo,
  type Choice,
  type DeskMsg,
  type HistoryItem,
  type PhoneMsg,
  type RemoteAgent,
  type RemoteJob
} from '../lib/remote/core'
import { claudeConfigDirFor, getSettings, useSettings, type RemoteDevice } from './settings'
import { loadPaneState, pathOf, useSession, workspaceName } from './session'
import { useRoster, rosterFor, workspaceOfPane } from './roster'
import { askChatTurn, listAgents, resolveAgent, useAgents, type AgentController } from './agents'
import { useAskUser } from './askUser'
import { useAuth } from './auth'
import { onTaskFinished, useChatWork, workCount, type LiveWork } from './chatWork'
import { nextRunOf, useJobs, type Job } from './jobs'
import { runJob } from './jobRunner'
import { claudeCatalog } from './modelCatalog'
import { modelLabel, modelsFor } from '../lib/models'
import { t } from '../i18n'

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

export type RemoteState = 'off' | 'unconfigured' | 'signed-out' | 'connecting' | 'online' | 'error'

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

/** The signed-in account, the only one whose phones may reach this machine. */
const ownerId = (): string => useAuth.getState().user?.id ?? ''

/**
 * Make sure this machine has its key pair and channel, for this account. A
 * different account than the one it was made for starts over, phones and all:
 * they were approved for that account, and its channel is not this one's.
 */
function ensureIdentity(owner: string): void {
  const s = getSettings()
  if (s.remoteChannel && s.remoteDeskPublic && s.remoteDeskSecret && s.remoteOwner === owner) return
  const k = newKeyPair()
  useSettings.getState().set({
    remoteChannel: randomId(),
    remoteDeskPublic: k.publicKey,
    remoteDeskSecret: k.secretKey,
    remoteOwner: owner,
    ...(s.remoteOwner && s.remoteOwner !== owner ? { remoteDevices: [] } : {})
  })
}

/** A fresh one-time invite and the QR text that carries it, or null if remote is unavailable. */
export function newInvite(): string | null {
  const owner = ownerId()
  if (!supabaseUrl || !owner) return null
  ensureIdentity(owner)
  const s = getSettings()
  const invite = { code: randomId(), expiresAt: Date.now() + INVITE_TTL_MS }
  setStore({ invite })
  return offerToUrl({
    v: PROTOCOL,
    channel: s.remoteChannel,
    desk: s.remoteDeskPublic,
    invite: invite.code,
    url: supabaseUrl,
    owner,
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
    remoteOwner: ownerId(),
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
      out.push({
        id: r.id,
        wsId: ws,
        workspace: label,
        kind: r.kind,
        title: r.title,
        status: r.status,
        canSend: r.kind === 'chat',
        ...(r.kind === 'chat' && workCount(r.id) ? { work: workCount(r.id) } : {})
      })
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

/**
 * A chat's conversation so far, from the CLI's own transcript of its session:
 * what the phone shows when a chat is opened, including everything typed on
 * this machine. Nothing is kept on the phone between launches.
 */
async function sendHistory(d: RemoteDevice, chatKey: string): Promise<void> {
  const ws = workspaceOfPane(chatKey)
  const session = ws ? loadPaneState(ws, chatKey).session : null
  let items: HistoryItem[] = []
  if (ws && session) {
    try {
      const tr = await window.api.chat.sessionTranscript(pathOf(ws), session, claudeConfigDirFor(ws))
      items = tr.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.tools.length ? { tools: m.tools.length, toolList: m.tools } : {})
      }))
    } catch {
      /* no transcript (yet): an empty history */
    }
  }
  sendTo(d, { t: 'history', chatKey, items: clipHistory(items) })
}

// ---- chat settings -------------------------------------------------------------

// The chat pane's own three, in its own words.
const MODES = ['plan', 'acceptEdits', 'default'] as const
const modeLabel = (m: string): string => t(m === 'default' ? 'chat.mode.ask' : `chat.mode.${m}`)

/**
 * A chat's model, permission mode and the choices it has. From the pane itself
 * when it is mounted (its own pickers' lists, live labels); otherwise from what
 * the pane saved, which is what it will come back with. Looking does not mount.
 */
function chatInfo(chatKey: string): ChatInfo | null {
  const c = mounted(chatKey)
  if (c?.remote) return { chatKey, ...c.remote.info(), busy: c.isBusy() }
  const ws = workspaceOfPane(chatKey)
  if (!ws) return null
  const pane = loadPaneState(ws, chatKey)
  const st = getSettings()
  const cli = pane.cli === 'codex' ? 'codex' : 'claude'
  const catalog = cli === 'codex' ? null : claudeCatalog(claudeConfigDirFor(ws))
  return {
    chatKey,
    cli,
    model: pane.model || st.defaultChatModel || 'default',
    mode: pane.mode || st.defaultPermissionMode || 'acceptEdits',
    models: modelsFor(cli).map((v) => ({ value: v, label: cli === 'codex' ? v : modelLabel(v, catalog) })),
    modes: MODES.map((value) => ({ value, label: modeLabel(value) })),
    busy: !!useRoster.getState().live[chatKey]?.busy
  }
}

function sendChatInfo(d: RemoteDevice, chatKey: string): void {
  const info = chatInfo(chatKey)
  if (info) sendTo(d, { t: 'chatInfo', info })
}

/** Change a chat the way its own pickers would, if what was asked is one of their choices. */
async function chatAction(d: RemoteDevice, m: Extract<PhoneMsg, { t: 'setModel' | 'setMode' | 'stop' }>): Promise<void> {
  const c = await controllerFor(m.chatKey)
  const ctl = c?.remote
  if (!c || !ctl) return sendTo(d, { t: 'ack', reqId: m.reqId, ok: false, error: 'not-open' })
  const info = ctl.info()
  if (m.t === 'setModel') {
    if (!info.models.some((x) => x.value === m.model))
      return sendTo(d, { t: 'ack', reqId: m.reqId, ok: false, error: 'bad-model' })
    ctl.setModel(m.model)
  } else if (m.t === 'setMode') {
    if (!info.modes.some((x) => x.value === m.mode))
      return sendTo(d, { t: 'ack', reqId: m.reqId, ok: false, error: 'bad-mode' })
    ctl.setMode(m.mode)
  } else ctl.stop()
  sendTo(d, { t: 'ack', reqId: m.reqId, ok: true })
  // The pane re-renders with the change; read it back after that.
  setTimeout(() => sendChatInfo(d, m.chatKey), 300)
}

// ---- live work -----------------------------------------------------------------

/** The chat each phone has open: it is sent that chat's work as it changes. */
const watching = new Map<string, string>()
const lastWork = new Map<string, string>()
const EMPTY_WORK: LiveWork = { bg: [], agents: [], delegations: [] }
// Subagents report every step; a phone does not need each one.
const WORK_DEBOUNCE_MS = 1_500

function sendWork(d: RemoteDevice, force = false): void {
  const chatKey = watching.get(d.id)
  if (!chatKey) return
  const work = useChatWork.getState().byChat[chatKey] ?? EMPTY_WORK
  const json = JSON.stringify(work)
  if (!force && lastWork.get(d.id) === `${chatKey}:${json}`) return
  lastWork.set(d.id, `${chatKey}:${json}`)
  sendTo(d, { t: 'work', chatKey, now: Date.now(), work })
}

let workTimer: ReturnType<typeof setTimeout> | null = null
function pushWork(): void {
  if (!watching.size) return
  if (workTimer) return
  workTimer = setTimeout(() => {
    workTimer = null
    const present = new Set(useRemote.getState().present)
    for (const d of getSettings().remoteDevices) if (present.has(d.id)) sendWork(d)
  }, WORK_DEBOUNCE_MS)
}

function watch(d: RemoteDevice, chatKey: string | null): void {
  if (chatKey) {
    watching.set(d.id, chatKey)
    sendWork(d, true)
  } else watching.delete(d.id)
}

// ---- scheduled jobs ------------------------------------------------------------

/** Phones that have the job list open this session: they get it again when it changes. */
const jobWatchers = new Set<string>()
const PROMPT_PREVIEW = 1_000

function jobsMsg(): DeskMsg {
  const { openWorkspaces, names } = useSession.getState()
  const by = useJobs.getState().byWorkspace
  const ids = [...new Set([...openWorkspaces, ...Object.keys(by).filter((w) => by[w]?.length)])]
  const now = Date.now()
  const jobs: RemoteJob[] = []
  for (const ws of ids)
    for (const j of by[ws] ?? []) {
      const last = j.runs[j.runs.length - 1]
      jobs.push({
        id: j.id,
        workspace: ws,
        name: j.name,
        prompt: j.prompt.length > PROMPT_PREVIEW ? j.prompt.slice(0, PROMPT_PREVIEW) + '…' : j.prompt,
        trigger: j.trigger,
        target: j.target,
        enabled: j.enabled,
        next: j.enabled ? nextRunOf(j, now) : null,
        ...(last ? { last: { at: last.at, status: last.status, ...(last.note ? { note: last.note } : {}) } } : {})
      })
    }
  const catalog = claudeCatalog()
  const models: Choice[] = modelsFor('claude').map((v) => ({ value: v, label: modelLabel(v, catalog) }))
  return {
    t: 'jobs',
    workspaces: openWorkspaces.map((id) => ({ value: id, label: workspaceName(id, names) })),
    jobs,
    models
  }
}

function sendJobs(d: RemoteDevice): void {
  jobWatchers.add(d.id)
  sendTo(d, jobsMsg())
}

let jobsTimer: ReturnType<typeof setTimeout> | null = null
function pushJobs(): void {
  if (!jobWatchers.size) return
  if (jobsTimer) clearTimeout(jobsTimer)
  jobsTimer = setTimeout(() => {
    jobsTimer = null
    const present = new Set(useRemote.getState().present)
    const msg = jobsMsg()
    for (const d of getSettings().remoteDevices) if (jobWatchers.has(d.id) && present.has(d.id)) sendTo(d, msg)
  }, 600)
}

const findJob = (id: string): { ws: string; job: Job } | null => {
  for (const [ws, list] of Object.entries(useJobs.getState().byWorkspace)) {
    const job = list.find((j) => j.id === id)
    if (job) return { ws, job }
  }
  return null
}

function jobAction(d: RemoteDevice, m: Extract<PhoneMsg, { t: 'jobSet' | 'jobRun' | 'jobDelete' | 'jobAdd' }>): void {
  const store = useJobs.getState()
  const ack = (ok: boolean, error?: string): void =>
    sendTo(d, { t: 'ack', reqId: m.reqId, ok, ...(error ? { error } : {}) })
  if (m.t === 'jobAdd') {
    const { workspace, name, prompt, trigger, target } = m.job
    // Only into a workspace that is open here, and only at a chat that is in it.
    if (!useSession.getState().openWorkspaces.includes(workspace)) return ack(false, 'no-workspace')
    if (target.kind === 'pane' && workspaceOfPane(target.chatKey) !== workspace) return ack(false, 'no-chat')
    if (target.kind === 'new' && target.model && !modelsFor(target.cli).includes(target.model))
      return ack(false, 'bad-model')
    store.add(workspace, { name, prompt, trigger, target, enabled: true, graceMinutes: 60 })
    ack(true)
  } else {
    const hit = findJob(m.id)
    if (!hit) return ack(false, 'no-job')
    if (m.t === 'jobSet') store.update(hit.ws, m.id, { enabled: m.enabled })
    else if (m.t === 'jobDelete') store.remove(hit.ws, m.id)
    else {
      const result = runJob(hit.job)
      store.recordRun(hit.ws, m.id, { at: Date.now(), ...result })
      if (result.status === 'failed') return ack(false, result.note ?? 'failed')
    }
    ack(true)
  }
  // The store change goes out through pushJobs, to this phone among others.
  jobWatchers.add(d.id)
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
    case 'history':
      void sendHistory(d, m.chatKey)
      return
    case 'push':
      useSettings.getState().set({
        remoteDevices: getSettings().remoteDevices.map((x) => (x.id === d.id ? { ...x, pushToken: m.token } : x))
      })
      return
    case 'chatInfo':
      sendChatInfo(d, m.chatKey)
      return
    case 'watch':
      watch(d, m.chatKey)
      return
    case 'setModel':
    case 'setMode':
    case 'stop':
      void chatAction(d, m)
      return
    case 'jobs':
      sendJobs(d)
      return
    case 'jobSet':
    case 'jobRun':
    case 'jobDelete':
    case 'jobAdd':
      jobAction(d, m)
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

function connect(owner: string, id: string): () => void {
  const sb = supabase
  if (!sb) return () => {}
  setStore({ state: 'connecting', present: [] })
  sharedCache.clear()
  const guard = new ReplayGuard()
  // Private: Realtime checks the signed-in user against the RLS policy
  // (supabase/remote.sql) before letting this client on the channel at all.
  const ch = sb.channel(channelName(owner, id), {
    config: { private: true, broadcast: { self: false }, presence: { key: 'desk' } }
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
    for (const did of [...jobWatchers]) if (!present.includes(did)) jobWatchers.delete(did)
    for (const did of [...watching.keys()])
      if (!present.includes(did)) {
        watching.delete(did)
        lastWork.delete(did)
      }
    for (const did of present)
      if (!before.has(did)) {
        const d = getSettings().remoteDevices.find((x) => x.id === did)
        if (d) greet(d)
      }
  })
  // The session's token has to be on the socket before a private channel is
  // asked for, or Realtime sees an anonymous client and refuses it.
  void sb.realtime.setAuth().then(() => {
    if (channel !== ch) return
    ch.subscribe((status) => {
      if (channel !== ch) return
      if (status === 'SUBSCRIBED') {
        setStore({ state: 'online' })
        void ch.track({ role: 'desk' })
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setStore({ state: 'error' })
    })
  })

  const offs = [
    useRoster.subscribe(() => pushRoster()),
    useAgents.subscribe(() => pushRoster()),
    useAskUser.subscribe(() => pushAsks()),
    useJobs.subscribe(() => pushJobs()),
    useChatWork.subscribe(() => {
      pushWork()
      pushRoster()
    }),
    // Ended while nobody was looking at that chat, likely: every phone hears it.
    onTaskFinished((f) =>
      broadcast({
        t: 'taskDone',
        chatKey: f.chatKey,
        title: resolveAgent(f.chatKey)?.getTitle() ?? '',
        label: f.label,
        outcome: f.outcome,
        ...(f.durationMs ? { durationMs: f.durationMs } : {})
      })
    )
  ]
  return () => {
    offs.forEach((f) => f())
    if (channel === ch) channel = null
    void sb.removeChannel(ch)
    lastRoster = ''
    lastStatus.clear()
    sentAsks.clear()
    jobWatchers.clear()
    watching.clear()
    lastWork.clear()
  }
}

/** Call once at startup: follows the remote settings for the life of the window. */
export function startRemote(): () => void {
  let current = ''
  let stop: () => void = () => {}
  const apply = (): void => {
    // Signed in or nothing: the relay admits only an account's own channels,
    // so without one there is nothing to connect to.
    const owner = ownerId()
    if (getSettings().remoteEnabled && owner) ensureIdentity(owner)
    const now = getSettings()
    const want =
      now.remoteEnabled && isSupabaseConfigured && owner ? `${owner}:${now.remoteChannel}:${now.remoteDeskPublic}` : ''
    // A device list change needs no reconnect, only fresh per-device keys.
    sharedCache.clear()
    // Not connecting still has to say why. At startup want and current are
    // both '', so returning early here left the store at 'off' for a signed-out
    // user with remote on: the QR button stayed live and did nothing.
    const idle: RemoteState | null = want
      ? null
      : !now.remoteEnabled
        ? 'off'
        : !isSupabaseConfigured
          ? 'unconfigured'
          : 'signed-out'
    if (want === current) {
      if (idle && useRemote.getState().state !== idle) setStore({ state: idle, present: [], invite: null, pending: null })
      return
    }
    current = want
    stop()
    stop = () => {}
    if (idle) setStore({ state: idle, present: [], invite: null, pending: null })
    else stop = connect(owner, now.remoteChannel)
    try {
      window.api.power.remote(!!want)
    } catch {
      /* an older preload has no remote bridge */
    }
  }
  apply()
  const offs = [useSettings.subscribe(apply), useAuth.subscribe(apply)]
  return () => {
    offs.forEach((f) => f())
    stop()
  }
}
