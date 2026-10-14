// What the phone and this app say to each other, inside the sealed envelope
// (see remoteCrypto). Kept small on purpose: on Supabase's free tier every
// message counts, so the app sends state CHANGES, never a stream.

import type { AgentActivity } from '../state/agents'

export interface RemoteAgent {
  id: string // pane key
  workspace: string // display name
  kind: 'chat' | 'terminal'
  title: string
  status: AgentActivity
  /** A chat pane: it can take a message (its workspace is opened if need be). */
  canSend: boolean
}

/** App → phone. */
export type DeskMsg =
  | { t: 'roster'; agents: RemoteAgent[] }
  | { t: 'ask'; id: string; title: string; question: string; options: string[] }
  | { t: 'askGone'; id: string }
  | { t: 'ack'; reqId: string; ok: boolean; error?: string }
  | { t: 'reply'; reqId: string; chatKey: string; text: string }
  | { t: 'event'; kind: 'done' | 'attention'; id: string; title: string }

/** Phone → app. */
export type PhoneMsg =
  | { t: 'hello' }
  | { t: 'send'; reqId: string; chatKey: string; text: string }
  | { t: 'answer'; id: string; choice: string }

export const MAX_TEXT = 20_000
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** Validate what arrived from the phone. Anything malformed is dropped. */
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
    default:
      return null
  }
}

/** A reply can be long; the relay caps one message at 256KB, so keep well under. */
export const MAX_REPLY = 60_000
export const clipReply = (s: string): string => (s.length > MAX_REPLY ? s.slice(0, MAX_REPLY) + '\n…' : s)

/** The pairing link the QR code carries. Everything secret is in the fragment. */
export function pairingUrl(base: string, p: { channel: string; key: string; url: string; anon: string }): string {
  const q = new URLSearchParams({ c: p.channel, k: p.key, u: p.url, a: p.anon })
  return `${base}#${q.toString()}`
}
