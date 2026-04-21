import { useCallback, useEffect, useMemo, useState } from 'react'
import { addMonths, endOfMonth, format, startOfMonth, subMonths } from 'date-fns'
import { Link } from 'react-router-dom'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import { formatCurrencyFromCents } from '../lib/currency'
import { getSupabase } from '../lib/supabase'

type EnvelopeGoalType = 'assign_monthly' | 'refill_up_to'

type SavingsEnvelope = {
  id: string
  name: string
  budget_target_cents: number
  goal_type: EnvelopeGoalType | null
  goal_target_cents: number | null
  balance_cents: number
  color: string
}

function SavingsMonthlyTargetProgress({
  budgetTargetCents,
  assignedThisMonthCents,
}: {
  budgetTargetCents: number
  assignedThisMonthCents: number
}) {
  const target = budgetTargetCents
  const current = Math.min(assignedThisMonthCents, target)
  const need = Math.max(target - current, 0)
  const caption = `Assigned this month: ${formatCurrencyFromCents(current)} / ${formatCurrencyFromCents(target)} (${formatCurrencyFromCents(need)} to go)`
  const percent = target > 0 ? Math.max(0, Math.min(100, Math.round((current / target) * 100))) : 0

  return (
    <div className="mt-1.5">
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{caption}</p>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function SavingsRefillProgress({ balanceCents, capCents }: { balanceCents: number; capCents: number }) {
  const target = capCents
  const filled = Math.min(Math.max(balanceCents, 0), target)
  const headroom = Math.max(target - balanceCents, 0)
  const caption = `Balance ${formatCurrencyFromCents(balanceCents)} / cap ${formatCurrencyFromCents(target)} (${formatCurrencyFromCents(headroom)} headroom)`
  const percent = target > 0 ? Math.max(0, Math.min(100, Math.round((filled / target) * 100))) : 0

  return (
    <div className="mt-1.5">
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{caption}</p>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div className="h-full rounded-full bg-sky-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

export function SavingsGoalsPage() {
  const [envelopes, setEnvelopes] = useState<SavingsEnvelope[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [monthlyAssignedByEnvelope, setMonthlyAssignedByEnvelope] = useState<Record<string, number>>({})
  const [avgAssign6MoByEnvelope, setAvgAssign6MoByEnvelope] = useState<Record<string, number>>({})

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const monthStart = format(startOfMonth(subMonths(new Date(), 5)), 'yyyy-MM-dd')
      const monthEnd = format(endOfMonth(new Date()), 'yyyy-MM-dd')

      const [envResp, allocResp] = await Promise.all([
        supabase
          .from('envelopes')
          .select('id,name,budget_target_cents,goal_type,goal_target_cents,balance_cents,color,archived,type')
          .eq('archived', false)
          .eq('type', 'savings')
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
        supabase
          .from('paycheck_allocations')
          .select('envelope_id,amount_cents,allocation_month')
          .gte('allocation_month', monthStart)
          .lte('allocation_month', monthEnd),
      ])
      if (envResp.error) throw envResp.error
      if (allocResp.error) throw allocResp.error

      const rows = (envResp.data ?? []) as SavingsEnvelope[]
      setEnvelopes(rows)

      const thisMonth = format(new Date(), 'yyyy-MM')
      const byEnvelopeThisMonth: Record<string, number> = {}
      const sumByEnvelope: Record<string, number> = {}

      for (const row of (allocResp.data ?? []) as Array<{
        envelope_id: string
        amount_cents: number
        allocation_month: string
      }>) {
        const month = row.allocation_month?.slice(0, 7)
        if (!month) continue
        sumByEnvelope[row.envelope_id] = (sumByEnvelope[row.envelope_id] ?? 0) + row.amount_cents
        if (month === thisMonth) {
          byEnvelopeThisMonth[row.envelope_id] = (byEnvelopeThisMonth[row.envelope_id] ?? 0) + row.amount_cents
        }
      }

      const avgBy: Record<string, number> = {}
      for (const id of Object.keys(sumByEnvelope)) {
        avgBy[id] = Math.round(sumByEnvelope[id]! / 6)
      }

      setMonthlyAssignedByEnvelope(byEnvelopeThisMonth)
      setAvgAssign6MoByEnvelope(avgBy)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load savings goals.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const totalSavingsBalance = useMemo(
    () => envelopes.reduce((s, e) => s + e.balance_cents, 0),
    [envelopes],
  )

  const refillEta = useCallback((env: SavingsEnvelope): { months: number | null; label: string } => {
    if (env.goal_type !== 'refill_up_to' || !(env.goal_target_cents && env.goal_target_cents > 0)) {
      return { months: null, label: '' }
    }
    const cap = env.goal_target_cents
    const bal = env.balance_cents
    if (bal >= cap) {
      return { months: 0, label: 'Cap reached' }
    }
    const remaining = cap - bal
    const avgIn = avgAssign6MoByEnvelope[env.id] ?? 0
    const monthlyHint = Math.max(avgIn, env.budget_target_cents > 0 ? env.budget_target_cents : 0)
    if (monthlyHint < 1) {
      return {
        months: null,
        label: 'Add paycheck allocations (or set a monthly target) to estimate time to cap.',
      }
    }
    const months = Math.ceil(remaining / monthlyHint)
    if (!Number.isFinite(months) || months > 600) {
      return { months: null, label: 'Pace is too low to estimate within 50 years at current inflow.' }
    }
    const d = addMonths(new Date(), months)
    return {
      months,
      label: `~${months} mo (${format(d, 'MMMM yyyy')}) at ~${formatCurrencyFromCents(monthlyHint)}/mo inflow`,
    }
  }, [avgAssign6MoByEnvelope])

  return (
    <div className="space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface p-4 sm:p-6">
        <h1 className="section-title">Savings goals</h1>
        <p className="section-subtitle max-w-2xl">
          Savings goals are envelopes with type <strong>Savings</strong>. Fund them from the{' '}
          <Link to="/journal" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
            Paycheck Journal
          </Link>{' '}
          or moves on{' '}
          <Link to="/envelopes" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
            Envelopes
          </Link>
          . Edit caps, colors, and monthly targets there—this page is your read-focused progress view.
        </p>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">{error}</p>
        )}
      </section>

      <CollapsibleCard title="Summary" storageKey="savings-summary">
        {loading ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : envelopes.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            No savings envelopes yet. On{' '}
            <Link to="/envelopes" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
              Envelopes
            </Link>
            , add an envelope and set its type to <strong>Savings</strong>, then choose a goal (monthly assign or refill
            cap).
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-zinc-200/90 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Goals</p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{envelopes.length}</p>
            </div>
            <div className="rounded-xl border border-zinc-200/90 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Combined savings envelope balance
              </p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                {formatCurrencyFromCents(totalSavingsBalance)}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200/90 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Refill caps met</p>
              <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                {
                  envelopes.filter(
                    (e) =>
                      e.goal_type === 'refill_up_to' &&
                      (e.goal_target_cents ?? 0) > 0 &&
                      e.balance_cents >= (e.goal_target_cents ?? 0),
                  ).length
                }
              </p>
            </div>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Your savings goals" storageKey="savings-goals-list">
        {loading ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : envelopes.length === 0 ? null : (
          <ul className="mt-3 space-y-4">
            {envelopes.map((env) => {
              const assigned = monthlyAssignedByEnvelope[env.id] ?? 0
              const avg6 = avgAssign6MoByEnvelope[env.id] ?? 0
              const eta = refillEta(env)

              return (
                <li
                  key={env.id}
                  className="rounded-xl border border-zinc-200/90 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40"
                  style={{ borderLeftWidth: 4, borderLeftColor: env.color }}
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{env.name}</h2>
                      <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                        Balance{' '}
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {formatCurrencyFromCents(env.balance_cents)}
                        </span>
                        {env.goal_type === 'refill_up_to' && (env.goal_target_cents ?? 0) > 0
                          ? ` · Refill cap ${formatCurrencyFromCents(env.goal_target_cents ?? 0)}`
                          : env.budget_target_cents > 0
                            ? ` · Monthly assign target ${formatCurrencyFromCents(env.budget_target_cents)}`
                            : null}
                      </p>
                    </div>
                    <Link
                      to="/envelopes"
                      className="shrink-0 text-sm font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
                    >
                      Edit on Envelopes →
                    </Link>
                  </div>

                  {env.goal_type === 'refill_up_to' && (env.goal_target_cents ?? 0) > 0 ? (
                    <SavingsRefillProgress balanceCents={env.balance_cents} capCents={env.goal_target_cents ?? 0} />
                  ) : env.budget_target_cents > 0 ? (
                    <SavingsMonthlyTargetProgress
                      budgetTargetCents={env.budget_target_cents}
                      assignedThisMonthCents={assigned}
                    />
                  ) : (
                    <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                      Set a monthly assignment target or a refill cap on Envelopes to track progress here.
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                    <span>
                      Avg assigned (6-mo window):{' '}
                      <span className="font-medium text-zinc-800 dark:text-zinc-200">
                        {formatCurrencyFromCents(avg6)}
                      </span>
                      /mo
                    </span>
                    {env.goal_type === 'refill_up_to' && (env.goal_target_cents ?? 0) > 0 && env.balance_cents < (env.goal_target_cents ?? 0) && (
                      <span className="text-zinc-700 dark:text-zinc-300">
                        Est. to cap:{' '}
                        <span className="font-medium text-emerald-800 dark:text-emerald-200">{eta.label}</span>
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="How this ties together" storageKey="savings-help">
        <ul className="mt-2 list-inside list-disc space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          <li>
            <strong className="text-zinc-800 dark:text-zinc-200">Assign monthly</strong> — Journal allocations this
            month are compared to your target (same bar as on Envelopes).
          </li>
          <li>
            <strong className="text-zinc-800 dark:text-zinc-200">Refill up to</strong> — Balance vs cap; est. to cap
            uses the larger of your 6-month average inflow from paychecks and your monthly target (if set).
          </li>
          <li>Moving cash between envelopes does not change the 6-mo average (allocations only).</li>
        </ul>
      </CollapsibleCard>
    </div>
  )
}
