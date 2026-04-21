import { useCallback, useEffect, useMemo, useState } from 'react'
import { addMonths, endOfMonth, format, isSameMonth, startOfMonth, subMonths } from 'date-fns'
import { Link } from 'react-router-dom'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import { formatCurrencyFromCents } from '../lib/currency'
import {
  isBillPaidForMonth,
  monthKeyFromDate,
  normalizeBillPaidByMonth,
  setEnvelopeBillPaidForMonth,
} from '../lib/billPaidMonth'
import { daysUntilNextDue, formatDueDayPhrase, nextDueDateOnOrAfter } from '../lib/envelopeDueDates'
import { getSupabase } from '../lib/supabase'

type AccountType = 'checking' | 'savings' | 'credit_card' | 'debt' | 'cash' | 'other'

type AccountRow = {
  id: string
  name: string
  account_type: AccountType
  balance_cents: number
}

type EnvelopeRow = {
  id: string
  name: string
  type: string
  balance_cents: number
  due_day_of_month: number | null
  budget_target_cents: number
  goal_type: 'assign_monthly' | 'refill_up_to' | null
  goal_target_cents: number | null
  bill_paid_by_month: Record<string, boolean>
}

type BudgetRow = {
  envelopeId: string
  envelopeName: string
  budgetedCents: number
  spentCents: number
  remainingCents: number
  percentUsed: number
}

type RecentTx = {
  id: string
  date: string
  payee: string
  amount_cents: number
  transaction_kind: string
  envelope: { name: string } | { name: string }[] | null
  account: { name: string } | { name: string }[] | null
}

type MonthTotals = {
  budgeted: number
  spent: number
  remaining: number
  paycheckNet: number
}

function joinName(rel: { name: string } | { name: string }[] | null | undefined, fallback: string): string {
  if (rel == null) return fallback
  if (Array.isArray(rel)) return rel[0]?.name ?? fallback
  return rel.name ?? fallback
}

const LIQUID_TYPES: AccountType[] = ['checking', 'savings', 'cash']

function signedSpendDelta(currSpent: number, prevSpent: number): string {
  const d = currSpent - prevSpent
  if (d === 0) return 'Same as last month'
  const sign = d > 0 ? '+' : ''
  return `${sign}${formatCurrencyFromCents(d)} vs last month`
}

function signedBudgetDelta(curr: number, prev: number, labelWhenSame: string): string {
  const d = curr - prev
  if (d === 0) return labelWhenSame
  const sign = d > 0 ? '+' : ''
  return `${sign}${formatCurrencyFromCents(d)} vs last month`
}

export function DashboardPage() {
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [envelopes, setEnvelopes] = useState<EnvelopeRow[]>([])
  const [budgetRows, setBudgetRows] = useState<BudgetRow[]>([])
  const [recentTx, setRecentTx] = useState<RecentTx[]>([])
  const [paycheckMonthNet, setPaycheckMonthNet] = useState(0)
  const [paycheckMonthCount, setPaycheckMonthCount] = useState(0)
  const [prevTotals, setPrevTotals] = useState<MonthTotals>({
    budgeted: 0,
    spent: 0,
    remaining: 0,
    paycheckNet: 0,
  })
  const [billPaidBusyId, setBillPaidBusyId] = useState<string | null>(null)

  const monthStart = format(startOfMonth(month), 'yyyy-MM-dd')
  const monthEnd = format(endOfMonth(month), 'yyyy-MM-dd')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    const prevMonth = subMonths(month, 1)
    const prevStart = format(startOfMonth(prevMonth), 'yyyy-MM-dd')
    const prevEnd = format(endOfMonth(prevMonth), 'yyyy-MM-dd')

    try {
      const supabase = getSupabase()
      const [
        accountsResp,
        envelopesResp,
        allocationsResp,
        transactionsMonthResp,
        pcResp,
        recentResp,
        prevAllocResp,
        prevTxResp,
        prevPcResp,
      ] = await Promise.all([
        supabase
          .from('financial_accounts')
          .select('id,name,account_type,balance_cents')
          .eq('archived', false)
          .order('sort_order', { ascending: true }),
        supabase
          .from('envelopes')
          .select(
            'id,name,type,balance_cents,due_day_of_month,budget_target_cents,goal_type,goal_target_cents,bill_paid_by_month',
          )
          .eq('archived', false)
          .order('name', { ascending: true }),
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
        supabase.from('paychecks').select('id,date,net_amount_cents').gte('date', monthStart).lte('date', monthEnd),
        supabase
          .from('transactions')
          .select(
            'id,date,payee,amount_cents,transaction_kind,envelope:envelope_id(name),account:account_id(name)',
          )
          .eq('archived', false)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(12),
        supabase
          .from('paycheck_allocations')
          .select('envelope_id,amount_cents,allocation_month')
          .gte('allocation_month', prevStart)
          .lte('allocation_month', prevEnd),
        supabase
          .from('transactions')
          .select('envelope_id,amount_cents,date')
          .eq('archived', false)
          .gte('date', prevStart)
          .lte('date', prevEnd),
        supabase.from('paychecks').select('id,date,net_amount_cents').gte('date', prevStart).lte('date', prevEnd),
      ])

      if (accountsResp.error) throw accountsResp.error
      if (envelopesResp.error) throw envelopesResp.error
      if (allocationsResp.error) throw allocationsResp.error
      if (transactionsMonthResp.error) throw transactionsMonthResp.error
      if (pcResp.error) throw pcResp.error
      if (recentResp.error) throw recentResp.error
      if (prevAllocResp.error) throw prevAllocResp.error
      if (prevTxResp.error) throw prevTxResp.error
      if (prevPcResp.error) throw prevPcResp.error

      const accList = (accountsResp.data ?? []) as AccountRow[]
      const envList = (envelopesResp.data ?? []).map((row) => ({
        ...(row as EnvelopeRow),
        bill_paid_by_month: normalizeBillPaidByMonth((row as EnvelopeRow).bill_paid_by_month),
      }))
      setAccounts(accList)
      setEnvelopes(envList)

      const foldMonth = (
        allocRows: Array<{ envelope_id: string; amount_cents: number }>,
        txRows: Array<{ envelope_id: string | null; amount_cents: number }>,
      ) => {
        const allocationMap = new Map<string, number>()
        for (const row of allocRows) {
          allocationMap.set(row.envelope_id, (allocationMap.get(row.envelope_id) ?? 0) + row.amount_cents)
        }
        const spendingMap = new Map<string, number>()
        for (const row of txRows) {
          if (!row.envelope_id) continue
          spendingMap.set(row.envelope_id, (spendingMap.get(row.envelope_id) ?? 0) + row.amount_cents)
        }
        let budgeted = 0
        let spent = 0
        for (const envelope of envList) {
          budgeted += allocationMap.get(envelope.id) ?? 0
          spent += spendingMap.get(envelope.id) ?? 0
        }
        return { budgeted, spent, remaining: budgeted - spent }
      }

      const currAlloc = (allocationsResp.data ?? []) as Array<{ envelope_id: string; amount_cents: number }>
      const currTx = (transactionsMonthResp.data ?? []) as Array<{ envelope_id: string | null; amount_cents: number }>

      const prevAlloc = (prevAllocResp.data ?? []) as Array<{ envelope_id: string; amount_cents: number }>
      const prevTx = (prevTxResp.data ?? []) as Array<{ envelope_id: string | null; amount_cents: number }>
      const { budgeted: pb, spent: ps, remaining: pr } = foldMonth(prevAlloc, prevTx)

      const allocationMap = new Map<string, number>()
      for (const row of currAlloc) {
        allocationMap.set(row.envelope_id, (allocationMap.get(row.envelope_id) ?? 0) + row.amount_cents)
      }
      const spendingMap = new Map<string, number>()
      for (const row of currTx) {
        if (!row.envelope_id) continue
        spendingMap.set(row.envelope_id, (spendingMap.get(row.envelope_id) ?? 0) + row.amount_cents)
      }

      const nextBudgetRows: BudgetRow[] = envList.map((envelope) => {
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
      setBudgetRows(nextBudgetRows.sort((a, b) => b.spentCents - a.spentCents))

      const pcs = (pcResp.data ?? []) as Array<{ net_amount_cents: number }>
      setPaycheckMonthCount(pcs.length)
      setPaycheckMonthNet(pcs.reduce((s, p) => s + p.net_amount_cents, 0))

      const prevPcs = (prevPcResp.data ?? []) as Array<{ net_amount_cents: number }>
      setPrevTotals({
        budgeted: pb,
        spent: ps,
        remaining: pr,
        paycheckNet: prevPcs.reduce((s, p) => s + p.net_amount_cents, 0),
      })

      setRecentTx((recentResp.data ?? []) as unknown as RecentTx[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dashboard.')
    } finally {
      setLoading(false)
    }
  }, [month])

  useEffect(() => {
    void loadData()
  }, [loadData])

  async function toggleBillPaid(envelope: EnvelopeRow, monthKey: string, paid: boolean) {
    setBillPaidBusyId(envelope.id)
    setError(null)
    try {
      await setEnvelopeBillPaidForMonth(envelope.id, envelope.bill_paid_by_month ?? {}, monthKey, paid)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update paid status.')
    } finally {
      setBillPaidBusyId(null)
    }
  }

  const totals = useMemo(
    () =>
      budgetRows.reduce(
        (acc, row) => {
          acc.budgeted += row.budgetedCents
          acc.spent += row.spentCents
          acc.remaining += row.remainingCents
          return acc
        },
        { budgeted: 0, spent: 0, remaining: 0 },
      ),
    [budgetRows],
  )

  const totalPercent = totals.budgeted > 0 ? Math.round((totals.spent / totals.budgeted) * 100) : totals.spent > 0 ? 100 : 0

  const cashAccountsTotal = useMemo(
    () => accounts.filter((a) => LIQUID_TYPES.includes(a.account_type)).reduce((s, a) => s + a.balance_cents, 0),
    [accounts],
  )

  const liabilityAccounts = useMemo(
    () => accounts.filter((a) => a.account_type === 'credit_card' || a.account_type === 'debt'),
    [accounts],
  )

  const liabilityLedgerSum = useMemo(
    () => liabilityAccounts.reduce((s, a) => s + a.balance_cents, 0),
    [liabilityAccounts],
  )

  const liabilityApproxOwed = useMemo(
    () => liabilityAccounts.reduce((s, a) => s + Math.abs(a.balance_cents), 0),
    [liabilityAccounts],
  )

  const envelopeCashExDebt = useMemo(
    () => envelopes.filter((e) => e.type !== 'debt').reduce((s, e) => s + e.balance_cents, 0),
    [envelopes],
  )

  const overspent = useMemo(
    () =>
      envelopes
        .filter((e) => e.balance_cents < 0)
        .sort((a, b) => a.balance_cents - b.balance_cents)
        .slice(0, 6),
    [envelopes],
  )

  const hotCategories = useMemo(() => {
    return [...budgetRows].filter((r) => r.spentCents > 0).slice(0, 5)
  }, [budgetRows])

  const overBudget = useMemo(() => budgetRows.filter((r) => r.percentUsed > 100).slice(0, 5), [budgetRows])

  const miniBudget = useMemo(() => budgetRows.filter((r) => r.spentCents > 0 || r.budgetedCents > 0).slice(0, 8), [budgetRows])

  const savingsPreview = useMemo(() => envelopes.filter((e) => e.type === 'savings').slice(0, 4), [envelopes])

  const billsInViewMonth = useMemo(() => {
    const ms = startOfMonth(month)
    const me = endOfMonth(month)
    const out: Array<{ e: EnvelopeRow; due: Date }> = []
    for (const e of envelopes) {
      if (e.due_day_of_month == null || e.type === 'debt') continue
      const due = nextDueDateOnOrAfter(e.due_day_of_month, ms)
      if (due >= ms && due <= me) out.push({ e, due })
    }
    return out.sort((a, b) => a.due.getTime() - b.due.getTime())
  }, [envelopes, month])

  const upcomingFromToday = useMemo(() => {
    const today = new Date()
    return envelopes
      .filter((e) => e.due_day_of_month != null && e.type !== 'debt')
      .sort((a, b) => daysUntilNextDue(a.due_day_of_month!, today) - daysUntilNextDue(b.due_day_of_month!, today))
      .slice(0, 6)
  }, [envelopes])

  const isViewingCurrentMonth = isSameMonth(month, new Date())

  return (
    <div className="min-w-0 space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface min-w-0 overflow-x-hidden p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="section-title">Dashboard</h1>
            <p className="section-subtitle max-w-2xl">
              At-a-glance for the selected month: cash, envelopes, budget progress, bills due, savings, and debt. Open{' '}
              <Link to="/budget" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
                Budget vs Actual
              </Link>{' '}
              for the full category grid.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            className="btn-secondary shrink-0 px-3 text-xs"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setMonth((prev) => startOfMonth(addMonths(prev, -1)))}
            className="btn-secondary px-3 text-xs"
          >
            Previous month
          </button>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{format(month, 'MMMM yyyy')}</p>
          <button
            type="button"
            onClick={() => setMonth((prev) => startOfMonth(addMonths(prev, 1)))}
            className="btn-secondary px-3 text-xs"
          >
            Next month
          </button>
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">{error}</p>
        )}
      </section>

      {!loading && (
        <div className="card-surface bg-zinc-50/80 p-4 dark:bg-zinc-900/60 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">vs prior month</p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-zinc-200/90 bg-white p-3 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Budgeted</p>
              <p className="mt-1 font-semibold text-zinc-900 dark:text-zinc-50">{formatCurrencyFromCents(totals.budgeted)}</p>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                {signedBudgetDelta(totals.budgeted, prevTotals.budgeted, 'Same as last month')}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200/90 bg-white p-3 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Spent</p>
              <p className="mt-1 font-semibold text-zinc-900 dark:text-zinc-50">{formatCurrencyFromCents(totals.spent)}</p>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{signedSpendDelta(totals.spent, prevTotals.spent)}</p>
            </div>
            <div className="rounded-xl border border-zinc-200/90 bg-white p-3 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Remaining</p>
              <p className="mt-1 font-semibold text-zinc-900 dark:text-zinc-50">{formatCurrencyFromCents(totals.remaining)}</p>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                {signedBudgetDelta(totals.remaining, prevTotals.remaining, 'Same as last month')}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200/90 bg-white p-3 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Paychecks (deposits)</p>
              <p className="mt-1 font-semibold text-zinc-900 dark:text-zinc-50">{formatCurrencyFromCents(paycheckMonthNet)}</p>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                {signedBudgetDelta(paycheckMonthNet, prevTotals.paycheckNet, 'Same as last month')}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Budgeted (allocations)"
          value={loading ? '—' : formatCurrencyFromCents(totals.budgeted)}
          sub="Paycheck funds assigned to this budget month"
        />
        <StatCard
          label="Spent (envelope tx)"
          value={loading ? '—' : formatCurrencyFromCents(totals.spent)}
          sub="Positive amounts on envelope-linked transactions"
        />
        <StatCard
          label="Remaining"
          value={loading ? '—' : formatCurrencyFromCents(totals.remaining)}
          sub={totals.remaining < 0 ? 'Over budget for the month' : 'Budgeted minus spent'}
          highlight={
            loading ? undefined : totals.remaining < 0 ? 'bad' : totals.remaining === 0 ? 'warn' : 'good'
          }
        />
        <StatCard label="% of budget used" value={loading ? '—' : `${totalPercent}%`} sub="Across all envelopes" />
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-emerald-50/90 to-white p-4 dark:border-zinc-800 dark:from-emerald-950/30 dark:to-zinc-950 sm:p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-emerald-900 dark:text-emerald-200">Month progress</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
          <p className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {loading ? '—' : `${Math.min(totalPercent, 999)}%`}
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            {loading ? '—' : `${formatCurrencyFromCents(totals.spent)} of ${formatCurrencyFromCents(totals.budgeted)} budgeted`}
          </p>
        </div>
        <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-white/80 dark:bg-zinc-800/80">
          {!loading && (
            <div
              className={[
                'h-full rounded-full transition-all',
                totalPercent > 100 ? 'bg-red-500' : totalPercent >= 85 ? 'bg-amber-500' : 'bg-emerald-500',
              ].join(' ')}
              style={{ width: `${Math.min(totalPercent, 100)}%` }}
            />
          )}
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Cash accounts"
          value={loading ? '—' : formatCurrencyFromCents(cashAccountsTotal)}
          sub="Checking, savings, cash"
        />
        <StatCard
          label="In envelopes (excl. debt)"
          value={loading ? '—' : formatCurrencyFromCents(envelopeCashExDebt)}
          sub="Assigned category balances"
        />
        <StatCard
          label="Liabilities (ledger)"
          value={loading ? '—' : formatCurrencyFromCents(liabilityLedgerSum)}
          sub={
            liabilityAccounts.length === 0
              ? 'No card or loan accounts'
              : `${liabilityAccounts.length} account${liabilityAccounts.length === 1 ? '' : 's'}`
          }
        />
        <StatCard
          label="Paychecks (this month)"
          value={loading ? '—' : formatCurrencyFromCents(paycheckMonthNet)}
          sub={paycheckMonthCount === 0 ? 'None dated in range' : `${paycheckMonthCount} deposit${paycheckMonthCount === 1 ? '' : 's'}`}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <CollapsibleCard title="Debt snapshot" storageKey="dash-debt" defaultCollapsed={liabilityAccounts.length === 0}>
          {loading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
          ) : liabilityAccounts.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Add a credit card or loan under{' '}
              <Link to="/accounts" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
                Accounts
              </Link>
              .
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-zinc-700 dark:text-zinc-300">
                Combined ledger: <span className="font-semibold">{formatCurrencyFromCents(liabilityLedgerSum)}</span>
                <span className="text-zinc-500 dark:text-zinc-400"> · </span>
                Approx. owed (sum of abs balances):{' '}
                <span className="font-semibold">{formatCurrencyFromCents(liabilityApproxOwed)}</span>
              </p>
              <ul className="space-y-1.5">
                {liabilityAccounts.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex justify-between gap-2 border-b border-zinc-100 pb-1 dark:border-zinc-800/80">
                    <span className="min-w-0 truncate font-medium">{a.name}</span>
                    <span className="shrink-0">{formatCurrencyFromCents(a.balance_cents)}</span>
                  </li>
                ))}
              </ul>
              {liabilityAccounts.length > 5 && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">+{liabilityAccounts.length - 5} more on Debt Tracker</p>
              )}
              <Link
                to="/debt"
                className="inline-flex min-h-9 items-center rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700"
              >
                Open Debt Tracker
              </Link>
            </div>
          )}
        </CollapsibleCard>

        <CollapsibleCard title="Savings goals (preview)" storageKey="dash-savings" defaultCollapsed={savingsPreview.length === 0}>
          {loading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
          ) : savingsPreview.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No savings-type envelopes. Add one on{' '}
              <Link to="/envelopes" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
                Envelopes
              </Link>{' '}
              or see{' '}
              <Link to="/savings" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
                Savings Goals
              </Link>
              .
            </p>
          ) : (
            <ul className="space-y-3">
              {savingsPreview.map((env) => {
                const row = budgetRows.find((r) => r.envelopeId === env.id)
                const assigned = row?.budgetedCents ?? 0
                const cap = env.goal_type === 'refill_up_to' ? env.goal_target_cents ?? 0 : 0
                const pctAssign =
                  env.budget_target_cents > 0 ? Math.min(100, Math.round((assigned / env.budget_target_cents) * 100)) : 0
                const pctRefill =
                  cap > 0 ? Math.min(100, Math.round((Math.min(Math.max(env.balance_cents, 0), cap) / cap) * 100)) : 0
                return (
                  <li key={env.id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                    <p className="font-medium text-zinc-900 dark:text-zinc-50">{env.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Balance {formatCurrencyFromCents(env.balance_cents)}
                      {env.goal_type === 'refill_up_to' && cap > 0
                        ? ` · cap ${formatCurrencyFromCents(cap)}`
                        : env.budget_target_cents > 0
                          ? ` · monthly target ${formatCurrencyFromCents(env.budget_target_cents)}`
                          : ''}
                    </p>
                    {env.goal_type === 'refill_up_to' && cap > 0 ? (
                      <>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                          <div className="h-full rounded-full bg-sky-500" style={{ width: `${pctRefill}%` }} />
                        </div>
                        <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">Progress toward cap</p>
                      </>
                    ) : env.budget_target_cents > 0 ? (
                      <>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pctAssign}%` }} />
                        </div>
                        <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                          Assigned this month {formatCurrencyFromCents(assigned)} / {formatCurrencyFromCents(env.budget_target_cents)}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">No monthly target or cap set.</p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CollapsibleCard>
      </div>

      <CollapsibleCard title="Bills due in this month" storageKey="dash-bills-month" defaultCollapsed={billsInViewMonth.length === 0}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Uses each envelope&apos;s due day and the calendar month you selected above ({format(month, 'MMMM yyyy')}).
        </p>
        {loading ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : billsInViewMonth.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            No bill due days fall in this month, or none are configured. Edit envelopes under{' '}
            <Link to="/envelopes" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
              Envelopes
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {billsInViewMonth.map(({ e, due }) => {
              const mk = monthKeyFromDate(due)
              const paid = isBillPaidForMonth(e.bill_paid_by_month, mk)
              const busy = billPaidBusyId === e.id
              return (
                <li
                  key={e.id}
                  className="flex flex-col gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{e.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {formatDueDayPhrase(e.due_day_of_month)}
                      {e.budget_target_cents > 0 ? ` · ${formatCurrencyFromCents(e.budget_target_cents)}/mo target` : ''}
                    </p>
                    {paid && (
                      <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">Marked paid for {mk}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-emerald-800 dark:text-emerald-200">{format(due, 'MMM d')}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleBillPaid(e, mk, !paid)}
                      className={[
                        'min-h-9 rounded-lg border px-3 text-xs font-medium',
                        paid
                          ? 'border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-200'
                          : 'border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-100',
                      ].join(' ')}
                    >
                      {busy ? '…' : paid ? 'Unmark' : 'Mark paid'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CollapsibleCard>

      {isViewingCurrentMonth && (
        <CollapsibleCard title="Next up (from today)" storageKey="dash-bills-soon" defaultCollapsed={upcomingFromToday.length === 0}>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Bill envelopes with a due day, sorted by nearest next due date.</p>
          {loading ? (
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
          ) : upcomingFromToday.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No due days configured on non-debt envelopes.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {upcomingFromToday.map((e) => {
                const next = nextDueDateOnOrAfter(e.due_day_of_month!, new Date())
                const days = daysUntilNextDue(e.due_day_of_month!, new Date())
                const mk = monthKeyFromDate(next)
                const paid = isBillPaidForMonth(e.bill_paid_by_month, mk)
                const busy = billPaidBusyId === e.id
                return (
                  <li
                    key={e.id}
                    className="flex flex-col gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">{e.name}</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Next {format(next, 'MMM d, yyyy')} ({mk})
                      </p>
                      {paid && (
                        <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">Marked paid</p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-sky-800 dark:text-sky-200">
                        {days === 0 ? 'Due today' : days === 1 ? 'Tomorrow' : `In ${days} days`}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void toggleBillPaid(e, mk, !paid)}
                        className={[
                          'min-h-9 rounded-lg border px-3 text-xs font-medium',
                          paid
                            ? 'border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-200'
                            : 'border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-100',
                        ].join(' ')}
                      >
                        {busy ? '…' : paid ? 'Unmark' : 'Mark paid'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CollapsibleCard>
      )}

      <CollapsibleCard title="Budget vs actual (top categories)" storageKey="dash-mini-budget" defaultCollapsed>
        {loading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : miniBudget.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No budget or spend data for envelopes this month.</p>
        ) : (
          <div className="table-frame">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
                  <th className="w-[32%] p-2.5 align-top">Envelope</th>
                  <th className="w-[22%] p-2.5 align-top">Budgeted</th>
                  <th className="w-[22%] p-2.5 align-top">Spent</th>
                  <th className="w-[12%] p-2.5 align-top">%</th>
                  <th className="w-[12%] p-2.5 align-top">Left</th>
                </tr>
              </thead>
              <tbody>
                {miniBudget.map((r) => (
                  <tr key={r.envelopeId} className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="min-w-0 p-2.5 align-top break-words font-medium">{r.envelopeName}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(r.budgetedCents)}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(r.spentCents)}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{r.percentUsed}%</td>
                    <td
                      className={[
                        'p-2.5 align-top whitespace-nowrap',
                        r.remainingCents < 0 ? 'text-red-700 dark:text-red-300' : '',
                      ].join(' ')}
                    >
                      {formatCurrencyFromCents(r.remainingCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          <Link to="/budget" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
            Open full Budget vs Actual
          </Link>
        </p>
      </CollapsibleCard>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <CollapsibleCard title="Need attention" storageKey="dash-attention" defaultCollapsed={overspent.length === 0 && overBudget.length === 0}>
          {loading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
          ) : overspent.length === 0 && overBudget.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No overspent envelopes and no categories over 100% of budget.</p>
          ) : (
            <ul className="mt-1 space-y-3 text-sm">
              {overspent.length > 0 && (
                <li>
                  <p className="text-xs font-semibold uppercase tracking-wide text-red-800 dark:text-red-200">Negative balance</p>
                  <ul className="mt-1 space-y-1.5">
                    {overspent.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2">
                        <Link
                          to="/envelopes"
                          className="min-w-0 font-medium text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-200"
                        >
                          {e.name}
                        </Link>
                        <span className="shrink-0 text-red-700 dark:text-red-300">{formatCurrencyFromCents(e.balance_cents)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              )}
              {overBudget.length > 0 && (
                <li>
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-100">Over 100% of monthly budget</p>
                  <ul className="mt-1 space-y-1.5">
                    {overBudget.map((r) => (
                      <li key={r.envelopeId} className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="min-w-0 font-medium text-zinc-900 dark:text-zinc-100">{r.envelopeName}</span>
                        <span className="shrink-0 text-amber-800 dark:text-amber-200">{r.percentUsed}%</span>
                      </li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          )}
        </CollapsibleCard>

        <CollapsibleCard title="Top spending (this month)" storageKey="dash-top-spend" defaultCollapsed>
          {loading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
          ) : hotCategories.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No envelope spending dated in this month.</p>
          ) : (
            <ol className="mt-1 list-decimal space-y-2 pl-5 text-sm">
              {hotCategories.map((r) => (
                <li key={r.envelopeId} className="text-zinc-800 dark:text-zinc-200">
                  <span className="font-medium">{r.envelopeName}</span>
                  <span className="text-zinc-500 dark:text-zinc-400"> — </span>
                  <span className="text-red-700 dark:text-red-300">{formatCurrencyFromCents(r.spentCents)}</span>
                  {r.budgetedCents > 0 && (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400"> ({r.percentUsed}% of budget)</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </CollapsibleCard>
      </div>

      <CollapsibleCard title="Recent transactions" storageKey="dash-recent-tx" defaultCollapsed>
        {loading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : recentTx.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No transactions yet.{' '}
            <Link to="/transactions" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
              Add or import
            </Link>
            .
          </p>
        ) : (
          <div className="mt-2 min-w-0 overflow-x-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
                  <th className="w-[18%] p-2.5 align-top">Date</th>
                  <th className="w-[40%] p-2.5 align-top">Payee</th>
                  <th className="w-[22%] p-2.5 align-top">Category / account</th>
                  <th className="w-[20%] p-2.5 align-top">Amount</th>
                </tr>
              </thead>
              <tbody>
                {recentTx.map((t) => {
                  const cat = joinName(t.envelope, '') || joinName(t.account, '—')
                  return (
                    <tr key={t.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                      <td className="p-2.5 align-top whitespace-nowrap text-zinc-600 dark:text-zinc-400">{t.date}</td>
                      <td className="min-w-0 p-2.5 align-top break-words font-medium">{t.payee}</td>
                      <td className="min-w-0 p-2.5 align-top break-words text-xs text-zinc-600 dark:text-zinc-400">{cat || '—'}</td>
                      <td className="p-2.5 align-top font-medium whitespace-nowrap">{formatCurrencyFromCents(t.amount_cents)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          <Link to="/transactions" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
            View all transactions
          </Link>
        </p>
      </CollapsibleCard>

      <CollapsibleCard title="Shortcuts" storageKey="dash-shortcuts" defaultCollapsed>
        <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Shortcut to="/journal" title="Paycheck Journal" body="Log income and allocations" />
          <Shortcut to="/transactions" title="Transactions" body="Register, import, and reconcile" />
          <Shortcut to="/envelopes" title="Envelopes" body="Balances, due days, moves" />
          <Shortcut to="/budget" title="Budget vs Actual" body="Month detail by envelope" />
          <Shortcut to="/reports" title="Reports" body="Trends, exports, PDF" />
          <Shortcut to="/debt" title="Debt Tracker" body="Paydown and payoff outlook" />
          <Shortcut to="/savings" title="Savings Goals" body="Targets and progress" />
          <Shortcut to="/accounts" title="Accounts" body="Ledgers and debt payments" />
        </ul>
      </CollapsibleCard>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string
  value: string
  sub: string
  highlight?: 'good' | 'warn' | 'bad'
}) {
  const tone =
    highlight === 'bad'
      ? 'text-red-700 dark:text-red-300'
      : highlight === 'warn'
        ? 'text-amber-800 dark:text-amber-200'
        : highlight === 'good'
          ? 'text-emerald-800 dark:text-emerald-200'
          : 'text-zinc-900 dark:text-zinc-50'
  return (
    <div className="min-w-0 rounded-xl border border-zinc-200/90 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="break-words text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={['mt-1 break-words text-lg font-semibold tracking-tight', tone].join(' ')}>{value}</p>
      <p className="mt-1 break-words text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</p>
    </div>
  )
}

function Shortcut({ to, title, body }: { to: string; title: string; body: string }) {
  return (
    <li>
      <Link
        to={to}
        className="block rounded-xl border border-zinc-200/90 bg-white px-3 py-2.5 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50/60 dark:border-zinc-800 dark:bg-zinc-950/30 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/30"
      >
        <span className="font-medium text-emerald-800 dark:text-emerald-200">{title}</span>
        <span className="mt-0.5 block text-xs text-zinc-600 dark:text-zinc-400">{body}</span>
      </Link>
    </li>
  )
}
