-- =============================================================================
-- DEV / TEST ONLY — run manually in the Supabase SQL editor when you want
-- an empty slate. This does NOT run as part of normal migrations.
-- =============================================================================
begin;

delete from public.paycheck_allocations;
delete from public.paycheck_moves;
delete from public.paychecks;
delete from public.transactions;
delete from public.envelope_moves;
delete from public.financial_accounts;
delete from public.envelopes;
delete from public.envelope_groups;

commit;
