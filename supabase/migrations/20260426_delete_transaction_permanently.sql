create or replace function public.delete_transaction_permanently(
  p_transaction_id uuid
)
returns void
language plpgsql
security invoker
as $$
declare
  v_amount integer;
  v_envelope_id uuid;
  v_account_id uuid;
  v_archived boolean;
begin
  select amount_cents, envelope_id, account_id, archived
  into v_amount, v_envelope_id, v_account_id, v_archived
  from public.transactions
  where id = p_transaction_id
  for update;

  if not found then
    raise exception 'Transaction not found.';
  end if;

  -- If still active, unwind balances before hard delete.
  if v_archived = false then
    update public.envelopes
    set balance_cents = balance_cents + v_amount
    where id = v_envelope_id;

    if v_account_id is not null then
      update public.financial_accounts
      set balance_cents = balance_cents + v_amount
      where id = v_account_id;
    end if;
  end if;

  delete from public.transactions
  where id = p_transaction_id;
end;
$$;
