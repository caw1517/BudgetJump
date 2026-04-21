-- Optional monthly due day for bill-style envelopes (1–31; clamps in app for short months).
alter table public.envelopes
add column if not exists due_day_of_month integer
  null
  check (due_day_of_month is null or (due_day_of_month >= 1 and due_day_of_month <= 31));

comment on column public.envelopes.due_day_of_month is
  'Day of month a bill is typically due. Null means no due-date reminder.';
