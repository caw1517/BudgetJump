-- Create first, then GRANT (GRANT before CREATE fails on DBs that never had this function).
-- Mirror archive_transaction null-handling; fixed search_path for predictable resolution.
create or replace function public.delete_transaction_permanently(
  p_transaction_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
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

  -- If still active, unwind balances before hard delete (archived rows were already unwound).
  if v_archived = false then
    if v_envelope_id is not null then
      update public.envelopes
      set balance_cents = balance_cents + v_amount
      where id = v_envelope_id;
    end if;

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

grant execute on function public.delete_transaction_permanently(uuid) to authenticated;
grant execute on function public.delete_transaction_permanently(uuid) to service_role;
grant execute on function public.unarchive_transaction(uuid) to authenticated;
grant execute on function public.unarchive_transaction(uuid) to service_role;
