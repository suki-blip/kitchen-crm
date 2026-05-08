-- ============================================================================
-- Migration 003: extend customer/project insert+update permissions to 'production' role
-- Apply via Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================================

-- Customers — insert + update for admin / sales / production
drop policy if exists "customers_insert_sales_admin"      on public.customers;
drop policy if exists "customers_insert_sales_prod_admin" on public.customers;
create policy "customers_insert_sales_prod_admin" on public.customers
  for insert to authenticated
  with check (public.current_role_id() in ('admin','sales','production'));

drop policy if exists "customers_update_sales_admin"      on public.customers;
drop policy if exists "customers_update_sales_prod_admin" on public.customers;
create policy "customers_update_sales_prod_admin" on public.customers
  for update to authenticated
  using (public.current_role_id() in ('admin','sales','production'));

-- Projects — insert for admin / sales / production
-- (update + delete already authorized at the right scope)
drop policy if exists "projects_insert_sales_admin"      on public.projects;
drop policy if exists "projects_insert_sales_prod_admin" on public.projects;
create policy "projects_insert_sales_prod_admin" on public.projects
  for insert to authenticated
  with check (public.current_role_id() in ('admin','sales','production'));
