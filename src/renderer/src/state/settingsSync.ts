import { supabase } from '../lib/supabase'
import { useSettings, DEFAULT_SETTINGS, type Settings } from './settings'

// Cloud settings sync. A signed-in user's preferences live in one row of the
// `user_settings` table (user_id PK + a `settings` jsonb blob), protected by
// RLS so each user only ever sees their own. See supabase/schema.sql.

const TABLE = 'user_settings'

// Secrets never leave the device. The API key is the only sensitive field in
// Settings today; keep this list in sync if more are added.
const SYNC_EXCLUDE: ReadonlyArray<keyof Settings> = ['aiApiKey']

export function pickSyncable(s: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (!SYNC_EXCLUDE.includes(k as keyof Settings)) out[k] = v
  }
  return out as Partial<Settings>
}

// While we apply cloud settings locally we must not echo them straight back to
// the cloud — the push subscription checks this flag.
let suppressPush = false
export function isPushSuppressed(): boolean {
  return suppressPush
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
  suppressPush = true
  try {
    useSettings.getState().set(clean)
  } finally {
    // Release after the store's own debounced subscribers have queued.
    setTimeout(() => {
      suppressPush = false
    }, 0)
  }
}
