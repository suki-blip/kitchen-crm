-- ============================================================================
-- Migration 005: add a description / details field to tasks
-- A standalone "what is this task about" field, separate from task_notes
-- (which are timestamped progress updates).
-- ============================================================================

alter table public.tasks
  add column if not exists description text;
