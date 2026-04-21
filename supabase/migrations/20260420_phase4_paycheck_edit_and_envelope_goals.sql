alter table public.envelopes
add column if not exists goal_type text check (goal_type in ('assign_monthly', 'refill_up_to')),
add column if not exists goal_target_cents integer check (goal_target_cents >= 0);

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

  -- Reverse old allocations from envelope balances.
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

    insert into public.paycheck_allocations (paycheck_id, envelope_id, amount_cents)
    values (p_paycheck_id, v_envelope_id, v_amount);

    update public.envelopes
    set balance_cents = balance_cents + v_amount
    where id = v_envelope_id;
  end loop;
end;
$$;
