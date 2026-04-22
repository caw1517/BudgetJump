-- Ensure archive/unarchive always touch real rows (no silent skip) and are callable from the API.
-- Also set search_path for predictable resolution.

create or replace function public.archive_transaction(
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
  v_hit integer;
begin
  select amount_cents, envelope_id, account_id
  into v_amount, v_envelope_id, v_account_id
  from public.transactions
  where id = p_transaction_id
    and archived = false
  for update;

  if not found then
    raise exception 'Transaction not found or already archived.';
  end if;

  if v_envelope_id is not null then
    perform 1
    from public.envelopes
    where id = v_envelope_id
    for update;

    if not found then
      raise exception 'Cannot archive: linked envelope % no longer exists.', v_envelope_id;
    end if;

    update public.envelopes
    set balance_cents = balance_cents + v_amount
    where id = v_envelope_id
    returning 1 into v_hit;

    if v_hit is null then
      raise exception 'Cannot archive: envelope balance was not updated.';
    end if;
  end if;

  if v_account_id is not null then
    perform 1
    from public.financial_accounts
    where id = v_account_id
    for update;

    if not found then
      raise exception 'Cannot archive: linked account % no longer exists.', v_account_id;
    end if;

    update public.financial_accounts
    set balance_cents = balance_cents + v_amount
    where id = v_account_id
    returning 1 into v_hit;

    if v_hit is null then
      raise exception 'Cannot archive: account balance was not updated.';
    end if;
  end if;

  update public.transactions
  set archived = true
  where id = p_transaction_id;
end;
$$;

create or replace function public.unarchive_transaction(
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
  v_hit integer;
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
    perform 1
    from public.envelopes
    where id = v_envelope_id
    for update;

    if not found then
      raise exception 'Cannot restore: linked envelope % no longer exists.', v_envelope_id;
    end if;

    update public.envelopes
    set balance_cents = balance_cents - v_amount
    where id = v_envelope_id
    returning 1 into v_hit;

    if v_hit is null then
      raise exception 'Cannot restore: envelope balance was not updated.';
    end if;
  end if;

  if v_account_id is not null then
    perform 1
    from public.financial_accounts
    where id = v_account_id
    for update;

    if not found then
      raise exception 'Cannot restore: linked account % no longer exists.', v_account_id;
    end if;

    update public.financial_accounts
    set balance_cents = balance_cents - v_amount
    where id = v_account_id
    returning 1 into v_hit;

    if v_hit is null then
      raise exception 'Cannot restore: account balance was not updated.';
    end if;
  end if;

  update public.transactions
  set archived = false
  where id = p_transaction_id;
end;
$$;

grant execute on function public.archive_transaction(uuid) to authenticated;
grant execute on function public.archive_transaction(uuid) to service_role;
grant execute on function public.unarchive_transaction(uuid) to authenticated;
grant execute on function public.unarchive_transaction(uuid) to service_role;
