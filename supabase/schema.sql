-- riven — settings sync schema.
-- Run this in the Supabase SQL editor (or `supabase db push`) once per project.
--
-- One row per user holds their synced settings as a JSON blob. Row-Level
-- Security ensures a user can only ever read/write their own row.

create table if not exists public.user_settings (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  settings   jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

-- Each policy is scoped to the authenticated user's own row.
drop policy if exists "own settings — select" on public.user_settings;
create policy "own settings — select"
  on public.user_settings for select
  using (auth.uid() = user_id);

drop policy if exists "own settings — insert" on public.user_settings;
create policy "own settings — insert"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

drop policy if exists "own settings — update" on public.user_settings;
create policy "own settings — update"
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
