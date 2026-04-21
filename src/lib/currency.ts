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

export function dollarsStringToCents(value: string): number | null {
  const normalized = value.trim().replaceAll(',', '')
  if (normalized.length === 0) return 0
  const parsed = Number(normalized)
  if (Number.isNaN(parsed)) return null
  return Math.round(parsed * 100)
}
