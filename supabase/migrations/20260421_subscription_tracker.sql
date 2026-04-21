alter table public.envelopes
add column if not exists is_subscription boolean not null default false;

alter table public.envelopes
add column if not exists subscription_amount_cents integer null
  check (subscription_amount_cents is null or subscription_amount_cents > 0);

alter table public.envelopes
add column if not exists subscription_payee text null;

alter table public.envelopes
add column if not exists subscription_note text null;

alter table public.envelopes
add column if not exists subscription_account_id uuid null
  references public.financial_accounts(id) on delete set null;

alter table public.envelopes
add column if not exists subscription_autopay_enabled boolean not null default true;

alter table public.envelopes
add column if not exists subscription_last_paid_month date null;

comment on column public.envelopes.is_subscription is
  'Whether this envelope is configured as a recurring subscription.';

comment on column public.envelopes.subscription_last_paid_month is
  'First day of month when autopay last posted for this subscription.';

create index if not exists idx_envelopes_is_subscription
  on public.envelopes(is_subscription)
  where archived = false;

create or replace function public.run_subscription_autopay(
  p_run_date date default current_date
)
returns integer
language plpgsql
security invoker
as $$
declare
  v_month_start date;
  v_day integer;
  v_count integer := 0;
  v_env record;
begin
  v_month_start := date_trunc('month', p_run_date)::date;
  v_day := extract(day from p_run_date)::integer;

  for v_env in
    select
      e.id,
      e.name,
      e.due_day_of_month,
      e.subscription_amount_cents,
      e.subscription_payee,
      e.subscription_note,
      e.subscription_account_id
    from public.envelopes e
    where e.archived = false
      and e.is_subscription = true
      and e.subscription_autopay_enabled = true
      and e.subscription_amount_cents is not null
      and e.subscription_account_id is not null
      and e.due_day_of_month is not null
      and e.due_day_of_month <= v_day
      and (e.subscription_last_paid_month is null or e.subscription_last_paid_month < v_month_start)
    for update
  loop
    -- Re-check idempotency while row is locked.
    if exists (
      select 1
      from public.envelopes e2
      where e2.id = v_env.id
        and e2.subscription_last_paid_month is not null
        and e2.subscription_last_paid_month >= v_month_start
    ) then
      continue;
    end if;

    perform public.create_manual_transaction(
      p_run_date,
      coalesce(nullif(trim(v_env.subscription_payee), ''), v_env.name || ' subscription'),
      v_env.subscription_amount_cents,
      v_env.id,
      coalesce(nullif(trim(v_env.subscription_note), ''), 'Auto subscription payment'),
      true,
      'manual',
      v_env.subscription_account_id,
      'regular'
    );

    update public.envelopes
    set subscription_last_paid_month = v_month_start
    where id = v_env.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
