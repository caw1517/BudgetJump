export function formatCurrencyFromCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

/** Envelope name plus current balance for select options (balance can be negative if overspent). */
export function formatEnvelopeDropdownLabel(name: string, balanceCents: number): string {
  return `${name} · ${formatCurrencyFromCents(balanceCents)}`
}

/** Account name plus current balance for select options. */
export function formatAccountDropdownLabel(name: string, balanceCents: number): string {
  return `${name} · ${formatCurrencyFromCents(balanceCents)}`
}

function evaluateMathExpression(raw: string): number | null {
  const normalized = raw.replaceAll('$', '').replaceAll(',', '').trim()
  if (!normalized) return null
  if (!/^[\d+\-*/().\s]+$/.test(normalized)) return null
  if (normalized.includes('**') || normalized.includes('//')) return null
  try {
    const result = Function(`"use strict"; return (${normalized});`)()
    if (typeof result !== 'number' || !Number.isFinite(result)) return null
    return result
  } catch {
    return null
  }
}

export function dollarsStringToCents(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 0
  const parsed = evaluateMathExpression(trimmed)
  if (parsed == null || Number.isNaN(parsed)) return null
  return Math.round(parsed * 100)
}

export function normalizeDollarsInput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const cents = dollarsStringToCents(trimmed)
  if (cents == null) return value
  return (cents / 100).toFixed(2)
}
