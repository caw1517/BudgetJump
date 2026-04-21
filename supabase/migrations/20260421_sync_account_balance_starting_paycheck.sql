-- Keep checking/savings "Starting balance" paycheck in sync when account balance is manually adjusted.

create or replace function public.sync_account_balance_with_starting_paycheck(
  p_account_id uuid,
  p_new_balance_cents integer
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_balance integer;
  v_account_type text;
  v_paycheck_id uuid;
  v_old_starting integer;
  v_new_starting integer;
begin
  select balance_cents, account_type
  into v_old_balance, v_account_type
  from public.financial_accounts
  where id = p_account_id
    and archived = false
  for update;

  if not found then
    raise exception 'Account not found or archived.';
  end if;

  if v_account_type not in ('checking', 'savings') then
    update public.financial_accounts
    set balance_cents = p_new_balance_cents
    where id = p_account_id;
    return;
  end if;

  select id, net_amount_cents
  into v_paycheck_id, v_old_starting
  from public.paychecks
  where deposit_account_id = p_account_id
    and source = 'Starting balance'
  order by date asc, created_at asc
  limit 1
  for update;

  if not found then
    update public.financial_accounts
    set balance_cents = p_new_balance_cents
    where id = p_account_id;
    return;
  end if;

  v_new_starting := v_old_starting + (p_new_balance_cents - v_old_balance);
  if v_new_starting <= 0 then
    raise exception 'Adjusted starting-balance paycheck would be zero/negative. Use transactions to reduce further.';
  end if;

  update public.paychecks
  set net_amount_cents = v_new_starting
  where id = v_paycheck_id;

  update public.financial_accounts
  set balance_cents = p_new_balance_cents
  where id = p_account_id;
end;
$$;
