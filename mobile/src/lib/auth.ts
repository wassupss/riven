import { useEffect, useState } from 'react'
import * as Linking from 'expo-linking'
import * as WebBrowser from 'expo-web-browser'
import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'

// Signing in: the same riven account as the computer, or nothing. The relay
// lets an account reach only its own computers' channels, so this is what
// decides which computers this phone can talk to at all.

WebBrowser.maybeCompleteAuthSession()

export function useUser(): { ready: boolean; user: User | null } {
  const [st, setSt] = useState<{ ready: boolean; user: User | null }>({ ready: !supabase, user: null })
  useEffect(() => {
    if (!supabase) return
    let live = true
    void supabase.auth.getSession().then(({ data }) => {
      if (live) setSt({ ready: true, user: data.session?.user ?? null })
    })
    const { data } = supabase.auth.onAuthStateChange((_e, session) =>
      setSt({ ready: true, user: session?.user ?? null })
    )
    return () => {
      live = false
      data.subscription.unsubscribe()
    }
  }, [])
  return st
}

export type SignInResult = { ok: true } | { ok: false; error: string | null }

/** GitHub sign-in in the system browser, back into the app with a PKCE code. */
export async function signIn(): Promise<SignInResult> {
  if (!supabase) return { ok: false, error: '이 빌드에는 서버 설정이 없어요.' }
  // rivenremote://auth in a build; exp://…/--/auth under Expo Go.
  const redirectTo = Linking.createURL('auth')
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo, skipBrowserRedirect: true }
    })
    if (error || !data.url) throw error ?? new Error('no authorize url')
    const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo)
    if (res.type !== 'success') return { ok: false, error: null }
    const back = new URL(res.url)
    const code = back.searchParams.get('code')
    if (!code) throw new Error(back.searchParams.get('error_description') ?? '로그인이 완료되지 않았어요.')
    const { error: exErr } = await supabase.auth.exchangeCodeForSession(code)
    if (exErr) throw exErr
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut()
}
