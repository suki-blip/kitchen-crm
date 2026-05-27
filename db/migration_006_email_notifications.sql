-- ============================================================================
-- Migration 006: email notifications (Resend integration)
-- - profiles.notify_email: per-user opt-out (default ON)
-- - task_notifications: log table to dedup same-day reminders
-- - notify_task_assigned trigger: HTTP-POSTs the Edge Function on INSERT or
--   when assigned_to changes, so the function can send a "Task assigned" email
--
-- Daily reminders (due_today + overdue) are triggered by a pg_cron job that
-- calls the same Edge Function with {kind: 'daily-scan'}. The cron is set up
-- separately (see "Schedule daily scan" block below).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Per-user opt-out
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists notify_email boolean not null default true;

-- ----------------------------------------------------------------------------
-- 2. Notification log (one row per email actually sent)
-- ----------------------------------------------------------------------------
create table if not exists public.task_notifications (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks(id)    on delete cascade,
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  kind          text not null check (kind in ('created', 'due_today', 'overdue')),
  sent_at       timestamptz not null default now(),
  -- Generated column so we can build a unique index on (task, recipient, kind, day)
  sent_date     date generated always as (((sent_at) at time zone 'UTC')::date) stored,
  status        text not null default 'sent' check (status in ('sent', 'failed')),
  resend_id     text,
  error_message text
);

-- One email per (task, recipient, kind, calendar-day-UTC).
-- INSERT...ON CONFLICT DO NOTHING in the Edge Function uses this to dedupe.
create unique index if not exists uniq_task_notifications_dedupe
  on public.task_notifications (task_id, recipient_id, kind, sent_date);

create index if not exists idx_task_notifications_task
  on public.task_notifications (task_id, sent_at desc);
create index if not exists idx_task_notifications_recipient
  on public.task_notifications (recipient_id, sent_at desc);

alter table public.task_notifications enable row level security;

-- Anyone authenticated can read the log (so admins can audit). Writes happen
-- via Edge Function using the service_role key, which bypasses RLS.
drop policy if exists "task_notifications_select_auth" on public.task_notifications;
create policy "task_notifications_select_auth" on public.task_notifications
  for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- 3. Required extensions for HTTP calls from Postgres
-- ----------------------------------------------------------------------------
create extension if not exists pg_net  with schema extensions;
create extension if not exists pg_cron with schema extensions;

-- ----------------------------------------------------------------------------
-- 4. Internal secret used to authenticate trigger/cron → Edge Function calls.
--    This is stored as a Postgres setting (so the trigger can read it) AND
--    needs to be added as a Supabase Edge Function secret (INTERNAL_NOTIFY_SECRET)
--    so the function can verify it. The setting below is a placeholder; the
--    deploy script will set it via `alter database ... set ...`.
-- ----------------------------------------------------------------------------
-- (No SQL needed here — see deploy notes at the bottom of this file.)

-- ----------------------------------------------------------------------------
-- 5. Trigger: fire HTTP POST to the Edge Function whenever a task is created
--    or re-assigned. The function does the heavy lifting (lookup email, build
--    body, send via Resend, log).
-- ----------------------------------------------------------------------------
create or replace function public.notify_task_assigned()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  fn_url      text;
  shared_key  text;
begin
  -- Skip when there is no assignee, or assignee didn't change on UPDATE
  if new.assigned_to is null then return new; end if;
  if tg_op = 'UPDATE' and (old.assigned_to is not distinct from new.assigned_to) then
    return new;
  end if;

  -- Read config (set by the deploy script — see deploy notes)
  fn_url     := current_setting('app.notify_fn_url', true);
  shared_key := current_setting('app.notify_secret', true);
  if fn_url is null or fn_url = '' then return new; end if;

  -- Fire-and-forget HTTP call. Errors are caught so they don't block task creation.
  begin
    perform net.http_post(
      url     := fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Secret', coalesce(shared_key, '')
      ),
      body    := jsonb_build_object(
        'kind',         'created',
        'task_id',      new.id,
        'recipient_id', new.assigned_to
      )
    );
  exception when others then
    raise warning 'notify_task_assigned http_post failed: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_task_assigned on public.tasks;
create trigger trg_task_assigned
  after insert or update of assigned_to on public.tasks
  for each row execute function public.notify_task_assigned();

-- ----------------------------------------------------------------------------
-- 6. Daily-scan helper: invoke the Edge Function with {kind: 'daily-scan'}.
--    The function scans tasks due today + overdue and sends emails.
-- ----------------------------------------------------------------------------
create or replace function public.notify_daily_scan()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  fn_url     text := current_setting('app.notify_fn_url', true);
  shared_key text := current_setting('app.notify_secret', true);
begin
  if fn_url is null or fn_url = '' then return; end if;
  perform net.http_post(
    url     := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Internal-Secret', coalesce(shared_key, '')
    ),
    body    := jsonb_build_object('kind', 'daily-scan')
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Schedule the daily scan at 09:00 UTC (= 12:00 Israel summer / 11:00 winter)
--    Note: pg_cron uses UTC. Adjust below if you prefer a different local time.
-- ----------------------------------------------------------------------------
-- Remove old schedule if present (idempotent re-runs).
do $$
declare
  jid integer;
begin
  select jobid into jid from cron.job where jobname = 'kcrm-daily-task-emails';
  if jid is not null then perform cron.unschedule(jid); end if;
end $$;

select cron.schedule(
  'kcrm-daily-task-emails',
  '0 6 * * *',                              -- 06:00 UTC = 09:00 Israel (winter / DST = 08:00 — close enough)
  $$select public.notify_daily_scan();$$
);

-- ============================================================================
-- DEPLOY NOTES (run these AFTER applying the schema above, ONCE you know the
-- Edge Function URL and have generated an internal-secret string):
--
--   -- 1) Set the Edge Function URL the trigger / cron should call:
--   alter database postgres set app.notify_fn_url =
--     'https://vfitvtbqzeygthrbdabh.supabase.co/functions/v1/send-task-emails';
--
--   -- 2) Set the shared secret (must match INTERNAL_NOTIFY_SECRET in the
--   --    Edge Function's env). Generate with openssl rand -hex 32 or similar.
--   alter database postgres set app.notify_secret = '<random-hex-here>';
--
--   -- After altering, reconnect any open sessions for the settings to take effect.
-- ============================================================================
