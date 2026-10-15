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
--
-- While remote control is being tried out, only accounts listed in
-- remote_testers may use it: the app hides it from everyone else and these
-- policies refuse them too. Add a tester with
--   insert into public.remote_testers (user_id) values ('<auth uid>');
-- and to open it to everyone, drop the "exists (...)" lines below and re-run.

create table if not exists public.remote_testers (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.remote_testers enable row level security;

-- Each account can see whether it is listed, nothing more. No insert/update/
-- delete policy: the list is edited from the dashboard only.
drop policy if exists "remote testers: own row" on public.remote_testers;
create policy "remote testers: own row"
  on public.remote_testers for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "riven remote: own channels, receive" on realtime.messages;
create policy "riven remote: own channels, receive"
  on realtime.messages for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() like 'riven-remote:' || (select auth.uid())::text || ':%'
    and exists (select 1 from public.remote_testers t where t.user_id = (select auth.uid()))
  );

drop policy if exists "riven remote: own channels, send" on realtime.messages;
create policy "riven remote: own channels, send"
  on realtime.messages for insert
  to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.topic() like 'riven-remote:' || (select auth.uid())::text || ':%'
    and exists (select 1 from public.remote_testers t where t.user_id = (select auth.uid()))
  );
