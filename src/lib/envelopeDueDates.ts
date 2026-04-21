import { addMonths, differenceInCalendarDays, endOfMonth, isBefore, startOfDay } from 'date-fns'

/** Last valid calendar day in month for a nominal due day (e.g. 31 → 28 in February). */
export function clampDueDayForYearMonth(year: number, monthIndex0: number, dueDay: number): number {
  const last = endOfMonth(new Date(year, monthIndex0, 1)).getDate()
  return Math.min(Math.max(1, dueDay), last)
}

/**
 * Next calendar date the bill is due, on or after the start of `from` (local calendar day).
 */
export function nextDueDateOnOrAfter(dueDay: number, from: Date): Date {
  const t = startOfDay(from)
  const y = t.getFullYear()
  const m = t.getMonth()
  const d = clampDueDayForYearMonth(y, m, dueDay)
  let cand = new Date(y, m, d)
  if (isBefore(cand, t)) {
    const nm = addMonths(new Date(y, m, 1), 1)
    const d2 = clampDueDayForYearMonth(nm.getFullYear(), nm.getMonth(), dueDay)
    cand = new Date(nm.getFullYear(), nm.getMonth(), d2)
  }
  return cand
}

export function daysUntilNextDue(dueDay: number, from: Date = new Date()): number {
  return differenceInCalendarDays(startOfDay(nextDueDateOnOrAfter(dueDay, from)), startOfDay(from))
}

export function formatDueDayPhrase(dueDay: number | null | undefined): string {
  if (dueDay == null) return ''
  const n = dueDay % 10
  const n100 = dueDay % 100
  const suffix =
    n100 >= 11 && n100 <= 13 ? 'th' : n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'
  return `Due monthly on the ${dueDay}${suffix}`
}
