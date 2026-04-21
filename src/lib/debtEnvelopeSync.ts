import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Debt liability accounts have a matching envelope (same name, type "debt").
 * When minimum payment is set on the account, keep that envelope's monthly
 * assignment target in sync (assign_monthly + budget_target_cents).
 */
export async function syncDebtEnvelopeMonthlyGoalFromMinimum(
  supabase: SupabaseClient,
  params: { liabilityAccountName: string; minimumPaymentCents: number | null },
): Promise<{ error: Error | null }> {
  const targetCents = params.minimumPaymentCents == null ? 0 : Math.max(0, params.minimumPaymentCents)
  const { data: rows, error: selErr } = await supabase
    .from('envelopes')
    .select('id')
    .eq('type', 'debt')
    .eq('name', params.liabilityAccountName)
    .eq('archived', false)
  if (selErr) return { error: new Error(selErr.message) }
  if (!rows?.length) return { error: null }
  for (const row of rows) {
    const { error: upErr } = await supabase
      .from('envelopes')
      .update({
        goal_type: 'assign_monthly' as const,
        goal_target_cents: null,
        budget_target_cents: targetCents,
      })
      .eq('id', row.id)
    if (upErr) return { error: new Error(upErr.message) }
  }
  return { error: null }
}

/** Rename the linked debt envelope when the liability account name changes. */
export async function renameDebtEnvelopeIfPresent(
  supabase: SupabaseClient,
  params: { fromName: string; toName: string },
): Promise<{ error: Error | null }> {
  if (params.fromName === params.toName) return { error: null }
  const { data: rows, error: selErr } = await supabase
    .from('envelopes')
    .select('id')
    .eq('type', 'debt')
    .eq('name', params.fromName)
    .eq('archived', false)
  if (selErr) return { error: new Error(selErr.message) }
  if (!rows?.length) return { error: null }
  for (const row of rows) {
    const { error: upErr } = await supabase.from('envelopes').update({ name: params.toName }).eq('id', row.id)
    if (upErr) return { error: new Error(upErr.message) }
  }
  return { error: null }
}
