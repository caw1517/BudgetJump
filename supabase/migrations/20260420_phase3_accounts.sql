create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_type text not null check (account_type in ('checking', 'savings', 'credit_card', 'debt', 'cash', 'other')),
  institution text,
  last4 text,
  sort_order integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_financial_accounts_updated_at on public.financial_accounts;
create trigger trg_financial_accounts_updated_at
before update on public.financial_accounts
for each row
execute function public.set_updated_at();

alter table public.financial_accounts enable row level security;

drop policy if exists "authenticated financial_accounts access" on public.financial_accounts;
create policy "authenticated financial_accounts access"
on public.financial_accounts
for all
to authenticated
using (true)
with check (true);

alter table public.transactions
add column if not exists account_id uuid references public.financial_accounts(id) on delete set null;

create index if not exists idx_transactions_account_id on public.transactions(account_id);

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
  if p_amount_cents <= 0 then
    raise exception 'Amount must be greater than zero.';
  end if;
  if p_import_source not in ('manual', 'chase_csv') then
    raise exception 'Invalid import source.';
  end if;
  if p_account_id is not null then
    perform 1 from public.financial_accounts where id = p_account_id and archived = false;
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
begin
  if p_amount_cents <= 0 then
    raise exception 'Amount must be greater than zero.';
  end if;
  if p_import_source is not null and p_import_source not in ('manual', 'chase_csv') then
    raise exception 'Invalid import source.';
  end if;
  if p_account_id is not null then
    perform 1 from public.financial_accounts where id = p_account_id and archived = false;
    if not found then
      raise exception 'Account not found or archived.';
    end if;
  end if;

  select amount_cents, envelope_id
  into v_old_amount, v_old_envelope_id
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
