-- Allow account-only transaction rows (no envelope movement) for the card side
-- of a debt payment. Simplify debt payment to one envelope + two ledger lines.

alter table public.transactions
alter column envelope_id drop not null;

alter table public.transactions
drop constraint if exists transactions_envelope_or_account_chk;

alter table public.transactions
add constraint transactions_envelope_or_account_chk
check (envelope_id is not null or account_id is not null);

create or replace function public.create_manual_transaction(
  p_date date,
  p_payee text,
  p_amount_cents integer,
  p_envelope_id uuid,
  p_note text default null,
  p_cleared boolean default false,
  p_import_source text default 'manual',
  p_account_id uuid default null,
  p_transaction_kind text default 'regular'
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
  if p_transaction_kind not in ('regular', 'payment', 'interest', 'refund', 'transfer') then
    raise exception 'Invalid transaction kind.';
  end if;
  if p_envelope_id is null and p_account_id is null then
    raise exception 'Provide an envelope and/or account.';
  end if;

  if p_account_id is not null then
    perform 1 from public.financial_accounts where id = p_account_id and archived = false for update;
    if not found then
      raise exception 'Account not found or archived.';
    end if;
  end if;

  if p_envelope_id is not null then
    perform 1 from public.envelopes where id = p_envelope_id and archived = false for update;
    if not found then
      raise exception 'Envelope not found or archived.';
    end if;

    update public.envelopes
    set balance_cents = balance_cents - p_amount_cents
    where id = p_envelope_id;
  end if;

  if p_account_id is not null then
    update public.financial_accounts
    set balance_cents = balance_cents - p_amount_cents
    where id = p_account_id;
  end if;

  insert into public.transactions (
    date,
    payee,
    amount_cents,
    envelope_id,
    note,
    cleared,
    import_source,
    account_id,
    transaction_kind
  )
  values (
    p_date,
    trim(p_payee),
    p_amount_cents,
    p_envelope_id,
    nullif(trim(p_note), ''),
    p_cleared,
    p_import_source,
    p_account_id,
    p_transaction_kind
  )
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
  p_account_id uuid default null,
  p_transaction_kind text default null
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
  if p_transaction_kind is not null and p_transaction_kind not in ('regular', 'payment', 'interest', 'refund', 'transfer') then
    raise exception 'Invalid transaction kind.';
  end if;
  if p_envelope_id is null and p_account_id is null then
    raise exception 'Provide an envelope and/or account.';
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

  if v_old_envelope_id is not null and p_envelope_id is not null and v_old_envelope_id is distinct from p_envelope_id then
    perform 1
    from public.envelopes
    where id in (v_old_envelope_id, p_envelope_id)
      and archived = false
    for update;
  elsif v_old_envelope_id is not null then
    perform 1 from public.envelopes where id = v_old_envelope_id and archived = false for update;
  elsif p_envelope_id is not null then
    perform 1 from public.envelopes where id = p_envelope_id and archived = false for update;
  end if;

  if v_old_envelope_id is not null then
    update public.envelopes
    set balance_cents = balance_cents + v_old_amount
    where id = v_old_envelope_id;
  end if;

  if p_envelope_id is not null then
    update public.envelopes
    set balance_cents = balance_cents - p_amount_cents
    where id = p_envelope_id;
  end if;

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
    account_id = p_account_id,
    transaction_kind = coalesce(p_transaction_kind, transaction_kind)
  where id = p_transaction_id;
end;
$$;

create or replace function public.archive_transaction(
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
    and archived = false
  for update;

  if not found then
    raise exception 'Transaction not found.';
  end if;

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

  update public.transactions
  set archived = true
  where id = p_transaction_id;
end;
$$;

-- One envelope (cash side); card side is account-only (no envelope row).
create or replace function public.create_debt_payment(
  p_date date,
  p_amount_cents integer,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_from_envelope_id uuid,
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
begin
  if p_amount_cents <= 0 then
    raise exception 'Payment amount must be greater than zero.';
  end if;
  if p_from_account_id = p_to_account_id then
    raise exception 'From and to accounts must be different.';
  end if;

  select name, account_type into v_from_name, v_from_type
  from public.financial_accounts
  where id = p_from_account_id and archived = false;
  if not found then
    raise exception 'From account not found.';
  end if;

  select name, account_type into v_to_name, v_to_type
  from public.financial_accounts
  where id = p_to_account_id and archived = false;
  if not found then
    raise exception 'To account not found.';
  end if;

  if v_to_type not in ('credit_card', 'debt') then
    raise exception 'To account must be a credit card or debt account.';
  end if;

  if v_from_type in ('credit_card', 'debt') then
    raise exception 'Pay from a cash account (checking, savings, cash, or other), not from a liability account.';
  end if;

  v_out_id := public.create_manual_transaction(
    p_date,
    'Payment to ' || v_to_name,
    p_amount_cents,
    p_from_envelope_id,
    p_note,
    p_cleared,
    'manual',
    p_from_account_id,
    'payment'
  );

  v_in_id := public.create_manual_transaction(
    p_date,
    'Payment from ' || v_from_name,
    -p_amount_cents,
    null,
    p_note,
    p_cleared,
    'manual',
    p_to_account_id,
    'payment'
  );

  return jsonb_build_object(
    'out_transaction_id', v_out_id,
    'in_transaction_id', v_in_id
  );
end;
$$;

drop function if exists public.create_account_transfer(
  date,
  integer,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  boolean
);
