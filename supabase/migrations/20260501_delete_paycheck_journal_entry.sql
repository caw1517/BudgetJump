create or replace function public.delete_paycheck_journal_entry(
  p_paycheck_id uuid
)
returns void
language plpgsql
security invoker
as $$
declare
  v_paycheck record;
  v_allocation record;
  v_move record;
begin
  select id, net_amount_cents, deposit_account_id
  into v_paycheck
  from public.paychecks
  where id = p_paycheck_id
  for update;

  if not found then
    raise exception 'Paycheck not found.';
  end if;

  for v_allocation in
    select envelope_id, amount_cents
    from public.paycheck_allocations
    where paycheck_id = p_paycheck_id
  loop
    update public.envelopes
    set balance_cents = balance_cents - v_allocation.amount_cents
    where id = v_allocation.envelope_id;
  end loop;

  for v_move in
    select from_envelope_id, to_envelope_id, amount_cents
    from public.paycheck_moves
    where paycheck_id = p_paycheck_id
  loop
    update public.envelopes
    set balance_cents = balance_cents + v_move.amount_cents
    where id = v_move.from_envelope_id;

    update public.envelopes
    set balance_cents = balance_cents - v_move.amount_cents
    where id = v_move.to_envelope_id;
  end loop;

  if v_paycheck.deposit_account_id is not null then
    update public.financial_accounts
    set balance_cents = balance_cents - v_paycheck.net_amount_cents
    where id = v_paycheck.deposit_account_id;
  end if;

  delete from public.paychecks
  where id = p_paycheck_id;
end;
$$;

grant execute on function public.delete_paycheck_journal_entry(uuid) to authenticated;
grant execute on function public.delete_paycheck_journal_entry(uuid) to service_role;
