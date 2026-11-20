import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { storeMapGet, storeMapSet } from './fileStore'

// Supabase is configured through Vite env vars (VITE_ prefix → exposed to the
// renderer). When they're absent the whole account/sync feature degrades
// gracefully: the UI shows a "not configured" note and nothing throws.

export const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim()
export const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()

// Where the provider redirects after auth. We never actually load this page —
// the main process intercepts the navigation and lifts the PKCE code out — so
// it only needs to be listed in the Supabase project's redirect allowlist.
export const REDIRECT_TO =
  (import.meta.env.VITE_SUPABASE_REDIRECT as string | undefined)?.trim() ||
  'https://localhost/riven/auth/callback'

export const isSupabaseConfigured = !!(url && anonKey)

// The session lives in userData/store/auth.json (lib/fileStore), not in the
// engine's localStorage, so signing in once holds for the Electron and the
// Tauri build alike. Same keys as supabase-js put in localStorage (sb-...).
const fileStorage = {
  getItem: (k: string): string | null => storeMapGet<string>('auth', k) ?? null,
  setItem: (k: string, v: string): void => storeMapSet('auth', k, v),
  removeItem: (k: string): void => storeMapSet('auth', k, undefined)
}

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: {
        // The renderer initiates the flow (holds the PKCE verifier) and the
        // callback happens in a separate window, so we exchange the code by
        // hand — never let supabase-js scan the renderer URL for a session.
        flowType: 'pkce',
        persistSession: true,
        storage: fileStorage,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    })
  : null
