import { useCallback, useEffect, useMemo, useState } from 'react'
import { addMonths, format, subDays } from 'date-fns'
import { Link } from 'react-router-dom'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import {
  dollarsStringToCents,
  formatAccountDropdownLabel,
  formatCurrencyFromCents,
  formatEnvelopeDropdownLabel,
  normalizeDollarsInput,
} from '../lib/currency'
import { syncDebtEnvelopeMonthlyGoalFromMinimum } from '../lib/debtEnvelopeSync'
import {
  modelMonthlyPaymentCents,
  simulateCombinedDebtPayoff,
  simulateDebtPayoff,
} from '../lib/debtPayoff'
import { getSupabase } from '../lib/supabase'

type AccountType = 'checking' | 'savings' | 'credit_card' | 'debt' | 'cash' | 'other'

type LiabilityAccount = {
  id: string
  name: string
  account_type: 'credit_card' | 'debt'
  balance_cents: number
  apr_bps: number | null
  minimum_payment_cents: number | null
  planned_monthly_payment_cents: number | null
}

type EnvelopeRow = {
  id: string
  name: string
  type: string
  balance_cents: number
  sort_order: number
  group_id: string | null
}

type EnvelopeGroup = {
  id: string
  name: string
  sort_order: number
  archived: boolean
}

type LiabilityTx = {
  id: string
  date: string
  payee: string
  amount_cents: number
  transaction_kind: string
  account_id: string | null
}

/** Max “extra per month” on sliders ($50k); step $25 for fine control at lower amounts. */
const EXTRA_SLIDER_MAX_CENTS = 5_000_000
const EXTRA_SLIDER_STEP_CENTS = 2_500

function estimatedMonthlyInterestCents(balanceCents: number, aprBps: number | null): number | null {
  if (aprBps == null || aprBps <= 0 || balanceCents === 0) return null
  const annualFraction = aprBps / 1_000_000
  return Math.round(Math.abs(balanceCents) * annualFraction / 12)
}

export function DebtPage() {
  const [liabilities, setLiabilities] = useState<LiabilityAccount[]>([])
  const [envelopes, setEnvelopes] = useState<EnvelopeRow[]>([])
  const [envelopeGroups, setEnvelopeGroups] = useState<EnvelopeGroup[]>([])
  const [allAccounts, setAllAccounts] = useState<
    Array<{ id: string; name: string; account_type: AccountType; balance_cents: number }>
  >([])
  const [recentTx, setRecentTx] = useState<LiabilityTx[]>([])
  const [avgPaymentByAccount, setAvgPaymentByAccount] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [paySettingsDraft, setPaySettingsDraft] = useState<Record<string, { min: string; planned: string }>>({})
  const [extraSliderCentsByAccount, setExtraSliderCentsByAccount] = useState<Record<string, number>>({})
  const [combinedPooledExtraCents, setCombinedPooledExtraCents] = useState(0)

  const [payDate, setPayDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [payFromAccountId, setPayFromAccountId] = useState('')
  const [payToLiabilityId, setPayToLiabilityId] = useState('')
  const [payFromEnvelopeId, setPayFromEnvelopeId] = useState('')
  const [payAmountDollars, setPayAmountDollars] = useState('')
  const [payNote, setPayNote] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const [accountsResp, groupsResp, envResp] = await Promise.all([
        supabase
          .from('financial_accounts')
          .select(
            'id,name,account_type,balance_cents,apr_bps,archived,minimum_payment_cents,planned_monthly_payment_cents',
          )
          .eq('archived', false)
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
        supabase
          .from('envelope_groups')
          .select('id,name,sort_order,archived')
          .order('sort_order', { ascending: true }),
        supabase
          .from('envelopes')
          .select('id,name,type,balance_cents,sort_order,group_id')
          .eq('archived', false)
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
      ])
      if (accountsResp.error) throw accountsResp.error
      if (groupsResp.error) throw groupsResp.error
      if (envResp.error) throw envResp.error

      const loaded = (accountsResp.data ?? []) as Array<{
        id: string
        name: string
        account_type: AccountType
        balance_cents: number
        apr_bps: number | null
        minimum_payment_cents: number | null
        planned_monthly_payment_cents: number | null
      }>
      setAllAccounts(loaded)
      const liab = loaded.filter((a): a is LiabilityAccount => {
        return a.account_type === 'credit_card' || a.account_type === 'debt'
      })
      setLiabilities(liab)
      setEnvelopeGroups((groupsResp.data ?? []) as EnvelopeGroup[])
      setEnvelopes((envResp.data ?? []) as EnvelopeRow[])

      const liabIds = liab.map((a) => a.id)
      if (liabIds.length > 0) {
        const [txResp, payResp] = await Promise.all([
          supabase
            .from('transactions')
            .select('id,date,payee,amount_cents,transaction_kind,account_id')
            .eq('archived', false)
            .in('account_id', liabIds)
            .order('date', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(50),
          supabase
            .from('transactions')
            .select('account_id,amount_cents')
            .eq('archived', false)
            .eq('transaction_kind', 'payment')
            .in('account_id', liabIds)
            .gte('date', format(subDays(new Date(), 120), 'yyyy-MM-dd')),
        ])
        if (txResp.error) throw txResp.error
        if (payResp.error) throw payResp.error
        setRecentTx((txResp.data ?? []) as LiabilityTx[])

        const buckets: Record<string, number[]> = {}
        for (const row of (payResp.data ?? []) as Array<{ account_id: string; amount_cents: number }>) {
          if (!row.account_id) continue
          const size = Math.abs(row.amount_cents)
          if (size <= 0) continue
          if (!buckets[row.account_id]) buckets[row.account_id] = []
          buckets[row.account_id].push(size)
        }
        const avgs: Record<string, number> = {}
        for (const [id, arr] of Object.entries(buckets)) {
          avgs[id] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
        }
        setAvgPaymentByAccount(avgs)
      } else {
        setRecentTx([])
        setAvgPaymentByAccount({})
      }

      const cashIds = loaded.filter((a) => a.account_type !== 'credit_card' && a.account_type !== 'debt').map((a) => a.id)
      setPayFromAccountId((prev) => (prev && cashIds.includes(prev) ? prev : cashIds[0] ?? ''))
      setPayToLiabilityId((prev) => (prev && liabIds.includes(prev) ? prev : liabIds[0] ?? ''))
      setPayFromEnvelopeId((prev) => prev || (envResp.data?.[0] as EnvelopeRow | undefined)?.id || '')

      const drafts: Record<string, { min: string; planned: string }> = {}
      const extras: Record<string, number> = {}
      for (const L of liab) {
        drafts[L.id] = {
          min: L.minimum_payment_cents != null ? (L.minimum_payment_cents / 100).toFixed(2) : '',
          planned: L.planned_monthly_payment_cents != null ? (L.planned_monthly_payment_cents / 100).toFixed(2) : '',
        }
        extras[L.id] = 0
      }
      setPaySettingsDraft(drafts)
      setExtraSliderCentsByAccount(extras)
      setCombinedPooledExtraCents(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load debt data.'
      if (msg.includes('minimum_payment') || msg.includes('planned_monthly')) {
        setError(
          `${msg} Apply the latest Supabase migration (debt payoff columns) if you have not already.`,
        )
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const envelopeByLiabilityName = useMemo(() => {
    const map = new Map<string, EnvelopeRow>()
    for (const e of envelopes) {
      if (e.type === 'debt' && !map.has(e.name)) map.set(e.name, e)
    }
    return map
  }, [envelopes])
  const orderedEnvelopes = useMemo(
    () =>
      [...envelopes].sort((a, b) =>
        a.sort_order === b.sort_order ? a.name.localeCompare(b.name) : a.sort_order - b.sort_order,
      ),
    [envelopes],
  )
  const groupedEnvelopeOptions = useMemo(() => {
    const activeGroups = envelopeGroups
      .filter((group) => !group.archived)
      .sort((a, b) => a.sort_order - b.sort_order)
    const grouped = activeGroups
      .map((group) => ({
        id: group.id,
        label: group.name,
        envelopes: orderedEnvelopes.filter((envelope) => envelope.group_id === group.id),
      }))
      .filter((group) => group.envelopes.length > 0)
    const ungrouped = orderedEnvelopes.filter((envelope) => !envelope.group_id)
    if (ungrouped.length > 0) grouped.push({ id: 'ungrouped', label: 'Ungrouped', envelopes: ungrouped })
    return grouped
  }, [envelopeGroups, orderedEnvelopes])

  const cashAccounts = useMemo(
    () => allAccounts.filter((a) => a.account_type !== 'credit_card' && a.account_type !== 'debt'),
    [allAccounts],
  )

  const totalLiabilityCents = useMemo(
    () => liabilities.reduce((sum, a) => sum + a.balance_cents, 0),
    [liabilities],
  )

  async function savePaySettings(accountId: string) {
    const draft = paySettingsDraft[accountId]
    const minCents = dollarsStringToCents(draft?.min?.trim() ?? '')
    const planCents = dollarsStringToCents(draft?.planned?.trim() ?? '')
    if (draft?.min?.trim() && minCents == null) {
      setError('Minimum payment must be a valid amount or empty.')
      return
    }
    if (draft?.planned?.trim() && planCents == null) {
      setError('Planned payment must be a valid amount or empty.')
      return
    }
    if (minCents != null && planCents != null && planCents < minCents) {
      setError('Planned monthly payment cannot be less than the minimum.')
      return
    }

    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const supabase = getSupabase()
      const { error: up } = await supabase
        .from('financial_accounts')
        .update({
          minimum_payment_cents: draft?.min?.trim() ? minCents : null,
          planned_monthly_payment_cents: draft?.planned?.trim() ? planCents : null,
        })
        .eq('id', accountId)
      if (up) throw up
      const acc = liabilities.find((a) => a.id === accountId)
      if (acc?.name) {
        const { error: syncErr } = await syncDebtEnvelopeMonthlyGoalFromMinimum(supabase, {
          liabilityAccountName: acc.name,
          minimumPaymentCents: draft?.min?.trim() ? minCents : null,
        })
        if (syncErr) throw syncErr
      }
      setNotice('Payment settings saved. Minimum is stored on the account and applied to the matching debt envelope goal.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings.')
    } finally {
      setSaving(false)
    }
  }

  async function submitPayment() {
    const amountCents = dollarsStringToCents(payAmountDollars)
    if (!payFromAccountId || !payToLiabilityId) {
      setError('Choose the cash account you pay from and the card or loan you pay toward.')
      return
    }
    if (!payFromEnvelopeId) {
      setError('Choose the envelope that funds this payment.')
      return
    }
    if (payFromAccountId === payToLiabilityId) {
      setError('From and to must be different.')
      return
    }
    const toAcc = liabilities.find((a) => a.id === payToLiabilityId)
    if (!toAcc) {
      setError('Pick a valid credit card or debt account.')
      return
    }
    const fromAcc = allAccounts.find((a) => a.id === payFromAccountId)
    if (fromAcc && (fromAcc.account_type === 'credit_card' || fromAcc.account_type === 'debt')) {
      setError('Pay from a checking, savings, cash, or other account.')
      return
    }
    if (amountCents == null || amountCents <= 0) {
      setError('Enter a payment amount greater than zero.')
      return
    }

    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: rpcError } = await getSupabase().rpc('create_debt_payment', {
        p_date: payDate,
        p_amount_cents: amountCents,
        p_from_account_id: payFromAccountId,
        p_to_account_id: payToLiabilityId,
        p_from_envelope_id: payFromEnvelopeId,
        p_note: payNote.trim() || null,
        p_cleared: true,
      })
      if (rpcError) throw rpcError
      setPayAmountDollars('')
      setPayNote('')
      setNotice('Payment recorded.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record payment.')
    } finally {
      setSaving(false)
    }
  }

  function txKindLabel(kind: string): string {
    if (kind === 'payment') return 'Payment'
    if (kind === 'interest') return 'Interest'
    if (kind === 'refund') return 'Refund'
    if (kind === 'transfer') return 'Transfer'
    return 'Charge / activity'
  }

  function payoffSummaryForAccount(acc: LiabilityAccount) {
    const draft = paySettingsDraft[acc.id] ?? { min: '', planned: '' }
    const minParsed = dollarsStringToCents(draft.min.trim())
    const plannedParsed = dollarsStringToCents(draft.planned.trim())
    const minStored = acc.minimum_payment_cents ?? 0
    const plannedStored = acc.planned_monthly_payment_cents
    const minC = minParsed ?? minStored
    const plannedC = plannedParsed ?? plannedStored
    const avgC = avgPaymentByAccount[acc.id] ?? 0
    const baseModel = modelMonthlyPaymentCents({
      minimumCents: minC,
      plannedCents: plannedC ?? null,
      avgPaymentCents: avgC,
    })
    const extra = extraSliderCentsByAccount[acc.id] ?? 0
    const totalPay = baseModel + extra
    const sim = simulateDebtPayoff({
      balanceCents: acc.balance_cents,
      aprBps: acc.apr_bps,
      monthlyPaymentCents: totalPay,
    })
    const payoffDate =
      sim.months != null && sim.months > 0 ? addMonths(new Date(), sim.months) : sim.months === 0 ? new Date() : null
    return { baseModel, totalPay, sim, payoffDate, minC, plannedC, avgC }
  }

  const combinedDebtLines = useMemo(() => {
    return liabilities.map((acc) => {
      const draft = paySettingsDraft[acc.id] ?? { min: '', planned: '' }
      const minParsed = dollarsStringToCents(draft.min.trim())
      const plannedParsed = dollarsStringToCents(draft.planned.trim())
      const minC = minParsed ?? (acc.minimum_payment_cents ?? 0)
      const plannedC = plannedParsed ?? acc.planned_monthly_payment_cents
      const avgC = avgPaymentByAccount[acc.id] ?? 0
      const monthlyFloorCents = modelMonthlyPaymentCents({
        minimumCents: minC,
        plannedCents: plannedC ?? null,
        avgPaymentCents: avgC,
      })
      return {
        id: acc.id,
        name: acc.name,
        balanceCents: acc.balance_cents,
        aprBps: acc.apr_bps,
        monthlyFloorCents,
      }
    })
  }, [liabilities, paySettingsDraft, avgPaymentByAccount])

  const combinedSumFloorsCents = useMemo(
    () => combinedDebtLines.reduce((s, d) => s + d.monthlyFloorCents, 0),
    [combinedDebtLines],
  )

  const combinedSimAvalanche = useMemo(
    () =>
      simulateCombinedDebtPayoff({
        debts: combinedDebtLines,
        strategy: 'avalanche',
        pooledExtraCentsPerMonth: combinedPooledExtraCents,
      }),
    [combinedDebtLines, combinedPooledExtraCents],
  )

  const combinedSimSnowball = useMemo(
    () =>
      simulateCombinedDebtPayoff({
        debts: combinedDebtLines,
        strategy: 'snowball',
        pooledExtraCentsPerMonth: combinedPooledExtraCents,
      }),
    [combinedDebtLines, combinedPooledExtraCents],
  )

  return (
    <div className="space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface p-4 sm:p-6">
        <h1 className="section-title">Debt tracker</h1>
        <p className="section-subtitle">
          Credit cards and loans with payoff projections (minimums, planned paydown, and your recent payment average).
          Log purchases in{' '}
          <Link to="/transactions" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
            Transactions
          </Link>
          ; income stays in the{' '}
          <Link to="/journal" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
            Paycheck Journal
          </Link>
          .
        </p>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">{error}</p>
        )}
        {notice && (
          <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
            {notice}
          </p>
        )}
      </section>

      <CollapsibleCard title="Overview" storageKey="debt-overview">
        {loading ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : liabilities.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            No credit card or debt accounts yet. Add one under{' '}
            <Link to="/accounts" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
              Accounts
            </Link>
            .
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              Combined ledger balance (all cards & loans):{' '}
              <span className="font-semibold">{formatCurrencyFromCents(totalLiabilityCents)}</span>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {liabilities.map((acc) => {
                const linked = envelopeByLiabilityName.get(acc.name)
                const estInt = estimatedMonthlyInterestCents(acc.balance_cents, acc.apr_bps)
                return (
                  <div key={acc.id} className="rounded-xl border border-zinc-200/90 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      {acc.account_type.replace('_', ' ')}
                    </p>
                    <p className="mt-0.5 text-sm font-semibold">{acc.name}</p>
                    <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                      {formatCurrencyFromCents(acc.balance_cents)}
                    </p>
                    {acc.apr_bps != null && (
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        APR {(acc.apr_bps / 10000).toFixed(2)}%
                        {estInt != null && estInt > 0
                          ? ` · rough monthly interest (simple): ~${formatCurrencyFromCents(estInt)}`
                          : null}
                      </p>
                    )}
                    {linked ? (
                      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
                        Payment envelope “{linked.name}”:{' '}
                        <span className="font-medium">{formatCurrencyFromCents(linked.balance_cents)}</span> assigned
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                        No debt envelope with the same name—create a debt envelope named “{acc.name}” for envelope-side
                        tracking.
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="All debts combined (avalanche vs snowball)" storageKey="debt-combined">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Uses each debt’s same <strong>modeled floor</strong> as below (max of minimum, planned, and recent average
          payment). Total cash to debt each month stays <strong>fixed</strong>: sum of those floors + one pooled extra.
          Floors are paid first; anything left goes to <strong>avalanche</strong> priority (highest APR first) or{' '}
          <strong>snowball</strong> priority (smallest balance first). When a debt is paid off, its floor drops out, so
          the same total payment accelerates what is left—classic rolled snowball behavior.
        </p>
        {loading || liabilities.length === 0 ? null : (
          <div className="mt-4 space-y-4">
            <div>
              <p className="text-sm text-zinc-700 dark:text-zinc-200">
                Sum of modeled floors:{' '}
                <span className="font-semibold">{formatCurrencyFromCents(combinedSumFloorsCents)}</span> / mo + pooled
                extra ={' '}
                <span className="font-semibold">
                  {formatCurrencyFromCents(combinedSumFloorsCents + combinedPooledExtraCents)}
                </span>{' '}
                / mo total toward all debts.
              </p>
              <label className="mt-3 block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                Pooled extra per month (directed by strategy){' '}
                <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                  +{formatCurrencyFromCents(combinedPooledExtraCents)}
                </span>
              </label>
              <input
                type="range"
                min={0}
                max={EXTRA_SLIDER_MAX_CENTS}
                step={EXTRA_SLIDER_STEP_CENTS}
                value={combinedPooledExtraCents}
                onChange={(e) => setCombinedPooledExtraCents(Number(e.target.value))}
                className="mt-2 w-full accent-emerald-600"
              />
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                Same range as per-debt sliders: up to {formatCurrencyFromCents(EXTRA_SLIDER_MAX_CENTS)} in{' '}
                {formatCurrencyFromCents(EXTRA_SLIDER_STEP_CENTS)} steps.
              </p>
            </div>

            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-left dark:border-zinc-800 dark:bg-zinc-900/80">
                    <th className="p-2.5 font-medium text-zinc-700 dark:text-zinc-200"> </th>
                    <th className="p-2.5 font-medium text-emerald-800 dark:text-emerald-200">Avalanche</th>
                    <th className="p-2.5 font-medium text-emerald-800 dark:text-emerald-200">Snowball</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-800 dark:text-zinc-100">
                  <tr className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="p-2.5 text-zinc-600 dark:text-zinc-400">Last debt paid off (est.)</td>
                    <td className="p-2.5 font-medium">
                      {combinedSimAvalanche.months === 0 ? (
                        'No balances'
                      ) : combinedSimAvalanche.months != null && combinedSimAvalanche.months > 0 ? (
                        <>
                          {format(addMonths(new Date(), combinedSimAvalanche.months), 'MMMM yyyy')}
                          <span className="ml-1 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                            ({combinedSimAvalanche.months} mo)
                          </span>
                        </>
                      ) : (
                        <span className="text-xs font-normal text-amber-800 dark:text-amber-200">
                          {combinedSimAvalanche.neverReason ?? '—'}
                        </span>
                      )}
                    </td>
                    <td className="p-2.5 font-medium">
                      {combinedSimSnowball.months === 0 ? (
                        'No balances'
                      ) : combinedSimSnowball.months != null && combinedSimSnowball.months > 0 ? (
                        <>
                          {format(addMonths(new Date(), combinedSimSnowball.months), 'MMMM yyyy')}
                          <span className="ml-1 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                            ({combinedSimSnowball.months} mo)
                          </span>
                        </>
                      ) : (
                        <span className="text-xs font-normal text-amber-800 dark:text-amber-200">
                          {combinedSimSnowball.neverReason ?? '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="p-2.5 text-zinc-600 dark:text-zinc-400">Total interest (approx.)</td>
                    <td className="p-2.5">{formatCurrencyFromCents(combinedSimAvalanche.totalInterestCents)}</td>
                    <td className="p-2.5">{formatCurrencyFromCents(combinedSimSnowball.totalInterestCents)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {liabilities.length >= 2 && (
              <div>
                <p className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Individual debt paid off (first month all principal is gone)
                </p>
                <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <table className="min-w-full text-xs sm:text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 bg-zinc-50 text-left dark:border-zinc-800 dark:bg-zinc-900/80">
                        <th className="p-2 font-medium text-zinc-700 dark:text-zinc-200">Debt</th>
                        <th className="p-2 font-medium text-emerald-800 dark:text-emerald-200">Avalanche</th>
                        <th className="p-2 font-medium text-emerald-800 dark:text-emerald-200">Snowball</th>
                      </tr>
                    </thead>
                    <tbody>
                      {combinedDebtLines.map((row) => {
                        const avM = combinedSimAvalanche.payoffMonthById[row.id]
                        const sbM = combinedSimSnowball.payoffMonthById[row.id]
                        return (
                          <tr
                            key={row.id}
                            className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/80"
                          >
                            <td className="p-2 font-medium text-zinc-800 dark:text-zinc-100">{row.name}</td>
                            <td className="p-2 text-zinc-700 dark:text-zinc-300">
                              {avM != null ? (
                                <>
                                  {format(addMonths(new Date(), avM), 'MMM yyyy')}
                                  <span className="text-zinc-500"> ({avM} mo)</span>
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="p-2 text-zinc-700 dark:text-zinc-300">
                              {sbM != null ? (
                                <>
                                  {format(addMonths(new Date(), sbM), 'MMM yyyy')}
                                  <span className="text-zinc-500"> ({sbM} mo)</span>
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {liabilities.length === 1 && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                With only one debt, avalanche and snowball behave the same. Same monthly interest simplification as the
                per-debt outlook below.
              </p>
            )}
            {liabilities.length >= 2 && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Same monthly interest simplification as the per-debt outlook below—not your bank’s exact daily interest.
              </p>
            )}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Payoff outlook" storageKey="debt-payoff">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Each month we accrue interest on the balance (from APR), then apply your payment. The modeled payment is the
          largest of: <strong>minimum due</strong>, <strong>planned monthly</strong> you enter, and your{' '}
          <strong>average payment</strong> on this account over the last ~4 months (from posted payments). Use the
          slider to try additional dollars <em>per month on top of that</em> and see the payoff date move. Minimum due
          is stored on the account (here or under <Link to="/accounts" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">Accounts</Link>
          ); when you save it, the debt envelope with the same name gets that amount as its monthly assignment target.
        </p>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : liabilities.length === 0 ? null : (
          <div className="mt-4 space-y-6">
            {liabilities.map((acc) => {
              const draft = paySettingsDraft[acc.id] ?? { min: '', planned: '' }
              const { baseModel, totalPay, sim, payoffDate, avgC } = payoffSummaryForAccount(acc)
              const extraSlider = extraSliderCentsByAccount[acc.id] ?? 0

              return (
                <div key={acc.id} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{acc.name}</h3>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    Balance {formatCurrencyFromCents(acc.balance_cents)}
                    {acc.apr_bps != null ? ` · APR ${(acc.apr_bps / 10000).toFixed(2)}%` : ' · APR not set (interest treated as 0)'}
                  </p>

                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="text-xs text-zinc-600 dark:text-zinc-300">
                      <span className="mb-1 block font-medium">Minimum due / mo ($)</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft.min}
                        onChange={(e) =>
                          setPaySettingsDraft((prev) => ({
                            ...prev,
                            [acc.id]: { ...(prev[acc.id] ?? { min: '', planned: '' }), min: e.target.value },
                          }))
                        }
                        onBlur={(e) =>
                          setPaySettingsDraft((prev) => ({
                            ...prev,
                            [acc.id]: {
                              ...(prev[acc.id] ?? { min: '', planned: '' }),
                              min: normalizeDollarsInput(e.target.value),
                            },
                          }))
                        }
                        placeholder="0.00"
                        className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                      />
                    </label>
                    <label className="text-xs text-zinc-600 dark:text-zinc-300">
                      <span className="mb-1 block font-medium">Planned paydown / mo ($)</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft.planned}
                        onChange={(e) =>
                          setPaySettingsDraft((prev) => ({
                            ...prev,
                            [acc.id]: { ...(prev[acc.id] ?? { min: '', planned: '' }), planned: e.target.value },
                          }))
                        }
                        onBlur={(e) =>
                          setPaySettingsDraft((prev) => ({
                            ...prev,
                            [acc.id]: {
                              ...(prev[acc.id] ?? { min: '', planned: '' }),
                              planned: normalizeDollarsInput(e.target.value),
                            },
                          }))
                        }
                        placeholder="Optional"
                        className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                      />
                    </label>
                    <div className="text-xs text-zinc-600 dark:text-zinc-300 lg:col-span-2">
                      <p className="font-medium text-zinc-700 dark:text-zinc-200">Recent average payment</p>
                      <p className="mt-1 text-sm">
                        {avgC > 0 ? (
                          <>
                            {formatCurrencyFromCents(avgC)}{' '}
                            <span className="text-zinc-500">(mean of payments to this account, last ~120 days)</span>
                          </>
                        ) : (
                          <span className="text-zinc-500">No payments in window—set minimum or planned above.</span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void savePaySettings(acc.id)}
                      className="min-h-9 rounded-lg border border-zinc-300 px-3 text-xs font-medium dark:border-zinc-700"
                    >
                      Save minimum & planned
                    </button>
                  </div>

                  <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                    <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-200">
                      Extra pay per month (on top of modeled {formatCurrencyFromCents(baseModel)})
                      <span className="ml-2 font-semibold text-emerald-700 dark:text-emerald-300">
                        +{formatCurrencyFromCents(extraSlider)}
                      </span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={EXTRA_SLIDER_MAX_CENTS}
                      step={EXTRA_SLIDER_STEP_CENTS}
                      value={extraSlider}
                      onChange={(e) =>
                        setExtraSliderCentsByAccount((prev) => ({
                          ...prev,
                          [acc.id]: Number(e.target.value),
                        }))
                      }
                      className="mt-2 w-full accent-emerald-600"
                    />
                    <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                      Slider up to {formatCurrencyFromCents(EXTRA_SLIDER_MAX_CENTS)} in {formatCurrencyFromCents(EXTRA_SLIDER_STEP_CENTS)} steps.
                    </p>
                  </div>

                  <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900/60">
                    <p>
                      <span className="text-zinc-600 dark:text-zinc-400">Modeled monthly payment:</span>{' '}
                      <span className="font-semibold">{formatCurrencyFromCents(totalPay)}</span>
                      <span className="text-zinc-500"> (= max(min, planned, recent avg) + extra)</span>
                    </p>
                    {sim.neverReason ? (
                      <p className="mt-2 text-amber-800 dark:text-amber-200">{sim.neverReason}</p>
                    ) : sim.months === 0 ? (
                      <p className="mt-2 font-medium text-emerald-800 dark:text-emerald-200">No balance to pay off.</p>
                    ) : (
                      <>
                        <p className="mt-2">
                          <span className="text-zinc-600 dark:text-zinc-400">Estimated payoff:</span>{' '}
                          <span className="font-semibold">
                            {payoffDate ? format(payoffDate, 'MMMM yyyy') : '—'} ({sim.months} mo from today)
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                          Total interest until zero (approx.): {formatCurrencyFromCents(sim.totalInterestCents)}. Uses
                          monthly compounding on statement balance; not your bank’s exact daily-interest rules.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Record a payment" storageKey="debt-payment">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Same flow as Accounts: cash leaves your bank account, the envelope you pick loses that assignment, and the
          card or loan balance improves.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Date</span>
            <input
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Pay from account</span>
            <select
              value={payFromAccountId}
              onChange={(e) => setPayFromAccountId(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatAccountDropdownLabel(a.name, a.balance_cents)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Pay toward</span>
            <select
              value={payToLiabilityId}
              onChange={(e) => setPayToLiabilityId(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {liabilities.length === 0 ? (
                <option value="">No liability accounts</option>
              ) : (
                liabilities.map((a) => (
                  <option key={a.id} value={a.id}>
                    {formatAccountDropdownLabel(a.name, a.balance_cents)}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="text-sm sm:col-span-2 xl:col-span-3">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">From envelope</span>
            <select
              value={payFromEnvelopeId}
              onChange={(e) => setPayFromEnvelopeId(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {groupedEnvelopeOptions.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.envelopes.map((env) => (
                    <option key={env.id} value={env.id}>
                      {formatEnvelopeDropdownLabel(env.name, env.balance_cents)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Amount ($)</span>
            <input
              type="text"
              inputMode="decimal"
              value={payAmountDollars}
              onChange={(e) => setPayAmountDollars(e.target.value)}
              onBlur={(e) => setPayAmountDollars(normalizeDollarsInput(e.target.value))}
              placeholder="0.00"
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="text-sm sm:col-span-2 xl:col-span-3">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Note (optional)</span>
            <input
              type="text"
              value={payNote}
              onChange={(e) => setPayNote(e.target.value)}
              placeholder="e.g. Statement payment"
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => void submitPayment()}
          disabled={saving || liabilities.length === 0 || cashAccounts.length === 0}
          className="mt-3 min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Save payment
        </button>
      </CollapsibleCard>

      <CollapsibleCard title="Recent activity on liability accounts" storageKey="debt-activity">
        {loading ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : recentTx.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            No register lines on card or loan accounts yet. Card purchases and payments appear here once posted to the
            account.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {recentTx.map((tx) => {
              const accName = liabilities.find((a) => a.id === tx.account_id)?.name ?? 'Account'
              return (
                <div
                  key={tx.id}
                  className="flex flex-col gap-1 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 dark:text-zinc-50">{tx.payee}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {format(new Date(tx.date), 'MMM d, yyyy')} · {accName} · {txKindLabel(tx.transaction_kind)}
                    </p>
                  </div>
                  <p className="shrink-0 font-semibold tabular-nums">{formatCurrencyFromCents(tx.amount_cents)}</p>
                </div>
              )
            })}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Future refinements" storageKey="debt-roadmap" defaultCollapsed>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
          <li>Statement closing / due dates and true minimum rules from the issuer.</li>
          <li>Daily-average balance interest and one-click “post interest”.</li>
          <li>One combined “snowball” slider across all debts.</li>
        </ul>
      </CollapsibleCard>
    </div>
  )
}
