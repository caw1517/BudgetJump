create table if not exists public.paychecks (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  source text not null,
  gross_amount_cents integer not null default 0 check (gross_amount_cents >= 0),
  net_amount_cents integer not null check (net_amount_cents > 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_paychecks_updated_at on public.paychecks;
create trigger trg_paychecks_updated_at
before update on public.paychecks
for each row
execute function public.set_updated_at();

create table if not exists public.paycheck_allocations (
  id uuid primary key default gen_random_uuid(),
  paycheck_id uuid not null references public.paychecks(id) on delete cascade,
  envelope_id uuid not null references public.envelopes(id) on delete restrict,
  amount_cents integer not null check (amount_cents >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_paycheck_allocations_paycheck_id on public.paycheck_allocations(paycheck_id);
create index if not exists idx_paycheck_allocations_envelope_id on public.paycheck_allocations(envelope_id);

create table if not exists public.paycheck_moves (
  id uuid primary key default gen_random_uuid(),
  paycheck_id uuid not null references public.paychecks(id) on delete cascade,
  from_envelope_id uuid not null references public.envelopes(id) on delete restrict,
  to_envelope_id uuid not null references public.envelopes(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_paycheck_moves_paycheck_id on public.paycheck_moves(paycheck_id);

alter table public.paychecks enable row level security;
alter table public.paycheck_allocations enable row level security;
alter table public.paycheck_moves enable row level security;

drop policy if exists "authenticated paychecks access" on public.paychecks;
create policy "authenticated paychecks access"
on public.paychecks
for all
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated paycheck_allocations access" on public.paycheck_allocations;
create policy "authenticated paycheck_allocations access"
on public.paycheck_allocations
for all
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated paycheck_moves access" on public.paycheck_moves;
create policy "authenticated paycheck_moves access"
on public.paycheck_moves
for all
to authenticated
using (true)
with check (true);

create or replace function public.save_paycheck_journal_entry(
  p_date date,
  p_source text,
  p_gross_amount_cents integer,
  p_net_amount_cents integer,
  p_notes text,
  p_allocations jsonb,
  p_moves jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_paycheck_id uuid;
  v_sum_allocations integer := 0;
  v_item jsonb;
  v_envelope_id uuid;
  v_amount integer;
  v_from_envelope_id uuid;
  v_to_envelope_id uuid;
begin
  if p_net_amount_cents <= 0 then
    raise exception 'Net paycheck amount must be greater than zero.';
  end if;

  if p_gross_amount_cents < 0 then
    raise exception 'Gross paycheck amount cannot be negative.';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_envelope_id := (v_item ->> 'envelope_id')::uuid;
    v_amount := coalesce((v_item ->> 'amount_cents')::integer, 0);
    if v_amount < 0 then
      raise exception 'Allocation amount cannot be negative.';
    end if;
    v_sum_allocations := v_sum_allocations + v_amount;
  end loop;

  if v_sum_allocations <> p_net_amount_cents then
    raise exception 'Allocation sum (%) must equal net amount (%).', v_sum_allocations, p_net_amount_cents;
  end if;

  insert into public.paychecks (date, source, gross_amount_cents, net_amount_cents, notes)
  values (p_date, trim(p_source), p_gross_amount_cents, p_net_amount_cents, nullif(trim(p_notes), ''))
  returning id into v_paycheck_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_envelope_id := (v_item ->> 'envelope_id')::uuid;
    v_amount := coalesce((v_item ->> 'amount_cents')::integer, 0);
    if v_amount = 0 then
      continue;
    end if;

    perform 1 from public.envelopes where id = v_envelope_id and archived = false for update;
    if not found then
      raise exception 'Envelope not found or archived.';
    end if;

    insert into public.paycheck_allocations (paycheck_id, envelope_id, amount_cents)
    values (v_paycheck_id, v_envelope_id, v_amount);

    update public.envelopes
    set balance_cents = balance_cents + v_amount
    where id = v_envelope_id;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb))
  loop
    v_from_envelope_id := (v_item ->> 'from_envelope_id')::uuid;
    v_to_envelope_id := (v_item ->> 'to_envelope_id')::uuid;
    v_amount := coalesce((v_item ->> 'amount_cents')::integer, 0);
    if v_amount <= 0 then
      continue;
    end if;
    if v_from_envelope_id = v_to_envelope_id then
      raise exception 'Move source and destination must be different.';
    end if;

    perform 1 from public.envelopes where id = v_from_envelope_id and archived = false for update;
    if not found then
      raise exception 'Move source envelope not found.';
    end if;

    perform 1 from public.envelopes where id = v_to_envelope_id and archived = false for update;
    if not found then
      raise exception 'Move destination envelope not found.';
    end if;

    if (select balance_cents from public.envelopes where id = v_from_envelope_id) < v_amount then
      raise exception 'Insufficient balance in move source envelope.';
    end if;

    update public.envelopes
    set balance_cents = balance_cents - v_amount
    where id = v_from_envelope_id;

    update public.envelopes
    set balance_cents = balance_cents + v_amount
    where id = v_to_envelope_id;

    insert into public.paycheck_moves (paycheck_id, from_envelope_id, to_envelope_id, amount_cents, reason)
    values (v_paycheck_id, v_from_envelope_id, v_to_envelope_id, v_amount, nullif(trim(v_item ->> 'reason'), ''));
  end loop;

  return v_paycheck_id;
end;
$$;
