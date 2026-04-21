-- Opening balance for checking/savings: credit the deposit account and record a paycheck row
-- without envelope allocations, so the user assigns envelopes from the Journal.

create or replace function public.save_starting_balance_deposit(
  p_date date,
  p_net_amount_cents integer,
  p_notes text,
  p_deposit_account_id uuid
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_paycheck_id uuid;
begin
  if p_net_amount_cents <= 0 then
    raise exception 'Amount must be greater than zero.';
  end if;

  if p_deposit_account_id is null then
    raise exception 'Deposit account is required.';
  end if;

  perform 1
  from public.financial_accounts
  where id = p_deposit_account_id
    and archived = false
  for update;

  if not found then
    raise exception 'Deposit account not found or archived.';
  end if;

  insert into public.paychecks (date, source, net_amount_cents, notes, deposit_account_id)
  values (p_date, 'Starting balance', p_net_amount_cents, nullif(trim(p_notes), ''), p_deposit_account_id)
  returning id into v_paycheck_id;

  update public.financial_accounts
  set balance_cents = balance_cents + p_net_amount_cents
  where id = p_deposit_account_id;

  return v_paycheck_id;
end;
$$;
