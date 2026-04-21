-- Track which calendar months (YYYY-MM) the user marked a bill paid, per envelope with a due day.
alter table public.envelopes
add column if not exists bill_paid_by_month jsonb not null default '{}'::jsonb;

comment on column public.envelopes.bill_paid_by_month is
  'Map of "YYYY-MM" -> true when the bill for that due-month was marked paid. Only meaningful when due_day_of_month is set.';
