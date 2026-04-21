create table if not exists public.envelope_moves (
  id uuid primary key default gen_random_uuid(),
  from_envelope_id uuid not null references public.envelopes(id) on delete restrict,
  to_envelope_id uuid not null references public.envelopes(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_envelope_moves_created_at on public.envelope_moves(created_at desc);
create index if not exists idx_envelope_moves_from_envelope_id on public.envelope_moves(from_envelope_id);
create index if not exists idx_envelope_moves_to_envelope_id on public.envelope_moves(to_envelope_id);

alter table public.envelope_moves enable row level security;

drop policy if exists "authenticated envelope_moves access" on public.envelope_moves;
create policy "authenticated envelope_moves access"
on public.envelope_moves
for all
to authenticated
using (true)
with check (true);

create or replace function public.move_envelope_funds(
  p_from_envelope_id uuid,
  p_to_envelope_id uuid,
  p_amount_cents integer,
  p_reason text default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_from_balance integer;
  v_found integer;
  v_move_id uuid;
begin
  if p_from_envelope_id = p_to_envelope_id then
    raise exception 'From and to envelopes must be different.';
  end if;

  if p_amount_cents <= 0 then
    raise exception 'Move amount must be greater than zero.';
  end if;

  perform 1
  from public.envelopes
  where id in (p_from_envelope_id, p_to_envelope_id)
    and archived = false
  order by id
  for update;

  select count(*)
  into v_found
  from public.envelopes
  where id in (p_from_envelope_id, p_to_envelope_id)
    and archived = false;

  if v_found <> 2 then
    raise exception 'Both envelopes must exist and be active.';
  end if;

  select balance_cents
  into v_from_balance
  from public.envelopes
  where id = p_from_envelope_id;

  if v_from_balance < p_amount_cents then
    raise exception 'Insufficient funds in source envelope.';
  end if;

  update public.envelopes
  set balance_cents = balance_cents - p_amount_cents
  where id = p_from_envelope_id;

  update public.envelopes
  set balance_cents = balance_cents + p_amount_cents
  where id = p_to_envelope_id;

  insert into public.envelope_moves (from_envelope_id, to_envelope_id, amount_cents, reason)
  values (p_from_envelope_id, p_to_envelope_id, p_amount_cents, nullif(trim(p_reason), ''))
  returning id into v_move_id;

  return v_move_id;
end;
$$;
