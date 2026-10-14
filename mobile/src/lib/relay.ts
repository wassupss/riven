import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import { channelName } from '@riven/remote'

// One Supabase client per relay project, reused across screens. Only Realtime
// is used: no auth session is kept on the phone.
const clients = new Map<string, SupabaseClient>()

function client(url: string, anon: string): SupabaseClient {
  const key = `${url}|${anon}`
  let c = clients.get(key)
  if (!c) {
    c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    clients.set(key, c)
  }
  return c
}

export function openChannel(url: string, anon: string, channel: string, presenceKey: string): RealtimeChannel {
  return client(url, anon).channel(channelName(channel), {
    config: { broadcast: { self: false }, presence: { key: presenceKey } }
  })
}

export function closeChannel(url: string, anon: string, ch: RealtimeChannel): void {
  void client(url, anon).removeChannel(ch)
}
