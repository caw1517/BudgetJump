create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.envelope_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_envelope_groups_updated_at
before update on public.envelope_groups
for each row
execute function public.set_updated_at();

create table if not exists public.envelopes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('expense', 'savings', 'debt')),
  budget_target_cents integer not null default 0 check (budget_target_cents >= 0),
  balance_cents integer not null default 0,
  color text not null default '#10b981',
  icon text,
  sort_order integer not null default 0,
  archived boolean not null default false,
  group_id uuid references public.envelope_groups(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_envelopes_group_id on public.envelopes(group_id);
create index if not exists idx_envelopes_sort_order on public.envelopes(sort_order);

create trigger trg_envelopes_updated_at
before update on public.envelopes
for each row
execute function public.set_updated_at();

alter table public.envelope_groups enable row level security;
alter table public.envelopes enable row level security;

drop policy if exists "authenticated envelope_groups access" on public.envelope_groups;
create policy "authenticated envelope_groups access"
on public.envelope_groups
for all
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated envelopes access" on public.envelopes;
create policy "authenticated envelopes access"
on public.envelopes
for all
to authenticated
using (true)
with check (true);
