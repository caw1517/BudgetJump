create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  payee text not null,
  amount_cents integer not null check (amount_cents > 0),
  envelope_id uuid not null references public.envelopes(id) on delete restrict,
  note text,
  cleared boolean not null default false,
  import_source text not null default 'manual' check (import_source in ('manual', 'chase_csv')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transactions_date on public.transactions(date desc);
create index if not exists idx_transactions_envelope_id on public.transactions(envelope_id);
create index if not exists idx_transactions_archived on public.transactions(archived);

drop trigger if exists trg_transactions_updated_at on public.transactions;
create trigger trg_transactions_updated_at
before update on public.transactions
for each row
execute function public.set_updated_at();

alter table public.transactions enable row level security;

drop policy if exists "authenticated transactions access" on public.transactions;
create policy "authenticated transactions access"
on public.transactions
for all
to authenticated
using (true)
with check (true);

create or replace function public.create_manual_transaction(
  p_date date,
  p_payee text,
  p_amount_cents integer,
  p_envelope_id uuid,
  p_note text default null,
  p_cleared boolean default false,
  p_import_source text default 'manual'
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

  insert into public.transactions (date, payee, amount_cents, envelope_id, note, cleared, import_source)
  values (p_date, trim(p_payee), p_amount_cents, p_envelope_id, nullif(trim(p_note), ''), p_cleared, p_import_source)
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
  p_import_source text default null
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
    import_source = coalesce(p_import_source, import_source)
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
begin
  select amount_cents, envelope_id
  into v_amount, v_envelope_id
  from public.transactions
  where id = p_transaction_id
    and archived = false
  for update;

  if not found then
    raise exception 'Transaction not found.';
  end if;

  update public.envelopes
  set balance_cents = balance_cents + v_amount
  where id = v_envelope_id;

  update public.transactions
  set archived = true
  where id = p_transaction_id;
end;
$$;
