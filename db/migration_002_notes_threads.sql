-- ============================================================================
-- Migration 002: task notes + internal threads (chat)
-- Apply via Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Task notes — timestamped log entries on a task
-- ----------------------------------------------------------------------------
create table if not exists public.task_notes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_task_notes_task on public.task_notes (task_id, created_at desc);

alter table public.task_notes enable row level security;

drop policy if exists "task_notes_select_auth" on public.task_notes;
create policy "task_notes_select_auth" on public.task_notes
  for select to authenticated using (true);

drop policy if exists "task_notes_insert_auth" on public.task_notes;
create policy "task_notes_insert_auth" on public.task_notes
  for insert to authenticated with check (auth.uid() is not null);

drop policy if exists "task_notes_update_owner" on public.task_notes;
create policy "task_notes_update_owner" on public.task_notes
  for update to authenticated using (author_id = auth.uid() or public.is_admin());

drop policy if exists "task_notes_delete_owner" on public.task_notes;
create policy "task_notes_delete_owner" on public.task_notes
  for delete to authenticated using (author_id = auth.uid() or public.is_admin());

-- ----------------------------------------------------------------------------
-- Threads — internal team Q&A
-- ----------------------------------------------------------------------------
create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  starter_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid references public.profiles(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  subject text,
  urgency text not null default 'normal'
    check (urgency in ('low','normal','high','urgent')),
  status text not null default 'open'
    check (status in ('open','closed')),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists idx_threads_recipient on public.threads (recipient_id, status, last_message_at desc);
create index if not exists idx_threads_starter   on public.threads (starter_id, status, last_message_at desc);

alter table public.threads enable row level security;

-- Only participants (or admin) can see/touch threads
drop policy if exists "threads_select_participant" on public.threads;
create policy "threads_select_participant" on public.threads
  for select to authenticated
  using (starter_id = auth.uid() or recipient_id = auth.uid() or public.is_admin());

drop policy if exists "threads_insert_self" on public.threads;
create policy "threads_insert_self" on public.threads
  for insert to authenticated
  with check (starter_id = auth.uid());

drop policy if exists "threads_update_participant" on public.threads;
create policy "threads_update_participant" on public.threads
  for update to authenticated
  using (starter_id = auth.uid() or recipient_id = auth.uid() or public.is_admin());

drop policy if exists "threads_delete_participant" on public.threads;
create policy "threads_delete_participant" on public.threads
  for delete to authenticated
  using (starter_id = auth.uid() or recipient_id = auth.uid() or public.is_admin());

-- ----------------------------------------------------------------------------
-- Thread messages — individual Q/A entries inside a thread
-- ----------------------------------------------------------------------------
create table if not exists public.thread_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  attachment_url text,
  attachment_kind text check (attachment_kind in ('image','file','link') or attachment_kind is null),
  attachment_label text,
  created_at timestamptz not null default now(),
  read_by_recipient_at timestamptz
);

create index if not exists idx_thread_messages_thread on public.thread_messages (thread_id, created_at);

alter table public.thread_messages enable row level security;

-- Participants of the parent thread can see/post messages.
drop policy if exists "thread_messages_select_participant" on public.thread_messages;
create policy "thread_messages_select_participant" on public.thread_messages
  for select to authenticated using (
    public.is_admin() or exists (
      select 1 from public.threads t
      where t.id = thread_messages.thread_id
        and (t.starter_id = auth.uid() or t.recipient_id = auth.uid())
    )
  );

drop policy if exists "thread_messages_insert_participant" on public.thread_messages;
create policy "thread_messages_insert_participant" on public.thread_messages
  for insert to authenticated with check (
    author_id = auth.uid() and exists (
      select 1 from public.threads t
      where t.id = thread_messages.thread_id
        and (t.starter_id = auth.uid() or t.recipient_id = auth.uid())
    )
  );

drop policy if exists "thread_messages_update_owner" on public.thread_messages;
create policy "thread_messages_update_owner" on public.thread_messages
  for update to authenticated
  using (author_id = auth.uid() or public.is_admin());

drop policy if exists "thread_messages_delete_owner" on public.thread_messages;
create policy "thread_messages_delete_owner" on public.thread_messages
  for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

-- ----------------------------------------------------------------------------
-- Bump thread.last_message_at when a message is inserted
-- ----------------------------------------------------------------------------
create or replace function public.bump_thread_last_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.threads
    set last_message_at = new.created_at,
        status = case when status = 'closed' then 'open' else status end,
        closed_at = case when status = 'closed' then null else closed_at end
    where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists on_thread_message_inserted on public.thread_messages;
create trigger on_thread_message_inserted
  after insert on public.thread_messages
  for each row execute function public.bump_thread_last_message();
