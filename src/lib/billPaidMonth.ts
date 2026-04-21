import { format } from 'date-fns'
import { getSupabase } from './supabase'

export function normalizeBillPaidByMonth(raw: unknown): Record<string, boolean> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^\d{4}-\d{2}$/.test(k) && v === true) out[k] = true
  }
  return out
}

export function monthKeyFromDate(d: Date): string {
  return format(d, 'yyyy-MM')
}

/** Drop oldest YYYY-MM keys so the JSON object does not grow forever. */
export function pruneBillPaidByMonth(map: Record<string, boolean>, maxKeys = 48): Record<string, boolean> {
  const keys = Object.keys(map).sort()
  if (keys.length <= maxKeys) return { ...map }
  const drop = keys.length - maxKeys
  const next = { ...map }
  for (let i = 0; i < drop; i++) delete next[keys[i]!]
  return next
}

export function isBillPaidForMonth(map: Record<string, boolean> | undefined, monthKey: string): boolean {
  return map?.[monthKey] === true
}

export async function setEnvelopeBillPaidForMonth(
  envelopeId: string,
  currentMap: Record<string, boolean>,
  monthKey: string,
  paid: boolean,
): Promise<void> {
  const base = { ...currentMap }
  if (paid) base[monthKey] = true
  else delete base[monthKey]
  const bill_paid_by_month = pruneBillPaidByMonth(base)
  const { error } = await getSupabase().from('envelopes').update({ bill_paid_by_month }).eq('id', envelopeId)
  if (error) throw error
}
