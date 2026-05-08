-- ============================================================================
-- kitchen-crm schema (Supabase / PostgreSQL)
-- Apply via: Supabase Dashboard → SQL Editor → New query → paste → Run
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Profiles (extends auth.users with name + role)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'sales'
    check (role in ('admin','sales','production','installation','service')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Customers
-- ----------------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  general_address text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

-- ----------------------------------------------------------------------------
-- Projects
-- ----------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  address text,
  source text,
  assigned_to uuid references public.profiles(id) on delete set null,
  stage text not null default 'lead'
    check (stage in ('lead','quoted','dealClosed','deposit','specSigned','production','delivery','installed','stone','completed')),
  tracking_token text not null unique default encode(gen_random_bytes(12), 'hex'),

  -- Quote
  quote_amount numeric,
  quote_sent_at timestamptz,
  quote_valid_until timestamptz,
  quote_approved_at timestamptz,

  -- Deposit
  deposit_amount numeric,
  deposit_received_at timestamptz,

  -- Spec (kitchen + stone + accessories)
  spec jsonb not null default '{
    "kitchen": {"layout":"","cabinets":"","finish":"","color":"","dimensions":"","notes":""},
    "stone":   {"required": false, "type":"", "edge":"", "notes":""},
    "handles":"","appliances":"","otherAccessories":""
  }'::jsonb,

  -- Schedule
  schedule_production_start date,
  schedule_delivery_date date,
  schedule_install_date date,
  schedule_stone_date date,
  signed_spec_at timestamptz,

  -- Sub-products (array of {name, qty, notes})
  sub_products jsonb not null default '[]'::jsonb,

  -- Service tickets (array of {id, issue, resolved, opened_at, from_customer})
  service_tickets jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Tasks
-- ----------------------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  project_id uuid references public.projects(id) on delete cascade,
  assigned_to uuid references public.profiles(id) on delete set null,
  due_date date,
  priority text not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  completed boolean not null default false,
  completed_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Files (links only — Drive / Dropbox / etc)
-- ----------------------------------------------------------------------------
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  url text not null,
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Activity log
-- ----------------------------------------------------------------------------
create table if not exists public.activity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
create index if not exists idx_projects_customer    on public.projects (customer_id);
create index if not exists idx_projects_stage       on public.projects (stage);
create index if not exists idx_projects_assigned    on public.projects (assigned_to);
create index if not exists idx_projects_token       on public.projects (tracking_token);
create index if not exists idx_tasks_project        on public.tasks (project_id);
create index if not exists idx_tasks_assigned       on public.tasks (assigned_to);
create index if not exists idx_tasks_open_due       on public.tasks (completed, due_date);
create index if not exists idx_files_project        on public.files (project_id);
create index if not exists idx_activity_project_at  on public.activity (project_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Auth trigger: auto-create profile on user signup
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, role, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'sales'),
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Helper functions for RLS
-- ----------------------------------------------------------------------------
create or replace function public.current_role_id()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and active;
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

-- ----------------------------------------------------------------------------
-- RLS: enable on all tables
-- ----------------------------------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.customers enable row level security;
alter table public.projects  enable row level security;
alter table public.tasks     enable row level security;
alter table public.files     enable row level security;
alter table public.activity  enable row level security;

-- ----------------------------------------------------------------------------
-- RLS policies — Profiles
-- ----------------------------------------------------------------------------
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "profiles_admin_all" on public.profiles;
create policy "profiles_admin_all" on public.profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- RLS policies — Customers
-- ----------------------------------------------------------------------------
drop policy if exists "customers_select_auth" on public.customers;
create policy "customers_select_auth" on public.customers
  for select to authenticated using (true);

drop policy if exists "customers_insert_sales_admin" on public.customers;
create policy "customers_insert_sales_admin" on public.customers
  for insert to authenticated
  with check (public.current_role_id() in ('admin','sales'));

drop policy if exists "customers_update_sales_admin" on public.customers;
create policy "customers_update_sales_admin" on public.customers
  for update to authenticated
  using (public.current_role_id() in ('admin','sales'));

drop policy if exists "customers_delete_admin" on public.customers;
create policy "customers_delete_admin" on public.customers
  for delete to authenticated using (public.is_admin());

-- ----------------------------------------------------------------------------
-- RLS policies — Projects
-- ----------------------------------------------------------------------------
drop policy if exists "projects_select_auth" on public.projects;
create policy "projects_select_auth" on public.projects
  for select to authenticated using (true);

drop policy if exists "projects_insert_sales_admin" on public.projects;
create policy "projects_insert_sales_admin" on public.projects
  for insert to authenticated
  with check (public.current_role_id() in ('admin','sales'));

drop policy if exists "projects_update_auth" on public.projects;
create policy "projects_update_auth" on public.projects
  for update to authenticated using (true);

drop policy if exists "projects_delete_admin" on public.projects;
create policy "projects_delete_admin" on public.projects
  for delete to authenticated using (public.is_admin());

-- ----------------------------------------------------------------------------
-- RLS policies — Tasks
-- ----------------------------------------------------------------------------
drop policy if exists "tasks_select_auth" on public.tasks;
create policy "tasks_select_auth" on public.tasks
  for select to authenticated using (true);

drop policy if exists "tasks_insert_auth" on public.tasks;
create policy "tasks_insert_auth" on public.tasks
  for insert to authenticated with check (true);

drop policy if exists "tasks_update_auth" on public.tasks;
create policy "tasks_update_auth" on public.tasks
  for update to authenticated using (true);

drop policy if exists "tasks_delete_auth" on public.tasks;
create policy "tasks_delete_auth" on public.tasks
  for delete to authenticated using (
    public.is_admin() or created_by = auth.uid() or assigned_to = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- RLS policies — Files
-- ----------------------------------------------------------------------------
drop policy if exists "files_select_auth" on public.files;
create policy "files_select_auth" on public.files
  for select to authenticated using (true);

drop policy if exists "files_insert_auth" on public.files;
create policy "files_insert_auth" on public.files
  for insert to authenticated with check (true);

drop policy if exists "files_delete_auth" on public.files;
create policy "files_delete_auth" on public.files
  for delete to authenticated using (
    public.is_admin() or added_by = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- RLS policies — Activity
-- ----------------------------------------------------------------------------
drop policy if exists "activity_select_auth" on public.activity;
create policy "activity_select_auth" on public.activity
  for select to authenticated using (true);

drop policy if exists "activity_insert_auth" on public.activity;
create policy "activity_insert_auth" on public.activity
  for insert to authenticated with check (true);

-- ----------------------------------------------------------------------------
-- Public tracking RPC (anonymous read by token)
-- Returns minimal project shape for the customer-facing tracking page.
-- ----------------------------------------------------------------------------
create or replace function public.get_project_by_token(token text)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id',                  p.id,
    'address',             p.address,
    'stage',               p.stage,
    'tracking_token',      p.tracking_token,
    'quote_sent_at',       p.quote_sent_at,
    'quote_approved_at',   p.quote_approved_at,
    'deposit_received_at', p.deposit_received_at,
    'signed_spec_at',      p.signed_spec_at,
    'spec_stone_required', (p.spec->'stone'->>'required')::boolean,
    'schedule_production_start', p.schedule_production_start,
    'schedule_delivery_date',    p.schedule_delivery_date,
    'schedule_install_date',     p.schedule_install_date,
    'schedule_stone_date',       p.schedule_stone_date,
    'created_at',          p.created_at,
    'customer_name',       c.name
  )
  from public.projects p
  join public.customers c on c.id = p.customer_id
  where p.tracking_token = token;
$$;

grant execute on function public.get_project_by_token(text) to anon, authenticated;

-- Public submit a service ticket via tracking token
create or replace function public.submit_service_ticket(token text, issue text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
  ticket jsonb;
begin
  select id into pid from public.projects where tracking_token = token;
  if pid is null then return false; end if;

  ticket := jsonb_build_object(
    'id',            gen_random_uuid()::text,
    'issue',         issue,
    'resolved',      false,
    'opened_at',     now(),
    'from_customer', true
  );

  update public.projects
    set service_tickets = service_tickets || ticket
    where id = pid;

  insert into public.activity (project_id, user_id, action)
  values (pid, null, 'Customer opened service ticket: ' || issue);

  return true;
end;
$$;

grant execute on function public.submit_service_ticket(text, text) to anon, authenticated;

-- Public approve spec via tracking token
create or replace function public.approve_spec_via_token(token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
begin
  select id into pid from public.projects
    where tracking_token = token and signed_spec_at is null;
  if pid is null then return false; end if;

  update public.projects
    set signed_spec_at = now(),
        stage = case when stage in ('lead','quoted','dealClosed','deposit') then 'specSigned' else stage end
    where id = pid;

  insert into public.activity (project_id, user_id, action)
  values (pid, null, 'Customer approved spec via tracking link');

  return true;
end;
$$;

grant execute on function public.approve_spec_via_token(text) to anon, authenticated;
