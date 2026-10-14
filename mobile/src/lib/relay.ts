import type { RealtimeChannel, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'
import { channelName } from '@riven/remote'
import { supabase } from './supabase'

// The relay: private Realtime channels on the app's Supabase project. Joining
// one is checked against the signed-in account (supabase/remote.sql), so a
// channel opens only for the account that owns that computer.

export function openChannel(owner: string, channel: string, presenceKey: string): RealtimeChannel | null {
  if (!supabase) return null
  return supabase.channel(channelName(owner, channel), {
    config: { private: true, broadcast: { self: false }, presence: { key: presenceKey } }
  })
}

// Closed before its token was in place: it must not subscribe after all.
const closed = new WeakSet<RealtimeChannel>()

/** Subscribe with the session's token on the socket; without it a private channel is refused. */
export function joinChannel(ch: RealtimeChannel, onStatus: (s: `${REALTIME_SUBSCRIBE_STATES}`) => void): void {
  if (!supabase) return
  void supabase.realtime.setAuth().then(() => {
    if (!closed.has(ch)) ch.subscribe((s) => onStatus(s))
  })
}

export function closeChannel(ch: RealtimeChannel): void {
  closed.add(ch)
  void supabase?.removeChannel(ch)
}
