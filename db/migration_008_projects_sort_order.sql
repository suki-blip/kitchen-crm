-- ============================================================================
-- Migration 008: projects.sort_order for manual drag-reorder in the leads list
-- ----------------------------------------------------------------------------
-- Same pattern as tasks.sort_order from migration 007. Lower = higher up.
-- The leads page reads this when sorting in the default "Manual" mode.
-- ============================================================================

alter table public.projects
  add column if not exists sort_order integer not null default 0;

create index if not exists idx_projects_sort_order
  on public.projects (sort_order, created_at);

select 'projects.sort_order' as item, exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='projects' and column_name='sort_order'
) as ok;
