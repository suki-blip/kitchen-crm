-- ============================================================================
-- Migration 004: group threads — multiple participants per conversation
-- Apply via Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================================

-- ----------------------------------------------------------------------------
-- thread_participants — many-to-many between threads and profiles
-- ----------------------------------------------------------------------------
create table if not exists public.thread_participants (
  thread_id uuid not null references public.threads(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (thread_id, user_id)
);

create index if not exists idx_thread_participants_user on public.thread_participants (user_id, thread_id);

alter table public.thread_participants enable row level security;

-- ----------------------------------------------------------------------------
-- Backfill: every existing thread becomes a participants row for starter +
-- recipient. (recipient_id stays for backward compatibility / "primary" hint.)
-- ----------------------------------------------------------------------------
insert into public.thread_participants (thread_id, user_id)
  select id, starter_id from public.threads
  where starter_id is not null
  on conflict do nothing;

insert into public.thread_participants (thread_id, user_id)
  select id, recipient_id from public.threads
  where recipient_id is not null
  on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Helper: does the current user participate in a given thread?
-- (Includes the starter implicitly so older code that checks starter still works.)
-- ----------------------------------------------------------------------------
create or replace function public.is_thread_participant(tid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.threads t
    where t.id = tid and (
      t.starter_id = auth.uid()
      or exists (
        select 1 from public.thread_participants tp
        where tp.thread_id = tid and tp.user_id = auth.uid()
      )
    )
  );
$$;

-- ----------------------------------------------------------------------------
-- thread_participants — RLS
-- ----------------------------------------------------------------------------
drop policy if exists "thread_participants_select" on public.thread_participants;
create policy "thread_participants_select" on public.thread_participants
  for select to authenticated using (
    public.is_admin() or public.is_thread_participant(thread_id)
  );

drop policy if exists "thread_participants_insert" on public.thread_participants;
create policy "thread_participants_insert" on public.thread_participants
  for insert to authenticated with check (
    public.is_admin() or exists (
      select 1 from public.threads t
      where t.id = thread_id and t.starter_id = auth.uid()
    )
  );

drop policy if exists "thread_participants_delete" on public.thread_participants;
create policy "thread_participants_delete" on public.thread_participants
  for delete to authenticated using (
    user_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.threads t
      where t.id = thread_id and t.starter_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- Update existing threads + thread_messages RLS to include participants
-- ----------------------------------------------------------------------------
drop policy if exists "threads_select_participant" on public.threads;
create policy "threads_select_participant" on public.threads
  for select to authenticated
  using (
    starter_id = auth.uid()
    or recipient_id = auth.uid()
    or exists (
      select 1 from public.thread_participants tp
      where tp.thread_id = threads.id and tp.user_id = auth.uid()
    )
    or public.is_admin()
  );

drop policy if exists "threads_update_participant" on public.threads;
create policy "threads_update_participant" on public.threads
  for update to authenticated
  using (
    starter_id = auth.uid()
    or recipient_id = auth.uid()
    or exists (
      select 1 from public.thread_participants tp
      where tp.thread_id = threads.id and tp.user_id = auth.uid()
    )
    or public.is_admin()
  );

drop policy if exists "threads_delete_participant" on public.threads;
create policy "threads_delete_participant" on public.threads
  for delete to authenticated
  using (
    starter_id = auth.uid()
    or recipient_id = auth.uid()
    or exists (
      select 1 from public.thread_participants tp
      where tp.thread_id = threads.id and tp.user_id = auth.uid()
    )
    or public.is_admin()
  );

-- thread_messages — anyone in the thread can read/post
drop policy if exists "thread_messages_select_participant" on public.thread_messages;
create policy "thread_messages_select_participant" on public.thread_messages
  for select to authenticated using (
    public.is_admin() or public.is_thread_participant(thread_id)
  );

drop policy if exists "thread_messages_insert_participant" on public.thread_messages;
create policy "thread_messages_insert_participant" on public.thread_messages
  for insert to authenticated with check (
    author_id = auth.uid() and (public.is_admin() or public.is_thread_participant(thread_id))
  );
