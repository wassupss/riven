// Remote control: the protocol both ends speak. Shared, file for file, by this
// app (state/remote.ts) and the phone app (mobile/), so it imports nothing but
// tweetnacl and uses nothing but what both runtimes have (atob/btoa, and
// randomness through tweetnacl's PRNG, which the phone app wires to expo-crypto).
//
// Shape of it:
// - This machine has a long-term X25519 key pair. Its public key and a one-time
//   invite (valid 10 minutes) go to the phone in the QR code.
// - The phone makes its own key pair and asks to pair, boxed to this machine's
//   key. The user approves it HERE; only then does the device exist. A leaked
//   QR or an expired invite is worth nothing without that approval.
// - From then on every message is a NaCl box between this machine and THAT
//   device (X25519 + XSalsa20-Poly1305), so devices are separately revocable and
//   none can read another's traffic. Supabase Realtime only relays ciphertext.
// - Each message carries its time and is accepted once (random 24-byte nonce),
//   so a captured message cannot be replayed later.
// - The relay itself is closed to anyone not signed in: channels are PRIVATE
//   Realtime channels named after the owner's account id, and the project's RLS
//   policy (supabase/remote.sql) lets a signed-in user join only their own. The
//   phone must be signed in to the same account as the computer to even reach
//   it; the keys above are what it then needs to be understood.

import nacl from 'tweetnacl'

export const PROTOCOL = 3
export const INVITE_TTL_MS = 10 * 60_000
export const REPLAY_WINDOW_MS = 3 * 60_000

// UTF-8 by hand: TextEncoder/TextDecoder are not something every React Native
// engine can be counted on to have, and this file runs in both.
export function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

export function fromUtf8(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; ) {
    const c = b[i++]
    let cp: number
    if (c < 0x80) cp = c
    else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63)
    else if (c < 0xf0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63)
    else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63)
    if (cp >= 0x10000) {
      cp -= 0x10000
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023))
    } else s += String.fromCharCode(cp)
  }
  return s
}

export function toB64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const randomId = (bytes = 16): string => toB64u(nacl.randomBytes(bytes))

export interface KeyPair {
  publicKey: string // base64url
  secretKey: string // base64url
}

export function newKeyPair(): KeyPair {
  const k = nacl.box.keyPair()
  return { publicKey: toB64u(k.publicKey), secretKey: toB64u(k.secretKey) }
}

/** A short, stable id for a device, derived from its public key. */
export const deviceIdOf = (publicKey: string): string => toB64u(nacl.hash(fromB64u(publicKey)).slice(0, 12))

/** The precomputed key for one pair of parties. */
export const sharedKey = (theirPublic: string, mySecret: string): Uint8Array =>
  nacl.box.before(fromB64u(theirPublic), fromB64u(mySecret))

// ---- pairing offer (the QR code) ---------------------------------------------

export interface PairingOffer {
  v: number
  channel: string // Realtime channel id
  desk: string // this machine's public key
  invite: string // one-time invite
  url: string // Supabase project URL
  owner: string // the account id the computer is signed in as
  name: string // this machine's display name
}

export const OFFER_SCHEME = 'rivenremote://pair?o='

export function offerToUrl(o: PairingOffer): string {
  return OFFER_SCHEME + toB64u(utf8(JSON.stringify(o)))
}

export function parseOffer(text: string): PairingOffer | null {
  try {
    const raw = text.startsWith(OFFER_SCHEME) ? text.slice(OFFER_SCHEME.length) : text
    const o = JSON.parse(fromUtf8(fromB64u(raw)))
    const ok =
      o?.v === PROTOCOL &&
      [o.channel, o.desk, o.invite, o.url, o.owner].every((x) => typeof x === 'string' && x.length > 0) &&
      /^https:\/\//.test(o.url)
    return ok ? { ...o, name: typeof o.name === 'string' ? o.name : '' } : null
  } catch {
    return null
  }
}

// ---- sealed messages -----------------------------------------------------------

/** On the wire: who it is for/from, and the box. */
export interface Wire {
  d: string // device id: the sender for phone → desk, the recipient for desk → phone
  nonce: string
  box: string
}

export function seal(shared: Uint8Array, deviceId: string, msg: object): Wire {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const body = utf8(JSON.stringify({ ...msg, ts: Date.now() }))
  return { d: deviceId, nonce: toB64u(nonce), box: toB64u(nacl.box.after(body, nonce, shared)) }
}

export function openWire(shared: Uint8Array, w: Wire): Record<string, unknown> | null {
  try {
    const pt = nacl.box.open.after(fromB64u(w.box), fromB64u(w.nonce), shared)
    if (!pt) return null
    const obj = JSON.parse(fromUtf8(pt))
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}

export function isWire(x: unknown): x is Wire {
  const w = x as Partial<Wire> | null
  return !!w && typeof w.d === 'string' && typeof w.nonce === 'string' && typeof w.box === 'string'
}

/** Accepts each nonce once, and only from messages inside the time window. */
export class ReplayGuard {
  private seen = new Map<string, number>()
  accept(ts: unknown, nonce: string, now = Date.now()): boolean {
    if (typeof ts !== 'number' || !nonce) return false
    if (Math.abs(now - ts) > REPLAY_WINDOW_MS) return false
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, ts)
    if (this.seen.size > 1000) for (const [k, t] of this.seen) if (now - t > REPLAY_WINDOW_MS) this.seen.delete(k)
    return true
  }
}

// ---- pairing request (phone → desk, before the device exists) -------------------

export interface PairRequest {
  invite: string
  name: string // e.g. "Galaxy S24"
  platform: string // 'android' | 'ios'
}

/** Boxed with the phone's fresh key to the desk's long-term key. */
export interface PairWire {
  pk: string // the phone's public key
  nonce: string
  box: string
}

export function sealPair(req: PairRequest, deskPublic: string, phone: KeyPair): PairWire {
  return { pk: phone.publicKey, ...seal(sharedKey(deskPublic, phone.secretKey), '', req) }
}

export function openPair(w: unknown, deskSecret: string): { publicKey: string; req: PairRequest; ts: unknown } | null {
  const p = w as Partial<PairWire> | null
  if (!p || typeof p.pk !== 'string' || typeof p.nonce !== 'string' || typeof p.box !== 'string') return null
  let shared: Uint8Array
  try {
    shared = sharedKey(p.pk, deskSecret)
  } catch {
    return null
  }
  const m = openWire(shared, { d: '', nonce: p.nonce, box: p.box })
  if (!m || typeof m.invite !== 'string') return null
  return {
    publicKey: p.pk,
    req: {
      invite: m.invite,
      name: typeof m.name === 'string' ? m.name.slice(0, 60) : '',
      platform: typeof m.platform === 'string' ? m.platform.slice(0, 20) : ''
    },
    ts: m.ts
  }
}

// ---- messages ------------------------------------------------------------------

export type AgentStatus = 'idle' | 'busy' | 'waiting' | 'done'

export interface RemoteAgent {
  id: string // pane key
  wsId: string // workspace id
  workspace: string // display name
  kind: 'chat' | 'terminal'
  title: string
  status: AgentStatus
  /** A chat pane: it can take a message (its workspace is opened if need be). */
  canSend: boolean
  /** Background commands, subagents and hand-offs it has running. */
  work?: number
}

/** What a chat has running besides its turn. Times are the computer's clock. */
export interface RemoteWork {
  bg: Array<{ id: string; label: string; since?: number }>
  agents: Array<{ id: string; label: string; since: number; steps: number; lastActivityAt: number }>
  delegations: Array<{ id: string; label: string; since: number }>
}

/** One choice in a picker: what is sent, and what the user reads. */
export interface Choice {
  value: string
  label: string
}

/** A chat's settings, as its own pickers on the computer show them. */
export interface ChatInfo {
  chatKey: string
  cli: string
  model: string
  mode: string
  /** Every model this chat may be switched to; nothing else is accepted. */
  models: Choice[]
  modes: Choice[]
  busy: boolean
}

/** When a scheduled job runs. The same shape as the computer's own (lib/schedule). */
export type RemoteTrigger =
  | { kind: 'once'; at: number }
  | { kind: 'every'; minutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }

export type RemoteJobTarget =
  | { kind: 'pane'; chatKey: string; title: string }
  | { kind: 'new'; cli: 'claude' | 'codex'; model?: string }

export interface RemoteJob {
  id: string
  workspace: string // workspace id
  name: string
  prompt: string
  trigger: RemoteTrigger
  target: RemoteJobTarget
  enabled: boolean
  /** When it fires next, as the computer's clock reckons it. */
  next: number | null
  last?: { at: number; status: 'ok' | 'failed' | 'missed'; note?: string }
}

/** How full one plan window is, as the provider reports it. */
export interface RemoteLimit {
  usedPct: number
  resetsAt: string | null
}

/** One account's usage, as the computer's own usage readout shows it. */
export interface RemoteUsage {
  id: string
  cli: 'claude' | 'codex'
  label: string
  todayTokens: number
  /** API-rate cost of today's tokens (Claude only; Codex logs no prices). */
  todayCost: number | null
  /** The short window (Claude: 5 hours). */
  session: RemoteLimit | null
  /** The long window (Claude: 7 days; Codex: its plan window). */
  weekly: RemoteLimit | null
  /** Length of the long window in days, when it is not a week. */
  windowDays?: number
  /** The provider did not answer; these are the last figures it gave. */
  stale?: boolean
}

/** A job made on the phone: everything but what the computer fills in. */
export interface NewJob {
  workspace: string
  name: string
  prompt: string
  trigger: RemoteTrigger
  target: RemoteJobTarget
}

/** Desk → phone. */
export type DeskMsg =
  | { t: 'paired'; name: string }
  | { t: 'denied' }
  | { t: 'revoked' }
  | { t: 'roster'; agents: RemoteAgent[] }
  | { t: 'ask'; id: string; title: string; question: string; options: string[] }
  | { t: 'askGone'; id: string }
  | { t: 'ack'; reqId: string; ok: boolean; error?: string }
  | { t: 'reply'; reqId: string; chatKey: string; text: string }
  | { t: 'event'; kind: 'done' | 'attention'; id: string; title: string }
  | { t: 'history'; chatKey: string; items: HistoryItem[] }
  | { t: 'chatInfo'; info: ChatInfo }
  | { t: 'jobs'; workspaces: Choice[]; jobs: RemoteJob[]; models: Choice[] }
  | { t: 'usage'; accounts: RemoteUsage[]; at: number }
  /** `now` is the computer's clock, so the phone can show durations without trusting its own. */
  | { t: 'work'; chatKey: string; now: number; work: RemoteWork }
  | {
      t: 'taskDone'
      chatKey: string
      title: string
      label: string
      outcome: 'done' | 'stopped' | 'failed'
      durationMs?: number
    }

/**
 * Phone → desk. This list IS what a phone may do: there is no message for
 * anything else (API keys, MCP servers, tools, settings at large), so no
 * phone, however compromised, can ask for it.
 */
export type PhoneMsg =
  | { t: 'hello' }
  | { t: 'send'; reqId: string; chatKey: string; text: string }
  | { t: 'answer'; id: string; choice: string }
  | { t: 'push'; token: string | null }
  | { t: 'history'; chatKey: string }
  | { t: 'chatInfo'; chatKey: string }
  /** The chat this phone has open (null: none). Its live work is sent while it is. */
  | { t: 'watch'; chatKey: string | null }
  | { t: 'setModel'; reqId: string; chatKey: string; model: string }
  | { t: 'setMode'; reqId: string; chatKey: string; mode: string }
  | { t: 'stop'; reqId: string; chatKey: string }
  | { t: 'jobs' }
  | { t: 'usage' }
  | { t: 'jobSet'; reqId: string; id: string; enabled: boolean }
  | { t: 'jobRun'; reqId: string; id: string }
  | { t: 'jobDelete'; reqId: string; id: string }
  | { t: 'jobAdd'; reqId: string; job: NewJob }

export const MAX_TEXT = 20_000
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** A trigger from a phone, or null if it is not one the computer could run. */
export function parseTrigger(v: unknown): RemoteTrigger | null {
  const t = v as Record<string, unknown> | null
  if (!t || typeof t !== 'object') return null
  switch (t.kind) {
    case 'once':
      return int(t.at, 1, 8_640_000_000_000_000) ? { kind: 'once', at: t.at } : null
    case 'every':
      return int(t.minutes, 1, 7 * 24 * 60) ? { kind: 'every', minutes: t.minutes } : null
    case 'hourly':
      return int(t.minute, 0, 59) ? { kind: 'hourly', minute: t.minute } : null
    case 'daily':
    case 'weekdays':
      return int(t.hour, 0, 23) && int(t.minute, 0, 59) ? { kind: t.kind, hour: t.hour, minute: t.minute } : null
    case 'weekly':
      return int(t.day, 0, 6) && int(t.hour, 0, 23) && int(t.minute, 0, 59)
        ? { kind: 'weekly', day: t.day, hour: t.hour, minute: t.minute }
        : null
    default:
      return null
  }
}

function parseTarget(v: unknown): RemoteJobTarget | null {
  const t = v as Record<string, unknown> | null
  if (!t || typeof t !== 'object') return null
  if (t.kind === 'pane')
    return str(t.chatKey, 200) && typeof t.title === 'string' && t.title.length <= 200
      ? { kind: 'pane', chatKey: t.chatKey, title: t.title }
      : null
  if (t.kind === 'new' && (t.cli === 'claude' || t.cli === 'codex'))
    return t.model === undefined || str(t.model, 100)
      ? { kind: 'new', cli: t.cli, ...(t.model ? { model: t.model as string } : {}) }
      : null
  return null
}

function parseNewJob(v: unknown): NewJob | null {
  const j = v as Record<string, unknown> | null
  if (!j || typeof j !== 'object') return null
  const trigger = parseTrigger(j.trigger)
  const target = parseTarget(j.target)
  if (!trigger || !target || !str(j.workspace, 1000) || !str(j.name, 100) || !str(j.prompt, MAX_TEXT)) return null
  if (!j.prompt.trim()) return null
  return { workspace: j.workspace, name: j.name, prompt: j.prompt, trigger, target }
}

/** Validate what arrived from a phone. Anything malformed is dropped. */
export function parsePhoneMsg(m: Record<string, unknown> | null): PhoneMsg | null {
  if (!m) return null
  switch (m.t) {
    case 'hello':
      return { t: 'hello' }
    case 'send':
      return str(m.reqId, 64) && str(m.chatKey, 200) && str(m.text, MAX_TEXT) && m.text.trim()
        ? { t: 'send', reqId: m.reqId, chatKey: m.chatKey, text: m.text }
        : null
    case 'answer':
      return str(m.id, 200) && str(m.choice, MAX_TEXT) ? { t: 'answer', id: m.id, choice: m.choice } : null
    case 'history':
      return str(m.chatKey, 200) ? { t: 'history', chatKey: m.chatKey } : null
    case 'push':
      return m.token === null || str(m.token, 300) ? { t: 'push', token: m.token as string | null } : null
    case 'chatInfo':
      return str(m.chatKey, 200) ? { t: 'chatInfo', chatKey: m.chatKey } : null
    case 'watch':
      return m.chatKey === null || str(m.chatKey, 200) ? { t: 'watch', chatKey: m.chatKey as string | null } : null
    case 'setModel':
      return str(m.reqId, 64) && str(m.chatKey, 200) && str(m.model, 100)
        ? { t: 'setModel', reqId: m.reqId, chatKey: m.chatKey, model: m.model }
        : null
    case 'setMode':
      return str(m.reqId, 64) && str(m.chatKey, 200) && str(m.mode, 40)
        ? { t: 'setMode', reqId: m.reqId, chatKey: m.chatKey, mode: m.mode }
        : null
    case 'stop':
      return str(m.reqId, 64) && str(m.chatKey, 200) ? { t: 'stop', reqId: m.reqId, chatKey: m.chatKey } : null
    case 'jobs':
      return { t: 'jobs' }
    case 'usage':
      return { t: 'usage' }
    case 'jobSet':
      return str(m.reqId, 64) && str(m.id, 100) && typeof m.enabled === 'boolean'
        ? { t: 'jobSet', reqId: m.reqId, id: m.id, enabled: m.enabled }
        : null
    case 'jobRun':
    case 'jobDelete':
      return str(m.reqId, 64) && str(m.id, 100) ? { t: m.t, reqId: m.reqId, id: m.id } : null
    case 'jobAdd': {
      const job = parseNewJob(m.job)
      return str(m.reqId, 64) && job ? { t: 'jobAdd', reqId: m.reqId, job } : null
    }
    default:
      return null
  }
}

/** One relay message tops out at 256KB; keep replies well under it. */
export const MAX_REPLY = 60_000
export const clipReply = (s: string): string => (s.length > MAX_REPLY ? s.slice(0, MAX_REPLY) + '\n…' : s)

/** One line of a chat's conversation, as the phone shows it. */
export interface HistoryItem {
  role: 'user' | 'assistant'
  text: string
  /** Tool calls the agent made in this message (shown as a count). */
  tools?: number
  /** The calls themselves, clipped: what was run, read or changed. */
  toolList?: Array<{ name: string; detail: string }>
}

const HISTORY_ITEMS = 40
const HISTORY_ITEM_CHARS = 4_000
const HISTORY_BUDGET = 120_000
const TOOLS_PER_ITEM = 30
const TOOL_DETAIL_CHARS = 160

/** The first calls of a message, each named and briefly described. */
function clipTools(list: Array<{ name: string; detail: string }>): Array<{ name: string; detail: string }> {
  return list.slice(0, TOOLS_PER_ITEM).map((t) => ({
    name: t.name.slice(0, 60),
    detail: t.detail.length > TOOL_DETAIL_CHARS ? t.detail.slice(0, TOOL_DETAIL_CHARS) + '…' : t.detail
  }))
}

/**
 * The tail of a conversation, sized for one relay message: the most recent
 * items, each clipped, and the oldest dropped until the whole fits.
 */
export function clipHistory(items: HistoryItem[]): HistoryItem[] {
  const out = items
    .filter((m) => m.text.trim() || m.tools)
    .slice(-HISTORY_ITEMS)
    .map((m) => ({
      ...m,
      text: m.text.length > HISTORY_ITEM_CHARS ? m.text.slice(0, HISTORY_ITEM_CHARS) + '\n…' : m.text,
      ...(m.toolList ? { toolList: clipTools(m.toolList) } : {})
    }))
  const sizeOf = (m: HistoryItem): number =>
    m.text.length + (m.toolList?.reduce((n, t) => n + t.name.length + t.detail.length, 0) ?? 0)
  let size = out.reduce((n, m) => n + sizeOf(m), 0)
  while (out.length > 1 && size > HISTORY_BUDGET) size -= sizeOf(out.shift()!)
  return out
}

/**
 * Realtime topic for one computer's channel. It starts with the owner's account
 * id because that is what the RLS policy checks (supabase/remote.sql): a
 * signed-in user can join `riven-remote:<their id>:…` and nothing else.
 */
export const channelName = (owner: string, id: string): string => `riven-remote:${owner}:${id}`
