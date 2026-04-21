alter table public.paycheck_allocations
add column if not exists allocation_month date;

update public.paycheck_allocations pa
set allocation_month = date_trunc('month', p.date)::date
from public.paychecks p
where pa.paycheck_id = p.id
  and pa.allocation_month is null;

alter table public.paycheck_allocations
alter column allocation_month set not null;

create index if not exists idx_paycheck_allocations_allocation_month
on public.paycheck_allocations(allocation_month);

create or replace function public.save_paycheck_journal_entry(
  p_date date,
  p_source text,
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
  v_allocation_month date;
begin
  if p_net_amount_cents <= 0 then
    raise exception 'Net paycheck amount must be greater than zero.';
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

  insert into public.paychecks (date, source, net_amount_cents, notes)
  values (p_date, trim(p_source), p_net_amount_cents, nullif(trim(p_notes), ''))
  returning id into v_paycheck_id;

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
  p_allocations jsonb
)
returns void
language plpgsql
security invoker
as $$
declare
  v_item jsonb;
  v_envelope_id uuid;
  v_amount integer;
  v_allocation_month date;
  v_sum_allocations integer := 0;
  v_old record;
begin
  if p_net_amount_cents <= 0 then
    raise exception 'Net paycheck amount must be greater than zero.';
  end if;

  perform 1
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

  update public.paychecks
  set
    date = p_date,
    source = trim(p_source),
    net_amount_cents = p_net_amount_cents,
    notes = nullif(trim(p_notes), '')
  where id = p_paycheck_id;

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
