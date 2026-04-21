alter table public.transactions
drop constraint if exists transactions_amount_cents_check;

alter table public.transactions
add constraint transactions_amount_cents_check
check (amount_cents <> 0);

create or replace function public.create_manual_transaction(
  p_date date,
  p_payee text,
  p_amount_cents integer,
  p_envelope_id uuid,
  p_note text default null,
  p_cleared boolean default false,
  p_import_source text default 'manual',
  p_account_id uuid default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_transaction_id uuid;
begin
  if p_amount_cents = 0 then
    raise exception 'Amount cannot be zero.';
  end if;
  if p_import_source not in ('manual', 'chase_csv') then
    raise exception 'Invalid import source.';
  end if;
  if p_account_id is not null then
    perform 1 from public.financial_accounts where id = p_account_id and archived = false for update;
    if not found then
      raise exception 'Account not found or archived.';
    end if;
  end if;

  perform 1
  from public.envelopes
  where id = p_envelope_id
    and archived = false
  for update;

  if not found then
    raise exception 'Envelope not found or archived.';
  end if;

  update public.envelopes
  set balance_cents = balance_cents - p_amount_cents
  where id = p_envelope_id;

  if p_account_id is not null then
    update public.financial_accounts
    set balance_cents = balance_cents - p_amount_cents
    where id = p_account_id;
  end if;

  insert into public.transactions (date, payee, amount_cents, envelope_id, note, cleared, import_source, account_id)
  values (p_date, trim(p_payee), p_amount_cents, p_envelope_id, nullif(trim(p_note), ''), p_cleared, p_import_source, p_account_id)
  returning id into v_transaction_id;

  return v_transaction_id;
end;
$$;

create or replace function public.update_manual_transaction(
  p_transaction_id uuid,
  p_date date,
  p_payee text,
  p_amount_cents integer,
  p_envelope_id uuid,
  p_note text default null,
  p_cleared boolean default false,
  p_import_source text default null,
  p_account_id uuid default null
)
returns void
language plpgsql
security invoker
as $$
declare
  v_old_amount integer;
  v_old_envelope_id uuid;
  v_old_account_id uuid;
begin
  if p_amount_cents = 0 then
    raise exception 'Amount cannot be zero.';
  end if;
  if p_import_source is not null and p_import_source not in ('manual', 'chase_csv') then
    raise exception 'Invalid import source.';
  end if;
  if p_account_id is not null then
    perform 1 from public.financial_accounts where id = p_account_id and archived = false for update;
    if not found then
      raise exception 'Account not found or archived.';
    end if;
  end if;

  select amount_cents, envelope_id, account_id
  into v_old_amount, v_old_envelope_id, v_old_account_id
  from public.transactions
  where id = p_transaction_id
    and archived = false
  for update;

  if not found then
    raise exception 'Transaction not found.';
  end if;

  perform 1
  from public.envelopes
  where id in (v_old_envelope_id, p_envelope_id)
    and archived = false
  for update;

  update public.envelopes
  set balance_cents = balance_cents + v_old_amount
  where id = v_old_envelope_id;

  update public.envelopes
  set balance_cents = balance_cents - p_amount_cents
  where id = p_envelope_id;

  if v_old_account_id is not null then
    update public.financial_accounts
    set balance_cents = balance_cents + v_old_amount
    where id = v_old_account_id;
  end if;

  if p_account_id is not null then
    update public.financial_accounts
    set balance_cents = balance_cents - p_amount_cents
    where id = p_account_id;
  end if;

  update public.transactions
  set
    date = p_date,
    payee = trim(p_payee),
    amount_cents = p_amount_cents,
    envelope_id = p_envelope_id,
    note = nullif(trim(p_note), ''),
    cleared = p_cleared,
    import_source = coalesce(p_import_source, import_source),
    account_id = p_account_id
  where id = p_transaction_id;
end;
$$;
