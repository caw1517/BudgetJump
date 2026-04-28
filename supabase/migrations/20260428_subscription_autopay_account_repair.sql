-- Repair subscription autopay rows that were posted to an envelope without the account side.
-- This keeps the monthly autopay idempotent while allowing a rerun to finish the ledger entry.

create or replace function public.run_subscription_autopay(
  p_run_date date default current_date
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_month_start date;
  v_month_end date;
  v_day integer;
  v_count integer := 0;
  v_env record;
  v_payee text;
  v_note text;
  v_orphan_transaction_id uuid;
begin
  v_month_start := date_trunc('month', p_run_date)::date;
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_day := extract(day from p_run_date)::integer;

  for v_env in
    select
      e.id,
      e.name,
      e.due_day_of_month,
      e.subscription_amount_cents,
      e.subscription_payee,
      e.subscription_note,
      e.subscription_account_id,
      e.subscription_last_paid_month
    from public.envelopes e
    where e.archived = false
      and e.is_subscription = true
      and e.subscription_autopay_enabled = true
      and e.subscription_amount_cents is not null
      and e.subscription_account_id is not null
      and e.due_day_of_month is not null
      and e.due_day_of_month <= v_day
    for update
  loop
    v_payee := coalesce(nullif(trim(v_env.subscription_payee), ''), v_env.name || ' subscription');
    v_note := coalesce(nullif(trim(v_env.subscription_note), ''), 'Auto subscription payment');
    v_orphan_transaction_id := null;

    perform 1
    from public.financial_accounts
    where id = v_env.subscription_account_id
      and archived = false
    for update;

    if not found then
      raise exception 'Subscription account not found or archived for envelope %.', v_env.name;
    end if;

    select t.id
    into v_orphan_transaction_id
    from public.transactions t
    where t.archived = false
      and t.envelope_id = v_env.id
      and t.account_id is null
      and t.amount_cents = v_env.subscription_amount_cents
      and t.date between v_month_start and v_month_end
      and t.payee = v_payee
      and t.note is not distinct from v_note
      and t.transaction_kind = 'regular'
    order by t.date desc, t.created_at desc
    limit 1
    for update;

    if v_orphan_transaction_id is not null then
      update public.transactions
      set account_id = v_env.subscription_account_id
      where id = v_orphan_transaction_id;

      if v_env.subscription_last_paid_month is null or v_env.subscription_last_paid_month < v_month_start then
        update public.financial_accounts
        set balance_cents = balance_cents - v_env.subscription_amount_cents
        where id = v_env.subscription_account_id;
      end if;

      update public.envelopes
      set subscription_last_paid_month = v_month_start
      where id = v_env.id;

      v_count := v_count + 1;
      continue;
    end if;

    -- Re-check idempotency after any repair opportunity while the envelope row is locked.
    if v_env.subscription_last_paid_month is not null and v_env.subscription_last_paid_month >= v_month_start then
      continue;
    end if;

    perform public.create_manual_transaction(
      p_run_date,
      v_payee,
      v_env.subscription_amount_cents,
      v_env.id,
      v_note,
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
