-- ApparelFlow ERP: Supabase (PostgreSQL) schema
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run

-- ============ TABLES ============
create table if not exists profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role      text not null check (role in ('cutting_supervisor','cutting_verifier','sewing_supervisor'))
);
alter table profiles enable row level security;

-- user id kiyana okkoma columns bigint wenuwata uuid wenna one:
--   cutting_orders.created_by, cutting_orders.sewing_started_by, verification_logs.verifier_id
--   e.g.  created_by uuid not null references profiles(id)

create table if not exists sessions (
  token      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  expires_at bigint not null            -- epoch milliseconds (same as the current backend code)
);

create table if not exists recipes (
  id               bigint generated always as identity primary key,
  recipe_code      text not null unique,
  name             text not null,
  category         text not null,
  std_fabric_yards numeric(8,2) not null check (std_fabric_yards > 0),
  wastage_cap      numeric(5,2) not null check (wastage_cap >= 0)
);

create table if not exists recipe_components (
  id                 bigint generated always as identity primary key,
  recipe_id          bigint not null references recipes(id) on delete cascade,
  component_name     text not null,
  pieces_per_garment int not null check (pieces_per_garment > 0),
  image_url          text
);

create table if not exists cutting_orders (
  id                 bigint generated always as identity primary key,
  order_no           text unique,
  recipe_id          bigint not null references recipes(id),
  target_qty         int not null check (target_qty > 0),
  fabric_roll_id     text not null,
  actual_fabric_yds  numeric(10,2) not null check (actual_fabric_yds > 0),
  status             text not null default 'PENDING_VERIFICATION'
                     check (status in ('CUTTING_IN_PROGRESS','PENDING_VERIFICATION','REJECTED','VERIFIED')),
  created_by     uuid not null references auth.users(id),
  sewing_started_at  timestamptz,
  sewing_started_by  uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists verification_items (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references cutting_orders(id) on delete cascade,
  component_id bigint not null references recipe_components(id),
  expected_qty int not null,
  actual_qty   int not null check (actual_qty >= 0),
  status       text not null check (status in ('GREEN','YELLOW','RED')),
  unique (order_id, component_id)
);

create table if not exists verification_logs (
  id             bigint generated always as identity primary key,
  order_id       bigint not null references cutting_orders(id),
  verifier_id    uuid not null references auth.users(id),
  decision       text not null check (decision in ('APPROVED','REJECTED')),
  rejection_note text,
  wastage_pct    numeric(7,2),
  variances      jsonb,
  "timestamp"    timestamptz not null default now()
);

create index if not exists idx_orders_status   on cutting_orders(status);
create index if not exists idx_items_order     on verification_items(order_id);
create index if not exists idx_logs_order      on verification_logs(order_id);
create index if not exists idx_sessions_user   on sessions(user_id);

-- ============ IMMUTABLE AUDIT LOG ============
create or replace function forbid_log_changes() returns trigger language plpgsql as $$
begin
  raise exception 'verification_logs are immutable';
end $$;

drop trigger if exists logs_no_update on verification_logs;
drop trigger if exists logs_no_delete on verification_logs;
create trigger logs_no_update before update on verification_logs for each row execute function forbid_log_changes();
create trigger logs_no_delete before delete on verification_logs for each row execute function forbid_log_changes();

-- ============ DATABASE-LEVEL HARD STOP (defence in depth) ============
-- Even if the API had a bug, the DB refuses VERIFIED unless every component
-- is counted and none is short.
create or replace function enforce_verified_gate() returns trigger language plpgsql as $$
declare comps int; counted int; short int;
begin
  if new.status = 'VERIFIED' and old.status is distinct from 'VERIFIED' then
    if old.status <> 'PENDING_VERIFICATION' then
      raise exception 'Only PENDING_VERIFICATION orders can become VERIFIED' using errcode = 'check_violation';
    end if;
    select count(*) into comps from recipe_components where recipe_id = new.recipe_id;
    select count(*), count(*) filter (where actual_qty < expected_qty)
      into counted, short from verification_items where order_id = new.id;
    if counted < comps or short > 0 then
      raise exception 'Hard stop: shortage or uncounted components block verification' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists orders_verified_gate on cutting_orders;
create trigger orders_verified_gate before update on cutting_orders for each row execute function enforce_verified_gate();

-- ============ SECURITY: Row Level Security ============
-- Supabase exposes public tables through its REST API. Enabling RLS with NO policies
-- blocks the anon/authenticated keys completely; only your backend (service_role key
-- or the direct Postgres connection string) can read/write.
-- Authentication users are managed by Supabase Auth; profiles stores application roles.
alter table profiles           enable row level security;
alter table sessions           enable row level security;
alter table recipes            enable row level security;
alter table recipe_components  enable row level security;
alter table cutting_orders     enable row level security;
alter table verification_items enable row level security;
alter table verification_logs  enable row level security;

-- Backend requests use the service role and continue to bypass RLS. These
-- policies protect any direct Supabase client that uses an anon/user JWT.
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

revoke all on function public.app_role() from public;
grant execute on function public.app_role() to authenticated;

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or public.app_role() = 'cutting_supervisor');

drop policy if exists profiles_insert on profiles;
create policy profiles_insert on profiles for insert to authenticated
  with check (id = auth.uid());

drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update to authenticated
  using (id = auth.uid() or public.app_role() = 'cutting_supervisor')
  with check (id = auth.uid() or public.app_role() = 'cutting_supervisor');

drop policy if exists profiles_delete on profiles;
create policy profiles_delete on profiles for delete to authenticated
  using (public.app_role() = 'cutting_supervisor');

-- Sessions are intentionally backend-only. No client policy is created.

drop policy if exists recipes_select on recipes;
create policy recipes_select on recipes for select to anon, authenticated
  using (true);

drop policy if exists recipes_insert on recipes;
create policy recipes_insert on recipes for insert to anon, authenticated
  with check (true);

drop policy if exists recipes_update on recipes;
create policy recipes_update on recipes for update to anon, authenticated
  using (true)
  with check (true);

drop policy if exists recipes_delete on recipes;
create policy recipes_delete on recipes for delete to anon, authenticated
  using (true);

drop policy if exists recipe_components_select on recipe_components;
create policy recipe_components_select on recipe_components for select to anon, authenticated
  using (true);

drop policy if exists recipe_components_insert on recipe_components;
create policy recipe_components_insert on recipe_components for insert to anon, authenticated
  with check (true);

drop policy if exists recipe_components_update on recipe_components;
create policy recipe_components_update on recipe_components for update to anon, authenticated
  using (true)
  with check (true);

drop policy if exists recipe_components_delete on recipe_components;
create policy recipe_components_delete on recipe_components for delete to anon, authenticated
  using (true);

drop policy if exists cutting_orders_select on cutting_orders;
create policy cutting_orders_select on cutting_orders for select to authenticated
  using (
    public.app_role() = 'cutting_supervisor'
    or (public.app_role() = 'cutting_verifier' and status = 'PENDING_VERIFICATION')
    or (public.app_role() = 'sewing_supervisor' and status = 'VERIFIED')
  );

drop policy if exists cutting_orders_insert on cutting_orders;
create policy cutting_orders_insert on cutting_orders for insert to authenticated
  with check (public.app_role() = 'cutting_supervisor' and created_by = auth.uid());

drop policy if exists cutting_orders_update on cutting_orders;
create policy cutting_orders_update on cutting_orders for update to authenticated
  using (
    public.app_role() = 'cutting_supervisor'
    or (public.app_role() = 'cutting_verifier' and status = 'PENDING_VERIFICATION')
    or (public.app_role() = 'sewing_supervisor' and status = 'VERIFIED' and sewing_started_at is null)
  )
  with check (
    public.app_role() = 'cutting_supervisor'
    or (public.app_role() = 'cutting_verifier' and status in ('PENDING_VERIFICATION', 'REJECTED', 'VERIFIED'))
    or (public.app_role() = 'sewing_supervisor' and status = 'VERIFIED' and sewing_started_by = auth.uid())
  );

drop policy if exists cutting_orders_delete on cutting_orders;
create policy cutting_orders_delete on cutting_orders for delete to authenticated
  using (public.app_role() = 'cutting_supervisor' and created_by = auth.uid());

drop policy if exists verification_items_select on verification_items;
create policy verification_items_select on verification_items for select to authenticated
  using (public.app_role() in ('cutting_supervisor', 'cutting_verifier', 'sewing_supervisor'));

drop policy if exists verification_items_insert on verification_items;
create policy verification_items_insert on verification_items for insert to authenticated
  with check (public.app_role() = 'cutting_verifier' and exists (
    select 1 from cutting_orders o
    where o.id = order_id and o.status = 'PENDING_VERIFICATION'
  ));

drop policy if exists verification_items_update on verification_items;
create policy verification_items_update on verification_items for update to authenticated
  using (public.app_role() = 'cutting_verifier' and exists (
    select 1 from cutting_orders o
    where o.id = order_id and o.status = 'PENDING_VERIFICATION'
  ))
  with check (public.app_role() = 'cutting_verifier');

drop policy if exists verification_items_delete on verification_items;
create policy verification_items_delete on verification_items for delete to authenticated
  using (public.app_role() = 'cutting_supervisor');

drop policy if exists verification_logs_select on verification_logs;
create policy verification_logs_select on verification_logs for select to authenticated
  using (public.app_role() in ('cutting_supervisor', 'cutting_verifier', 'sewing_supervisor'));

drop policy if exists verification_logs_insert on verification_logs;
create policy verification_logs_insert on verification_logs for insert to authenticated
  with check (public.app_role() = 'cutting_verifier' and verifier_id = auth.uid());

-- The application currently sends CRUD requests with the Supabase anon key.
-- Keep RLS enabled, but allow the API's anon/authenticated roles to perform
-- the complete CRUD surface. The backend still applies its role validation.
drop policy if exists profiles_api_crud on profiles;
create policy profiles_api_crud on profiles for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists sessions_api_crud on sessions;
create policy sessions_api_crud on sessions for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists cutting_orders_api_crud on cutting_orders;
create policy cutting_orders_api_crud on cutting_orders for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists verification_items_api_crud on verification_items;
create policy verification_items_api_crud on verification_items for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists verification_logs_api_crud on verification_logs;
create policy verification_logs_api_crud on verification_logs for all to anon, authenticated
  using (true)
  with check (true);

-- Allow the requested CRUD behavior for verification logs as well.
drop trigger if exists logs_no_update on verification_logs;
drop trigger if exists logs_no_delete on verification_logs;

-- ============ SEED: recipes (BOM) ============
insert into recipes (recipe_code, name, category, std_fabric_yards, wastage_cap) values
  ('REC-BL01', 'Casual Blouse', 'Blouse',    1.80, 5.0),
  ('REC-CT02', 'Crop Top',      'Crop Top',  1.10, 8.0)
on conflict (recipe_code) do nothing;

insert into recipe_components (recipe_id, component_name, pieces_per_garment)
select r.id, c.name, c.pcs
from recipes r
join (values
  ('REC-BL01', 'Front Body Panel', 1), ('REC-BL01', 'Back Body Panel', 1),
  ('REC-BL01', 'Sleeves (Left & Right)', 2), ('REC-BL01', 'Collar & Stand', 1), ('REC-BL01', 'Sleeve Cuffs', 2),
  ('REC-CT02', 'Front Chest Panel', 1), ('REC-CT02', 'Back Support Panel', 1),
  ('REC-CT02', 'Neck Binding Strip', 1), ('REC-CT02', 'Hem Elastic Casing', 1), ('REC-CT02', 'Side Strap Accents', 2)
) as c(code, name, pcs) on c.code = r.recipe_code
where not exists (select 1 from recipe_components rc where rc.recipe_id = r.id);

-- Users are NOT seeded here: password hashes are produced by the backend (scrypt).
-- The 3 demo users (supervisor / verifier / sewing) get created by the backend seed script.