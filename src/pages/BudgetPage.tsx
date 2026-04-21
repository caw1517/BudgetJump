import { useCallback, useEffect, useMemo, useState } from 'react'
import { addMonths, endOfMonth, format, startOfMonth, subMonths } from 'date-fns'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import { formatCurrencyFromCents } from '../lib/currency'
import { getSupabase } from '../lib/supabase'

type Envelope = {
  id: string
  name: string
  archived: boolean
}

type Row = {
  envelopeId: string
  envelopeName: string
  budgetedCents: number
  spentCents: number
  remainingCents: number
  percentUsed: number
}

export function BudgetPage() {
  const [month, setMonth] = useState<Date>(new Date())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const monthStart = format(startOfMonth(month), 'yyyy-MM-dd')
  const monthEnd = format(endOfMonth(month), 'yyyy-MM-dd')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const [envelopesResp, allocationsResp, transactionsResp] = await Promise.all([
        supabase.from('envelopes').select('id,name,archived').eq('archived', false).order('name', { ascending: true }),
        supabase
          .from('paycheck_allocations')
          .select('envelope_id,amount_cents,allocation_month')
          .gte('allocation_month', monthStart)
          .lte('allocation_month', monthEnd),
        supabase
          .from('transactions')
          .select('envelope_id,amount_cents,date')
          .eq('archived', false)
          .gte('date', monthStart)
          .lte('date', monthEnd),
      ])
      if (envelopesResp.error) throw envelopesResp.error
      if (allocationsResp.error) throw allocationsResp.error
      if (transactionsResp.error) throw transactionsResp.error

      const envelopes = (envelopesResp.data ?? []) as Envelope[]
      const allocationMap = new Map<string, number>()
      for (const row of (allocationsResp.data ?? []) as Array<{ envelope_id: string; amount_cents: number }>) {
        allocationMap.set(row.envelope_id, (allocationMap.get(row.envelope_id) ?? 0) + row.amount_cents)
      }

      const spendingMap = new Map<string, number>()
      for (const row of (transactionsResp.data ?? []) as Array<{ envelope_id: string; amount_cents: number }>) {
        spendingMap.set(row.envelope_id, (spendingMap.get(row.envelope_id) ?? 0) + row.amount_cents)
      }

      const nextRows: Row[] = envelopes.map((envelope) => {
        const budgeted = allocationMap.get(envelope.id) ?? 0
        const spent = spendingMap.get(envelope.id) ?? 0
        const remaining = budgeted - spent
        const percent = budgeted > 0 ? Math.round((spent / budgeted) * 100) : spent > 0 ? 100 : 0
        return {
          envelopeId: envelope.id,
          envelopeName: envelope.name,
          budgetedCents: budgeted,
          spentCents: spent,
          remainingCents: remaining,
          percentUsed: percent,
        }
      })

      setRows(nextRows.sort((a, b) => b.spentCents - a.spentCents))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load budget data.')
    } finally {
      setLoading(false)
    }
  }, [monthEnd, monthStart])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          acc.budgeted += row.budgetedCents
          acc.spent += row.spentCents
          acc.remaining += row.remainingCents
          return acc
        },
        { budgeted: 0, spent: 0, remaining: 0 },
      ),
    [rows],
  )

  const totalPercent = totals.budgeted > 0 ? Math.round((totals.spent / totals.budgeted) * 100) : 0

  function exportCsv() {
    if (rows.length === 0) return
    const headers = ['Envelope', 'Budgeted', 'Spent', 'Remaining', 'Percent Used']
    const lines = [
      headers.join(','),
      ...rows.map((row) =>
        [
          `"${row.envelopeName.replaceAll('"', '""')}"`,
          (row.budgetedCents / 100).toFixed(2),
          (row.spentCents / 100).toFixed(2),
          (row.remainingCents / 100).toFixed(2),
          `${row.percentUsed}%`,
        ].join(','),
      ),
    ]
    const csv = lines.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `budget-vs-actual-${format(month, 'yyyy-MM')}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="section-title">Budget vs Actual</h1>
          <button
            type="button"
            onClick={exportCsv}
            className="btn-secondary px-3 text-xs"
          >
            Export Month CSV
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setMonth((prev) => subMonths(prev, 1))}
            className="btn-secondary px-3 text-xs"
          >
            Previous
          </button>
          <p className="text-sm font-medium">{format(month, 'MMMM yyyy')}</p>
          <button
            type="button"
            onClick={() => setMonth((prev) => addMonths(prev, 1))}
            className="btn-secondary px-3 text-xs"
          >
            Next
          </button>
        </div>
        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">{error}</p>}
      </section>

      <CollapsibleCard title="Summary" storageKey="budget-summary">
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label="Budgeted" value={formatCurrencyFromCents(totals.budgeted)} />
          <SummaryCard label="Spent" value={formatCurrencyFromCents(totals.spent)} />
          <SummaryCard label="Remaining" value={formatCurrencyFromCents(totals.remaining)} />
          <SummaryCard label="% Used" value={`${totalPercent}%`} />
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="By Category" storageKey="budget-by-category">
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading month data...</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No category data in this month.</p>
        ) : (
          <div className="mt-4 space-y-2">
            <div className="hidden grid-cols-6 gap-2 border-b border-zinc-200 pb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400 sm:grid">
              <span className="col-span-2">Envelope</span>
              <span>Budgeted</span>
              <span>Spent</span>
              <span>Remaining</span>
              <span>% Used</span>
            </div>
            {rows.map((row) => (
              <div key={row.envelopeId} className="rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-center">
                  <div className="sm:col-span-2">
                    <p className="text-sm font-semibold">{row.envelopeName}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{statusLabel(row.percentUsed)}</p>
                  </div>
                  <p className="text-sm">{formatCurrencyFromCents(row.budgetedCents)}</p>
                  <p className="text-sm">{formatCurrencyFromCents(row.spentCents)}</p>
                  <p className={['text-sm', row.remainingCents < 0 ? 'text-red-700 dark:text-red-300' : ''].join(' ')}>
                    {formatCurrencyFromCents(row.remainingCents)}
                  </p>
                  <p className={['text-sm font-semibold', statusColor(row.percentUsed)].join(' ')}>{row.percentUsed}%</p>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                  <div
                    className={['h-full rounded-full', barColor(row.percentUsed)].join(' ')}
                    style={{ width: `${Math.min(row.percentUsed, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-200/90 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  )
}

function statusLabel(percent: number): string {
  if (percent > 100) return 'Overspent'
  if (percent >= 80) return 'Near limit'
  return 'On track'
}

function statusColor(percent: number): string {
  if (percent > 100) return 'text-red-700 dark:text-red-300'
  if (percent >= 80) return 'text-amber-700 dark:text-amber-300'
  return 'text-emerald-700 dark:text-emerald-300'
}

function barColor(percent: number): string {
  if (percent > 100) return 'bg-red-500'
  if (percent >= 80) return 'bg-amber-500'
  return 'bg-emerald-500'
}
