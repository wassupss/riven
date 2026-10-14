import { AppState } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// The app's one Supabase client: the same project riven on the computer uses,
// set at build time (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY).
// Both values are public by design; what keeps the relay closed is the sign-in
// (see supabase/remote.sql), not these.

export const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? ''
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? ''
export const configured = !!(url && anonKey)

// The session lives in the OS keystore, like the pairing keys. A keystore item
// is meant to stay under 2KB and a session (two tokens and the user) is often
// over it, so it is split across numbered items.
const CHUNK = 1800
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
const safe = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, '_')

const storage = {
  async getItem(key: string): Promise<string | null> {
    const k = safe(key)
    const n = Number(await SecureStore.getItemAsync(`${k}.n`, OPTS))
    if (!n) return null
    let out = ''
    for (let i = 0; i < n; i++) {
      const part = await SecureStore.getItemAsync(`${k}.${i}`, OPTS)
      if (part === null) return null
      out += part
    }
    return out
  },
  async setItem(key: string, value: string): Promise<void> {
    const k = safe(key)
    const old = Number(await SecureStore.getItemAsync(`${k}.n`, OPTS)) || 0
    const n = Math.ceil(value.length / CHUNK)
    for (let i = 0; i < n; i++)
      await SecureStore.setItemAsync(`${k}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK), OPTS)
    await SecureStore.setItemAsync(`${k}.n`, String(n), OPTS)
    for (let i = n; i < old; i++) await SecureStore.deleteItemAsync(`${k}.${i}`, OPTS)
  },
  async removeItem(key: string): Promise<void> {
    const k = safe(key)
    const n = Number(await SecureStore.getItemAsync(`${k}.n`, OPTS)) || 0
    for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${k}.${i}`, OPTS)
    await SecureStore.deleteItemAsync(`${k}.n`, OPTS)
  }
}

export const supabase: SupabaseClient | null = configured
  ? createClient(url, anonKey, {
      auth: {
        storage,
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    })
  : null

// Refresh the token only while the app is in front: a backgrounded app has no
// business keeping a timer going, and coming back refreshes it first thing.
if (supabase) {
  AppState.addEventListener('change', (s) => {
    if (s === 'active') void supabase.auth.startAutoRefresh()
    else void supabase.auth.stopAutoRefresh()
  })
}
