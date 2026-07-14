import { supabase } from '../lib/supabase'
import { useSettings, DEFAULT_SETTINGS, type Settings } from './settings'

// Cloud settings sync. A signed-in user's preferences live in one row of the
// `user_settings` table (user_id PK + a `settings` jsonb blob), protected by
// RLS so each user only ever sees their own. See supabase/schema.sql.

const TABLE = 'user_settings'

// Never synced. `aiApiKey` is a secret; `importedFonts` holds multi-MB base64
// data URLs that would blow past the row/payload limits and get re-uploaded on
// every unrelated settings change — fonts stay device-local.
const SYNC_EXCLUDE: ReadonlyArray<keyof Settings> = ['aiApiKey', 'importedFonts']

export function pickSyncable(s: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (!SYNC_EXCLUDE.includes(k as keyof Settings)) out[k] = v
  }
  return out as Partial<Settings>
}

// The push subscription must stay quiet in two windows: while we're applying a
// cloud pull locally (else we'd echo it straight back), and for the whole
// duration of the initial pull (else a user edit mid-pull would push local data
// and clobber the cloud copy before the pull lands).
let suppressPush = false
let pulling = false
export function isPushSuppressed(): boolean {
  return suppressPush || pulling
}
export function setPulling(v: boolean): void {
  pulling = v
}

export async function pullRemote(userId: string): Promise<Partial<Settings> | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from(TABLE)
    .select('settings')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return (data?.settings as Partial<Settings> | undefined) ?? null
}

export async function pushRemote(userId: string, settings: Settings): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from(TABLE).upsert(
    { user_id: userId, settings: pickSyncable(settings), updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  )
  if (error) throw error
}

// Merge cloud settings into the local store without triggering a push back.
// Unknown/secret keys are ignored; anything the cloud omits (e.g. aiApiKey)
// keeps its local value.
export function applyRemote(remote: Partial<Settings>): void {
  const clean = pickSyncable({ ...DEFAULT_SETTINGS, ...remote } as Settings)
  // zustand fires subscribers synchronously inside set(), so a plain flag around
  // the call is enough — the push subscription sees it true and skips. No timer
  // (the old setTimeout(…,0) could let a same-tick user edit slip through).
  suppressPush = true
  try {
    useSettings.getState().set(clean)
  } finally {
    suppressPush = false
  }
}
