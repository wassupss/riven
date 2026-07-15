import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured, REDIRECT_TO } from '../lib/supabase'
import { useSettings, getSettings } from './settings'
import { applyRemote, pullRemote, pushRemote, isPushSuppressed, setPulling } from './settingsSync'

export type Provider = 'google' | 'github'
type AuthStatus = 'idle' | 'loading' | 'signed-in' | 'error'
type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error'

interface AuthState {
  configured: boolean
  status: AuthStatus
  user: User | null
  session: Session | null
  syncStatus: SyncStatus
  error: string | null
  initAuth: () => Promise<void>
  signIn: (provider: Provider) => Promise<void>
  signOut: () => Promise<void>
  syncNow: () => Promise<void>
}

let initialized = false
let pushTimer: ReturnType<typeof setTimeout> | null = null
// The INITIAL_SESSION event and the explicit getSession() can both trigger a
// pull on launch; this dedups so a given user is pulled once (reset on sign-out).
let lastPulledUser: string | null = null

function cancelPendingPush(): void {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
}

export const useAuth = create<AuthState>((set, get) => ({
  configured: isSupabaseConfigured,
  status: 'idle',
  user: null,
  session: null,
  syncStatus: 'idle',
  error: null,

  initAuth: async () => {
    if (!supabase || initialized) return
    initialized = true

    // React to any session change (initial restore, sign-in, sign-out, refresh).
    supabase.auth.onAuthStateChange((_event, session) => {
      const prevUser = get().user
      set({
        session,
        user: session?.user ?? null,
        status: session?.user ? 'signed-in' : 'idle'
      })
      // Pull the cloud copy once per fresh sign-in.
      if (session?.user && session.user.id !== prevUser?.id) void pullOnce(session.user.id, set)
      if (!session) {
        // Signed out / session ended: stop any queued push under the old user.
        cancelPendingPush()
        lastPulledUser = null
        set({ syncStatus: 'idle' })
      }
    })

    // Push local settings to the cloud (debounced) whenever they change while
    // signed in — unless we're mid-apply of a cloud pull.
    useSettings.subscribe((s) => {
      const { user } = get()
      if (!user || !s.ready || isPushSuppressed()) return
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = setTimeout(() => {
        set({ syncStatus: 'syncing' })
        pushRemote(user.id, s.settings)
          .then(() => set({ syncStatus: 'synced' }))
          .catch((e) => set({ syncStatus: 'error', error: String(e?.message ?? e) }))
      }, 800)
    })

    const { data } = await supabase.auth.getSession()
    if (data.session?.user) {
      set({ session: data.session, user: data.session.user, status: 'signed-in' })
      void pullOnce(data.session.user.id, set)
    }
  },

  signIn: async (provider) => {
    if (!supabase) return
    set({ status: 'loading', error: null })
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { skipBrowserRedirect: true, redirectTo: REDIRECT_TO }
      })
      if (error) throw error
      if (!data.url) throw new Error('no authorize url')
      const code = await window.api.auth.oauth(data.url, REDIRECT_TO)
      const { error: exErr } = await supabase.auth.exchangeCodeForSession(code)
      if (exErr) throw exErr
      // onAuthStateChange handles state + pull.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // A user closing the login window isn't an error worth surfacing.
      set({ status: get().user ? 'signed-in' : 'idle', error: msg === 'cancelled' ? null : msg })
    }
  },

  signOut: async () => {
    if (!supabase) return
    cancelPendingPush()
    lastPulledUser = null
    await supabase.auth.signOut()
    set({ user: null, session: null, status: 'idle', syncStatus: 'idle', error: null })
  },

  syncNow: async () => {
    const { user } = get()
    if (!user) return
    set({ syncStatus: 'syncing', error: null })
    try {
      await pushRemote(user.id, getSettings())
      set({ syncStatus: 'synced' })
    } catch (e) {
      set({ syncStatus: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }
}))

// First pull after sign-in: adopt the cloud copy if it exists, otherwise seed
// the cloud with the current local settings.
async function pullOnce(userId: string, set: (p: Partial<AuthState>) => void): Promise<void> {
  // Dedup: a launch can trigger this from both INITIAL_SESSION and getSession().
  // Running it once per user keeps the two from interleaving and re-opening the
  // push window mid-pull (which could clobber the cloud copy).
  if (lastPulledUser === userId) return
  lastPulledUser = userId
  set({ syncStatus: 'syncing' })
  // Block the debounced push for the whole pull window so a local edit that
  // lands while the network request is in flight can't overwrite the cloud copy
  // before we've adopted it.
  setPulling(true)
  try {
    const remote = await pullRemote(userId)
    if (remote) {
      applyRemote(remote)
    } else {
      await pushRemote(userId, getSettings())
    }
    set({ syncStatus: 'synced' })
  } catch (e) {
    set({ syncStatus: 'error', error: e instanceof Error ? e.message : String(e) })
  } finally {
    setPulling(false)
  }
}
