-- Optional fields for debt payoff modeling on liability accounts.

alter table public.financial_accounts
add column if not exists minimum_payment_cents integer null
  check (minimum_payment_cents is null or minimum_payment_cents >= 0);

alter table public.financial_accounts
add column if not exists planned_monthly_payment_cents integer null
  check (planned_monthly_payment_cents is null or planned_monthly_payment_cents >= 0);
