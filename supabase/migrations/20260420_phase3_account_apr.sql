alter table public.financial_accounts
add column if not exists apr_bps integer;

alter table public.financial_accounts
drop constraint if exists financial_accounts_apr_bps_check;

alter table public.financial_accounts
add constraint financial_accounts_apr_bps_check
check (apr_bps is null or (apr_bps >= 0 and apr_bps <= 1000000));
