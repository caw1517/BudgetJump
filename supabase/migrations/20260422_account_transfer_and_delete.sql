-- Move cash between asset accounts (checking, savings, cash, other) without touching envelopes.
-- Permanently delete an account only when it has no activity.

create or replace function public.create_account_transfer(
  p_date date,
  p_amount_cents integer,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_note text default null,
  p_cleared boolean default true
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_out_id uuid;
  v_in_id uuid;
  v_from_name text;
  v_to_name text;
  v_from_type text;
  v_to_type text;
  v_from_balance integer;
begin
  if p_amount_cents <= 0 then
    raise exception 'Transfer amount must be greater than zero.';
  end if;
  if p_from_account_id = p_to_account_id then
    raise exception 'From and to accounts must be different.';
  end if;

  select name, account_type, balance_cents
  into v_from_name, v_from_type, v_from_balance
  from public.financial_accounts
  where id = p_from_account_id and archived = false
  for update;
  if not found then
    raise exception 'From account not found.';
  end if;

  select name, account_type into v_to_name, v_to_type
  from public.financial_accounts
  where id = p_to_account_id and archived = false
  for update;
  if not found then
    raise exception 'To account not found.';
  end if;

  if v_from_type in ('credit_card', 'debt') or v_to_type in ('credit_card', 'debt') then
    raise exception 'Use card/debt payment for liabilities. Transfers are only between checking, savings, cash, and other.';
  end if;

  if v_from_balance < p_amount_cents then
    raise exception 'From account balance is less than the transfer amount.';
  end if;

  v_out_id := public.create_manual_transaction(
    p_date,
    'Transfer to ' || v_to_name,
    p_amount_cents,
    null,
    p_note,
    p_cleared,
    'manual',
    p_from_account_id,
    'transfer'
  );

  v_in_id := public.create_manual_transaction(
    p_date,
    'Transfer from ' || v_from_name,
    -p_amount_cents,
    null,
    p_note,
    p_cleared,
    'manual',
    p_to_account_id,
    'transfer'
  );

  return jsonb_build_object(
    'out_transaction_id', v_out_id,
    'in_transaction_id', v_in_id
  );
end;
$$;

create or replace function public.delete_financial_account(p_account_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_balance integer;
begin
  select balance_cents
  into v_balance
  from public.financial_accounts
  where id = p_account_id
    and archived = false
  for update;

  if not found then
    raise exception 'Account not found or already removed.';
  end if;

  if v_balance <> 0 then
    raise exception 'Account balance must be exactly zero before it can be deleted.';
  end if;

  if exists (
    select 1
    from public.transactions
    where account_id = p_account_id
      and archived = false
  ) then
    raise exception 'Archive or remove all transactions linked to this account first.';
  end if;

  if exists (
    select 1
    from public.paychecks
    where deposit_account_id = p_account_id
  ) then
    raise exception 'Delete or edit paychecks that deposit to this account first.';
  end if;

  delete from public.financial_accounts
  where id = p_account_id;
end;
$$;
