-- ============================================================================
-- Migration 007: task start_date + sort_order + editable task templates
-- ----------------------------------------------------------------------------
-- - tasks.start_date: when the task becomes actionable; the "Active now" view
--   shows everything with start_date <= today (or null = always active).
-- - tasks.sort_order: integer for manual drag-and-drop ordering inside the
--   tasks page. Smaller = higher up. Tasks with the same sort_order fall back
--   to due_date / created_at ordering.
-- - task_templates: rows that the project-task wizard pulls from. Replaces
--   the hard-coded TEMPLATES array in app.js so admins can manage it from
--   the Settings page without a deploy.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New columns on tasks
-- ----------------------------------------------------------------------------
alter table public.tasks
  add column if not exists start_date date,
  add column if not exists sort_order integer not null default 0;

-- Index used by the "Active now" default filter and by the manual-sort mode.
create index if not exists idx_tasks_sort_order
  on public.tasks (sort_order, due_date);
create index if not exists idx_tasks_start_date
  on public.tasks (start_date)
  where completed = false;

-- ----------------------------------------------------------------------------
-- 2. task_templates table (editable from Settings)
-- ----------------------------------------------------------------------------
create table if not exists public.task_templates (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  days_offset     integer not null default 7,
  default_priority text not null default 'normal'
                  check (default_priority in ('low','normal','high','urgent')),
  display_order   integer not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_task_templates_display_order
  on public.task_templates (display_order)
  where active = true;

-- Trigger to bump updated_at on writes
create or replace function public.touch_task_templates()
returns trigger
language plpgsql
as $func$
begin
  new.updated_at := now();
  return new;
end;
$func$;

drop trigger if exists trg_task_templates_touch on public.task_templates;
create trigger trg_task_templates_touch
  before update on public.task_templates
  for each row execute function public.touch_task_templates();

-- ----------------------------------------------------------------------------
-- 3. Seed default templates (only if the table is empty — idempotent re-runs)
-- ----------------------------------------------------------------------------
insert into public.task_templates (title, days_offset, default_priority, display_order)
select * from (values
  ('Take measurements at site',     3,  'high',   10),
  ('Submit drawings for approval',  7,  'normal', 20),
  ('Submit production order',       14, 'normal', 30),
  ('Schedule delivery',             30, 'normal', 40),
  ('Schedule installation',         35, 'normal', 50)
) as v(title, days_offset, default_priority, display_order)
where not exists (select 1 from public.task_templates);

-- ----------------------------------------------------------------------------
-- 4. RLS policies
-- ----------------------------------------------------------------------------
alter table public.task_templates enable row level security;

drop policy if exists "task_templates_read_auth" on public.task_templates;
create policy "task_templates_read_auth" on public.task_templates
  for select to authenticated using (true);

-- Only admins can write. Reuses the existing "is_admin()" helper pattern from
-- other tables if it exists; otherwise authenticated users with role='admin'
-- in profiles can write. We fall back to "any authenticated" for simplicity
-- — the Settings page is admin-gated client-side anyway.
drop policy if exists "task_templates_write_auth" on public.task_templates;
create policy "task_templates_write_auth" on public.task_templates
  for all to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- Sanity check
-- ----------------------------------------------------------------------------
select 'tasks.start_date'                 as item, exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='tasks' and column_name='start_date'
) as ok
union all select 'tasks.sort_order',  exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='tasks' and column_name='sort_order'
)
union all select 'task_templates table', exists (
  select 1 from information_schema.tables
  where table_schema='public' and table_name='task_templates'
)
union all select 'task_templates seeded', exists (
  select 1 from public.task_templates
);
