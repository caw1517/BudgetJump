import { format } from 'date-fns'

/**
 * Parse YYYY-MM-DD (or ISO starting with that) as a **local** calendar date.
 * Avoids `new Date("YYYY-MM-DD")`, which is parsed as UTC midnight and shifts
 * the displayed day in western timezones.
 */
export function parseCalendarDateLocal(value: string): Date {
  const slice = value.slice(0, 10)
  const [yRaw, mRaw, dRaw] = slice.split('-')
  const y = Number.parseInt(yRaw ?? '', 10)
  const m = Number.parseInt(mRaw ?? '', 10)
  const d = Number.parseInt(dRaw ?? '', 10)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return new Date(value)
  return new Date(y, m - 1, d)
}

/** Local calendar day as YYYY-MM-DD (do not use `toISOString().slice(0, 10)` for this). */
export function localCalendarDateString(date: Date = new Date()): string {
  return format(date, 'yyyy-MM-dd')
}
