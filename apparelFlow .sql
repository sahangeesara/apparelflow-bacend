-- ApparelFlow ERP: Supabase (PostgreSQL) schema
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run

-- ============ TABLES ============
create table if not exists profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role      text not null check (role in ('cutting_supervisor','cutting_verifier','sewing_supervisor'))
);
alter table profiles enable row level security;   -- policies nehe: client walata role wenas karanna denne nehe

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