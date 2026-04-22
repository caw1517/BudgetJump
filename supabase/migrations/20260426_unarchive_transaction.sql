create or replace function public.unarchive_transaction(
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
begin
  select amount_cents, envelope_id, account_id
  into v_amount, v_envelope_id, v_account_id
  from public.transactions
  where id = p_transaction_id
    and archived = true
  for update;

  if not found then
    raise exception 'Archived transaction not found.';
  end if;

  if v_envelope_id is not null then
    update public.envelopes
    set balance_cents = balance_cents - v_amount
    where id = v_envelope_id;
  end if;

  if v_account_id is not null then
    update public.financial_accounts
    set balance_cents = balance_cents - v_amount
    where id = v_account_id;
  end if;

  update public.transactions
  set archived = false
  where id = p_transaction_id;
end;
$$;
