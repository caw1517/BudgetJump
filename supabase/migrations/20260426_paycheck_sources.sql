-- Saved paycheck sources (name + expected net per paycheck) and optional link from paycheck rows.

create table if not exists public.paycheck_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  expected_amount_cents integer not null default 0 check (expected_amount_cents >= 0),
  sort_order integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_paycheck_sources_archived_sort on public.paycheck_sources (archived, sort_order, name);

drop trigger if exists trg_paycheck_sources_updated_at on public.paycheck_sources;
create trigger trg_paycheck_sources_updated_at
before update on public.paycheck_sources
for each row
execute function public.set_updated_at();

alter table public.paycheck_sources enable row level security;

drop policy if exists "authenticated paycheck_sources access" on public.paycheck_sources;
create policy "authenticated paycheck_sources access"
on public.paycheck_sources
for all
to authenticated
using (true)
with check (true);

alter table public.paychecks
add column if not exists source_id uuid references public.paycheck_sources(id) on delete set null;

create index if not exists idx_paychecks_source_id on public.paychecks(source_id);

create or replace function public.save_paycheck_journal_entry(
  p_date date,
  p_source text,
  p_net_amount_cents integer,
  p_notes text,
  p_allocations jsonb,
  p_deposit_account_id uuid,
  p_moves jsonb default '[]'::jsonb,
  p_source_id uuid default null
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
  v_allocation_month date;
begin
  if p_net_amount_cents <= 0 then
    raise exception 'Net paycheck amount must be greater than zero.';
  end if;

  if p_deposit_account_id is null then
    raise exception 'Deposit account is required.';
  end if;

  if p_source_id is not null then
    perform 1
    from public.paycheck_sources
    where id = p_source_id;

    if not found then
      raise exception 'Paycheck source not found.';
    end if;
  end if;

  perform 1
  from public.financial_accounts
  where id = p_deposit_account_id
    and archived = false
  for update;

  if not found then
    raise exception 'Deposit account not found or archived.';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_amount := coalesce((v_item ->> 'amount_cents')::integer, 0);
    if v_amount < 0 then
      raise exception 'Allocation amount cannot be negative.';
    end if;
    v_sum_allocations := v_sum_allocations + v_amount;
  end loop;

  if v_sum_allocations <> p_net_amount_cents then
    raise exception 'Allocation sum (%) must equal net amount (%).', v_sum_allocations, p_net_amount_cents;
  end if;

  insert into public.paychecks (date, source, net_amount_cents, notes, deposit_account_id, source_id)
  values (p_date, trim(p_source), p_net_amount_cents, nullif(trim(p_notes), ''), p_deposit_account_id, p_source_id)
  returning id into v_paycheck_id;

  update public.financial_accounts
  set balance_cents = balance_cents + p_net_amount_cents
  where id = p_deposit_account_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_envelope_id := (v_item ->> 'envelope_id')::uuid;
    v_amount := coalesce((v_item ->> 'amount_cents')::integer, 0);
    v_allocation_month := coalesce((v_item ->> 'allocation_month')::date, date_trunc('month', p_date)::date);
    if v_amount = 0 then
      continue;
    end if;

    perform 1 from public.envelopes where id = v_envelope_id and archived = false for update;
    if not found then
      raise exception 'Envelope not found or archived.';
    end if;

    insert into public.paycheck_allocations (paycheck_id, envelope_id, amount_cents, allocation_month)
    values (v_paycheck_id, v_envelope_id, v_amount, date_trunc('month', v_allocation_month)::date);

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

create or replace function public.update_paycheck_journal_entry(
  p_paycheck_id uuid,
  p_date date,
  p_source text,
  p_net_amount_cents integer,
  p_notes text,
  p_allocations jsonb,
  p_deposit_account_id uuid,
  p_source_id uuid default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_item jsonb;
  v_envelope_id uuid;
  v_amount integer;
  v_sum_allocations integer := 0;
  v_old record;
  v_allocation_month date;
  v_old_net integer;
  v_old_deposit_account_id uuid;
begin
  if p_net_amount_cents <= 0 then
    raise exception 'Net paycheck amount must be greater than zero.';
  end if;

  if p_deposit_account_id is null then
    raise exception 'Deposit account is required.';
  end if;

  if p_source_id is not null then
    perform 1
    from public.paycheck_sources
    where id = p_source_id;

    if not found then
      raise exception 'Paycheck source not found.';
    end if;
  end if;

  select net_amount_cents, deposit_account_id
  into v_old_net, v_old_deposit_account_id
  from public.paychecks
  where id = p_paycheck_id
  for update;

  if not found then
    raise exception 'Paycheck not found.';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_amount := coalesce((v_item ->> 'amount_cents')::integer, 0);
    if v_amount < 0 then
      raise exception 'Allocation amount cannot be negative.';
    end if;
    v_sum_allocations := v_sum_allocations + v_amount;
  end loop;

  if v_sum_allocations <> p_net_amount_cents then
    raise exception 'Allocation sum (%) must equal net amount (%).', v_sum_allocations, p_net_amount_cents;
  end if;

  perform 1
  from public.financial_accounts
  where id = p_deposit_account_id
    and archived = false
  for update;

  if not found then
    raise exception 'Deposit account not found or archived.';
  end if;

  for v_old in
    select envelope_id, amount_cents
    from public.paycheck_allocations
    where paycheck_id = p_paycheck_id
  loop
    update public.envelopes
    set balance_cents = balance_cents - v_old.amount_cents
    where id = v_old.envelope_id;
  end loop;

  delete from public.paycheck_allocations
  where paycheck_id = p_paycheck_id;

  if v_old_deposit_account_id is not null then
    perform 1
    from public.financial_accounts
    where id = v_old_deposit_account_id
      and archived = false
    for update;

    if found then
      update public.financial_accounts
      set balance_cents = balance_cents - v_old_net
      where id = v_old_deposit_account_id;
    end if;
  end if;

  update public.paychecks
  set
    date = p_date,
    source = trim(p_source),
    net_amount_cents = p_net_amount_cents,
    notes = nullif(trim(p_notes), ''),
    deposit_account_id = p_deposit_account_id,
    source_id = p_source_id
  where id = p_paycheck_id;

  update public.financial_accounts
  set balance_cents = balance_cents + p_net_amount_cents
  where id = p_deposit_account_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_envelope_id := (v_item ->> 'envelope_id')::uuid;
    v_amount := coalesce((v_item ->> 'amount_cents')::integer, 0);
    v_allocation_month := coalesce((v_item ->> 'allocation_month')::date, date_trunc('month', p_date)::date);
    if v_amount = 0 then
      continue;
    end if;

    perform 1
    from public.envelopes
    where id = v_envelope_id
      and archived = false
    for update;
    if not found then
      raise exception 'Envelope not found or archived.';
    end if;

    insert into public.paycheck_allocations (paycheck_id, envelope_id, amount_cents, allocation_month)
    values (p_paycheck_id, v_envelope_id, v_amount, date_trunc('month', v_allocation_month)::date);

    update public.envelopes
    set balance_cents = balance_cents + v_amount
    where id = v_envelope_id;
  end loop;
end;
$$;
