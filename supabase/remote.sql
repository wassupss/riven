-- riven: remote control relay (phone ⇄ computer).
-- Run this in the Supabase SQL editor once per project, then in the dashboard
-- turn OFF  Realtime › Settings › "Allow public access"  so that no channel can
-- be joined without signing in.
--
-- The app talks over PRIVATE Realtime channels named
--   riven-remote:<owner's auth uid>:<channel id>
-- These policies let a signed-in user receive and send (broadcast and presence)
-- on their own topics only. Anyone else, signed in or not, is refused by
-- Realtime before a single message reaches them. What travels is end-to-end
-- encrypted anyway (see src/renderer/src/lib/remote/core.ts); this is what keeps
-- strangers off the relay altogether.

drop policy if exists "riven remote: own channels, receive" on realtime.messages;
create policy "riven remote: own channels, receive"
  on realtime.messages for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() like 'riven-remote:' || (select auth.uid())::text || ':%'
  );

drop policy if exists "riven remote: own channels, send" on realtime.messages;
create policy "riven remote: own channels, send"
  on realtime.messages for insert
  to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() like 'riven-remote:' || (select auth.uid())::text || ':%'
  );
