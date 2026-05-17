-- ============================================================================
-- Migration 004: incoming email inbox (triage to task / lead)
-- Apply via Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================================

create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  -- Gmail/IMAP identifiers (used for dedup when we wire up real sync in stage 2)
  message_id text unique,
  thread_id text,
  -- Sender / subject / body
  from_email text not null,
  from_name text,
  to_emails text[],
  subject text,
  snippet text,                 -- short preview, ~200 chars
  body_text text,               -- plain-text body (preferred for triage)
  -- Timestamps
  received_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  -- Triage state
  status text not null default 'new'
    check (status in ('new','archived','converted_task','converted_lead','converted_both')),
  converted_to_task_id    uuid references public.tasks(id)    on delete set null,
  converted_to_project_id uuid references public.projects(id) on delete set null,
  converted_to_customer_id uuid references public.customers(id) on delete set null,
  triaged_by uuid references public.profiles(id) on delete set null,
  triaged_at timestamptz,
  -- Source flag (mock = added by hand for stage 1; gmail = real sync)
  source text not null default 'mock' check (source in ('mock','gmail','manual'))
);

create index if not exists idx_emails_status      on public.emails (status, received_at desc);
create index if not exists idx_emails_received_at on public.emails (received_at desc);
create index if not exists idx_emails_from        on public.emails (from_email);

alter table public.emails enable row level security;

-- Everyone authenticated can read; admin/sales/production can triage; admin can delete.
drop policy if exists "emails_select_auth" on public.emails;
create policy "emails_select_auth" on public.emails
  for select to authenticated using (true);

drop policy if exists "emails_insert_auth" on public.emails;
create policy "emails_insert_auth" on public.emails
  for insert to authenticated with check (auth.uid() is not null);

drop policy if exists "emails_update_team" on public.emails;
create policy "emails_update_team" on public.emails
  for update to authenticated
  using (public.current_role_id() in ('admin','sales','production'));

drop policy if exists "emails_delete_admin" on public.emails;
create policy "emails_delete_admin" on public.emails
  for delete to authenticated using (public.is_admin());
