import { useCallback, useEffect, useMemo, useState } from 'react'
import { format, startOfMonth, subDays } from 'date-fns'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import {
  dollarsStringToCents,
  formatAccountDropdownLabel,
  formatCurrencyFromCents,
  formatEnvelopeDropdownLabel,
} from '../lib/currency'
import { renameDebtEnvelopeIfPresent, syncDebtEnvelopeMonthlyGoalFromMinimum } from '../lib/debtEnvelopeSync'
import { getSupabase } from '../lib/supabase'

type AccountType = 'checking' | 'savings' | 'credit_card' | 'debt' | 'cash' | 'other'

type EnvelopeOption = {
  id: string
  name: string
  balance_cents: number
}

type FinancialAccount = {
  id: string
  name: string
  account_type: AccountType
  balance_cents: number
  apr_bps: number | null
  archived: boolean
  minimum_payment_cents: number | null
  planned_monthly_payment_cents: number | null
}

type AccountTransaction = {
  id: string
  date: string
  payee: string
  amount_cents: number
  cleared: boolean
  note: string | null
  account_id: string | null
  /** Present when loaded from API; used for register ordering. */
  created_at?: string
}

type PaycheckDeposit = {
  id: string
  date: string
  source: string
  net_amount_cents: number
  notes: string | null
  deposit_account_id: string
  created_at?: string
}

type RegisterBuildRow = {
  id: string
  date: string
  posted_at: string
  payee: string
  amount_cents: number
  cleared: boolean
  note: string | null
  account_id: string | null
  entry_kind: 'transaction' | 'paycheck'
}

type RegisterRow = AccountTransaction & {
  running_balance_cents: number
  entry_kind?: 'transaction' | 'paycheck'
}

type DatePreset = 'all_time' | 'this_month' | 'last_30' | 'last_90' | 'custom'

function aprPercentStringToBps(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const cents = dollarsStringToCents(trimmed)
  if (cents == null || cents < 0) return null
  return Math.round((cents / 100) * 10000)
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [envelopes, setEnvelopes] = useState<EnvelopeOption[]>([])
  const [transactions, setTransactions] = useState<AccountTransaction[]>([])
  const [paycheckDeposits, setPaycheckDeposits] = useState<PaycheckDeposit[]>([])
  const [activeAccountId, setActiveAccountId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  const [newAccountType, setNewAccountType] = useState<AccountType>('checking')
  const [newAccountStartingBalance, setNewAccountStartingBalance] = useState('')
  const [newAccountAprPercent, setNewAccountAprPercent] = useState('')
  const [newAccountMinimumPayment, setNewAccountMinimumPayment] = useState('')
  const [aprDrafts, setAprDrafts] = useState<Record<string, string>>({})
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({})
  const [minimumDrafts, setMinimumDrafts] = useState<Record<string, string>>({})
  const [plannedDrafts, setPlannedDrafts] = useState<Record<string, string>>({})
  const [registerSearch, setRegisterSearch] = useState('')
  const [registerFromDate, setRegisterFromDate] = useState('')
  const [registerToDate, setRegisterToDate] = useState('')
  const [registerDatePreset, setRegisterDatePreset] = useState<DatePreset>('all_time')
  const [transferDate, setTransferDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [transferFromAccountId, setTransferFromAccountId] = useState('')
  const [transferToAccountId, setTransferToAccountId] = useState('')
  const [transferFromEnvelopeId, setTransferFromEnvelopeId] = useState('')
  const [transferAmountDollars, setTransferAmountDollars] = useState('')
  const [transferNote, setTransferNote] = useState('')
  const [internalXferFromId, setInternalXferFromId] = useState('')
  const [internalXferToId, setInternalXferToId] = useState('')
  const [internalXferAmountDollars, setInternalXferAmountDollars] = useState('')
  const [internalXferNote, setInternalXferNote] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const [accountsResp, envelopesResp, txResp, paycheckResp] = await Promise.all([
        supabase
          .from('financial_accounts')
          .select(
            'id,name,account_type,balance_cents,apr_bps,archived,minimum_payment_cents,planned_monthly_payment_cents',
          )
          .eq('archived', false)
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
        supabase.from('envelopes').select('id,name,balance_cents').eq('archived', false).order('name', { ascending: true }),
        supabase
          .from('transactions')
          .select('id,date,payee,amount_cents,cleared,note,account_id,created_at')
          .eq('archived', false)
          .not('account_id', 'is', null)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase
          .from('paychecks')
          .select('id,date,source,net_amount_cents,notes,deposit_account_id,created_at')
          .not('deposit_account_id', 'is', null)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
      ])
      if (accountsResp.error) throw accountsResp.error
      if (envelopesResp.error) throw envelopesResp.error
      if (txResp.error) throw txResp.error
      if (paycheckResp.error) throw paycheckResp.error
      const loadedAccounts = (accountsResp.data ?? []) as FinancialAccount[]
      setAccounts(loadedAccounts)
      setNameDrafts(Object.fromEntries(loadedAccounts.map((a) => [a.id, a.name])))
      setAprDrafts(
        Object.fromEntries(
          loadedAccounts.map((account) => [
            account.id,
            account.apr_bps == null ? '' : (account.apr_bps / 10000).toFixed(2),
          ]),
        ),
      )
      setMinimumDrafts(
        Object.fromEntries(
          loadedAccounts.map((a) => [
            a.id,
            a.minimum_payment_cents != null ? (a.minimum_payment_cents / 100).toFixed(2) : '',
          ]),
        ),
      )
      setPlannedDrafts(
        Object.fromEntries(
          loadedAccounts.map((a) => [
            a.id,
            a.planned_monthly_payment_cents != null ? (a.planned_monthly_payment_cents / 100).toFixed(2) : '',
          ]),
        ),
      )
      setEnvelopes((envelopesResp.data ?? []) as EnvelopeOption[])
      setTransactions((txResp.data ?? []) as AccountTransaction[])
      setPaycheckDeposits((paycheckResp.data ?? []) as PaycheckDeposit[])
      const firstCash = loadedAccounts.find(
        (a) => a.account_type !== 'credit_card' && a.account_type !== 'debt',
      )
      const firstLiability = loadedAccounts.find(
        (a) => a.account_type === 'credit_card' || a.account_type === 'debt',
      )
      setActiveAccountId((prev) => prev || loadedAccounts[0]?.id || '')
      setTransferFromAccountId((prev) =>
        prev && loadedAccounts.some((a) => a.id === prev) ? prev : firstCash?.id || loadedAccounts[0]?.id || '',
      )
      setTransferToAccountId((prev) =>
        prev && loadedAccounts.some((a) => a.id === prev)
          ? prev
          : firstLiability?.id || '',
      )
      setTransferFromEnvelopeId((prev) => prev || envelopesResp.data?.[0]?.id || '')
      const bankLike = loadedAccounts.filter(
        (a) => a.account_type !== 'credit_card' && a.account_type !== 'debt',
      )
      setInternalXferFromId((fromPrev) => {
        const nextFrom =
          fromPrev && bankLike.some((a) => a.id === fromPrev) ? fromPrev : (bankLike[0]?.id ?? '')
        setInternalXferToId((toPrev) => {
          if (toPrev && bankLike.some((a) => a.id === toPrev) && toPrev !== nextFrom) return toPrev
          return bankLike.find((a) => a.id !== nextFrom)?.id ?? bankLike[0]?.id ?? ''
        })
        return nextFrom
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId) ?? null,
    [accounts, activeAccountId],
  )

  const registerRows = useMemo(() => {
    if (!activeAccountId || !activeAccount) return []

    const txRows: RegisterBuildRow[] = transactions
      .filter((tx) => tx.account_id === activeAccountId)
      .map((row) => ({
        id: row.id,
        date: row.date,
        posted_at: row.created_at ?? `${row.date}T23:59:59.999Z`,
        payee: row.payee,
        amount_cents: row.amount_cents,
        cleared: row.cleared,
        note: row.note,
        account_id: row.account_id,
        entry_kind: 'transaction' as const,
      }))

    const paycheckRows: RegisterBuildRow[] = paycheckDeposits
      .filter((pc) => pc.deposit_account_id === activeAccountId)
      .map((pc) => ({
        id: `paycheck-${pc.id}`,
        date: pc.date,
        posted_at: pc.created_at ?? `${pc.date}T23:59:59.999Z`,
        payee: `Paycheck: ${pc.source}`,
        amount_cents: -pc.net_amount_cents,
        cleared: true,
        note: pc.notes,
        account_id: pc.deposit_account_id,
        entry_kind: 'paycheck' as const,
      }))

    const merged = [...txRows, ...paycheckRows]
    const asc = [...merged].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date)
      if (a.posted_at !== b.posted_at) return a.posted_at.localeCompare(b.posted_at)
      return a.id.localeCompare(b.id)
    })

    const searchNeedle = registerSearch.trim().toLowerCase()
    const passesFilters = (row: RegisterBuildRow) => {
      if (registerFromDate && row.date < registerFromDate) return false
      if (registerToDate && row.date > registerToDate) return false
      if (searchNeedle) {
        const target = `${row.payee} ${row.note ?? ''}`.toLowerCase()
        if (!target.includes(searchNeedle)) return false
      }
      return true
    }

    // Walk newest → oldest on the full ledger so running balances stay tied to the account total,
    // then only surface rows that match the register filters.
    let running = activeAccount.balance_cents
    const out: RegisterRow[] = []
    for (let i = asc.length - 1; i >= 0; i -= 1) {
      const row = asc[i]!
      const running_balance_cents = running
      running += row.amount_cents
      if (passesFilters(row)) {
        out.push({
          id: row.id,
          date: row.date,
          payee: row.payee,
          amount_cents: row.amount_cents,
          cleared: row.cleared,
          note: row.note,
          account_id: row.account_id,
          entry_kind: row.entry_kind,
          running_balance_cents,
        })
      }
    }
    return out
  }, [
    transactions,
    paycheckDeposits,
    activeAccountId,
    activeAccount,
    registerFromDate,
    registerToDate,
    registerSearch,
  ])

  async function createAccount() {
    const name = newAccountName.trim()
    if (!name) {
      setError('Account name is required.')
      return
    }
    const startingBalanceCents = dollarsStringToCents(newAccountStartingBalance)
    if (startingBalanceCents == null) {
      setError('Starting balance must be a valid amount.')
      return
    }
    const aprBps =
      newAccountType === 'credit_card' || newAccountType === 'debt'
        ? aprPercentStringToBps(newAccountAprPercent)
        : null
    if (
      (newAccountType === 'credit_card' || newAccountType === 'debt') &&
      newAccountAprPercent.trim() &&
      aprBps == null
    ) {
      setError('APR must be a valid percentage (e.g. 24.99).')
      return
    }
    let minimumPaymentCents: number | null = null
    if (newAccountType === 'credit_card' || newAccountType === 'debt') {
      if (newAccountMinimumPayment.trim()) {
        const parsedMin = dollarsStringToCents(newAccountMinimumPayment.trim())
        if (parsedMin == null) {
          setError('Minimum payment must be a valid amount.')
          return
        }
        minimumPaymentCents = parsedMin
      }
    }
    setSaving(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const nextSort = accounts.length
      const isBankCash = newAccountType === 'checking' || newAccountType === 'savings'
      const isLiability = newAccountType === 'credit_card' || newAccountType === 'debt'
      const initialAccountBalance =
        isLiability
          ? startingBalanceCents
          : isBankCash && startingBalanceCents !== 0
            ? 0
            : startingBalanceCents

      const { data: createdAccount, error: insertError } = await supabase
        .from('financial_accounts')
        .insert({
          name,
          account_type: newAccountType,
          sort_order: nextSort,
          balance_cents: initialAccountBalance,
          apr_bps: aprBps,
          ...(isLiability ? { minimum_payment_cents: minimumPaymentCents } : {}),
        })
        .select('id')
        .single()
      if (insertError) throw insertError
      if (!createdAccount?.id) throw new Error('Account was created but no id was returned.')

      if (isLiability) {
        const { data: sortRows, error: sortError } = await supabase
          .from('envelopes')
          .select('sort_order')
          .order('sort_order', { ascending: false })
          .limit(1)
        if (sortError) throw sortError
        const nextEnvelopeSort = (sortRows?.[0]?.sort_order ?? -1) + 1
        const envelopeMinCents = minimumPaymentCents ?? 0
        const { error: envelopeError } = await supabase.from('envelopes').insert({
          name,
          type: 'debt',
          goal_type: 'assign_monthly',
          goal_target_cents: null,
          budget_target_cents: envelopeMinCents,
          balance_cents: 0,
          color: '#10b981',
          sort_order: nextEnvelopeSort,
        })
        if (envelopeError) {
          await supabase.from('financial_accounts').delete().eq('id', createdAccount.id)
          throw envelopeError
        }
      } else if (isBankCash && startingBalanceCents !== 0) {
        const { error: sbError } = await supabase.rpc('save_starting_balance_deposit', {
          p_date: format(new Date(), 'yyyy-MM-dd'),
          p_net_amount_cents: startingBalanceCents,
          p_notes: `Initial funding: ${name}`,
          p_deposit_account_id: createdAccount.id,
        })
        if (sbError) {
          await supabase.from('financial_accounts').delete().eq('id', createdAccount.id)
          throw sbError
        }
      }

      setNewAccountName('')
      setNewAccountStartingBalance('')
      setNewAccountAprPercent('')
      setNewAccountMinimumPayment('')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create account.')
    } finally {
      setSaving(false)
    }
  }

  async function saveAccountDetails(accountId: string) {
    const account = accounts.find((item) => item.id === accountId)
    if (!account) return

    const name = (nameDrafts[accountId] ?? account.name).trim()
    if (!name) {
      setError('Account name is required.')
      return
    }

    const isLiability = account.account_type === 'credit_card' || account.account_type === 'debt'

    let aprBps: number | null = null
    let minimumPaymentCents: number | null = null
    let plannedMonthlyCents: number | null = null

    if (isLiability) {
      const aprDraft = aprDrafts[accountId] ?? ''
      aprBps = aprDraft.trim() ? aprPercentStringToBps(aprDraft) : null
      if (aprDraft.trim() && aprBps == null) {
        setError('APR must be a valid percentage (e.g. 24.99).')
        return
      }

      const minStr = minimumDrafts[accountId] ?? ''
      const planStr = plannedDrafts[accountId] ?? ''
      const minParsed = dollarsStringToCents(minStr.trim())
      const planParsed = dollarsStringToCents(planStr.trim())
      if (minStr.trim() && minParsed == null) {
        setError('Minimum payment must be a valid amount or empty.')
        return
      }
      if (planStr.trim() && planParsed == null) {
        setError('Planned monthly payment must be a valid amount or empty.')
        return
      }
      if (minParsed != null && planParsed != null && planParsed < minParsed) {
        setError('Planned monthly payment cannot be less than the minimum.')
        return
      }
      minimumPaymentCents = minStr.trim() ? minParsed : null
      plannedMonthlyCents = planStr.trim() ? planParsed : null
    }

    setSaving(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const oldName = account.name

      if (isLiability && oldName !== name) {
        const { error: renErr } = await renameDebtEnvelopeIfPresent(supabase, { fromName: oldName, toName: name })
        if (renErr) throw renErr
      }

      if (isLiability) {
        const aprDraft = aprDrafts[accountId] ?? ''
        const { error: updateError } = await supabase
          .from('financial_accounts')
          .update({
            name,
            apr_bps: aprDraft.trim() ? aprBps : null,
            minimum_payment_cents: minimumPaymentCents,
            planned_monthly_payment_cents: plannedMonthlyCents,
          })
          .eq('id', accountId)
        if (updateError) throw updateError

        const { error: syncErr } = await syncDebtEnvelopeMonthlyGoalFromMinimum(supabase, {
          liabilityAccountName: name,
          minimumPaymentCents,
        })
        if (syncErr) throw syncErr
      } else {
        const { error: updateError } = await supabase.from('financial_accounts').update({ name }).eq('id', accountId)
        if (updateError) throw updateError
      }

      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save account.')
    } finally {
      setSaving(false)
    }
  }

  async function submitDebtPayment() {
    const amountCents = dollarsStringToCents(transferAmountDollars)
    if (!transferFromAccountId || !transferToAccountId) {
      setError('Select the account you pay from and the card or debt account.')
      return
    }
    if (!transferFromEnvelopeId) {
      setError('Select the envelope this payment comes from (e.g. your card payment category).')
      return
    }
    if (transferFromAccountId === transferToAccountId) {
      setError('From and to accounts must be different.')
      return
    }
    const toAccount = accounts.find((a) => a.id === transferToAccountId)
    if (!toAccount || (toAccount.account_type !== 'credit_card' && toAccount.account_type !== 'debt')) {
      setError('The destination must be a credit card or debt account.')
      return
    }
    const fromAccount = accounts.find((a) => a.id === transferFromAccountId)
    if (fromAccount && (fromAccount.account_type === 'credit_card' || fromAccount.account_type === 'debt')) {
      setError('Pay from a checking, savings, cash, or other account—not from a liability account.')
      return
    }
    if (amountCents == null || amountCents <= 0) {
      setError('Payment amount must be greater than 0.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const { error: paymentError } = await getSupabase().rpc('create_debt_payment', {
        p_date: transferDate,
        p_amount_cents: amountCents,
        p_from_account_id: transferFromAccountId,
        p_to_account_id: transferToAccountId,
        p_from_envelope_id: transferFromEnvelopeId,
        p_note: transferNote.trim() || null,
        p_cleared: true,
      })
      if (paymentError) throw paymentError

      setTransferAmountDollars('')
      setTransferNote('')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record payment.')
    } finally {
      setSaving(false)
    }
  }

  async function submitInternalTransfer() {
    const cents = dollarsStringToCents(internalXferAmountDollars)
    if (!internalXferFromId || !internalXferToId) {
      setError('Select both accounts for the transfer.')
      return
    }
    if (internalXferFromId === internalXferToId) {
      setError('From and to accounts must be different.')
      return
    }
    if (cents == null || cents <= 0) {
      setError('Transfer amount must be greater than 0.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const { error: xferError } = await getSupabase().rpc('create_account_transfer', {
        p_date: transferDate,
        p_amount_cents: cents,
        p_from_account_id: internalXferFromId,
        p_to_account_id: internalXferToId,
        p_note: internalXferNote.trim() || null,
        p_cleared: true,
      })
      if (xferError) throw xferError
      setInternalXferAmountDollars('')
      setInternalXferNote('')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not transfer between accounts.')
    } finally {
      setSaving(false)
    }
  }

  async function deleteAccount(accountId: string, accountName: string) {
    if (
      !window.confirm(
        `Permanently delete "${accountName}"? The balance must be exactly $0.00, with no transactions and no paycheck deposits to this account.`,
      )
    ) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { error: delError } = await getSupabase().rpc('delete_financial_account', {
        p_account_id: accountId,
      })
      if (delError) throw delError
      if (activeAccountId === accountId) {
        const remaining = accounts.filter((a) => a.id !== accountId)
        setActiveAccountId(remaining[0]?.id ?? '')
      }
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete account.')
    } finally {
      setSaving(false)
    }
  }

  function applyRegisterDatePreset(preset: DatePreset) {
    const today = new Date()
    setRegisterDatePreset(preset)
    if (preset === 'all_time') {
      setRegisterFromDate('')
      setRegisterToDate('')
      return
    }
    if (preset === 'this_month') {
      setRegisterFromDate(format(startOfMonth(today), 'yyyy-MM-dd'))
      setRegisterToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'last_30') {
      setRegisterFromDate(format(subDays(today, 29), 'yyyy-MM-dd'))
      setRegisterToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'last_90') {
      setRegisterFromDate(format(subDays(today, 89), 'yyyy-MM-dd'))
      setRegisterToDate(format(today, 'yyyy-MM-dd'))
      return
    }
  }

  return (
    <div className="space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface p-4 sm:p-6">
        <h1 className="section-title">Accounts</h1>
        <p className="section-subtitle">
          See account totals, edit account details (name, APR, and for cards or loans minimum and planned payments), and
          open an account register. Minimum payment on a card or loan is stored on the account and kept in sync with the
          matching debt envelope’s monthly assignment target.
        </p>
        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">{error}</p>}
      </section>

      <CollapsibleCard title="Account Totals" storageKey="accounts-totals">
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <input
            type="text"
            value={newAccountName}
            onChange={(event) => setNewAccountName(event.target.value)}
            placeholder="Account name (e.g. Chase Checking)"
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950 sm:col-span-2 xl:col-span-2"
          />
          <select
            value={newAccountType}
            onChange={(event) => setNewAccountType(event.target.value as AccountType)}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
            <option value="credit_card">Credit Card</option>
            <option value="debt">Debt</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={newAccountStartingBalance}
            onChange={(event) => setNewAccountStartingBalance(event.target.value)}
            placeholder="Starting balance (e.g. 2500.00)"
            className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950 sm:w-72"
          />
          <button
            type="button"
            onClick={() => void createAccount()}
            disabled={saving}
            className="btn-secondary px-4 text-sm"
          >
            Add Account
          </button>
        </div>
        {(newAccountType === 'credit_card' || newAccountType === 'debt') && (
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs text-zinc-600 dark:text-zinc-400">APR (%)</label>
              <input
                type="text"
                inputMode="decimal"
                value={newAccountAprPercent}
                onChange={(event) => setNewAccountAprPercent(event.target.value)}
                placeholder="e.g. 24.99"
                className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950 sm:max-w-xs"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-600 dark:text-zinc-400">Minimum payment ($/mo)</label>
              <input
                type="text"
                inputMode="decimal"
                value={newAccountMinimumPayment}
                onChange={(event) => setNewAccountMinimumPayment(event.target.value)}
                placeholder="Optional — also sets debt envelope goal"
                className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950 sm:max-w-xs"
              />
            </div>
          </div>
        )}
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading accounts...</p>
        ) : accounts.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No accounts yet. Add one from Transactions.</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((account) => (
              <div
                key={account.id}
                className={[
                  'rounded-xl border p-3.5 text-left transition',
                  activeAccountId === account.id
                    ? 'border-emerald-400 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-950/40'
                    : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      {account.account_type.replace('_', ' ')}
                    </p>
                    <p className="truncate text-sm font-semibold">{account.name}</p>
                    <p className="mt-1 text-sm">{formatCurrencyFromCents(account.balance_cents)}</p>
                    {account.apr_bps != null && (
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        APR {(account.apr_bps / 10000).toFixed(2)}%
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => setActiveAccountId(account.id)}
                      className="btn-secondary min-h-9 px-3 text-xs"
                    >
                      Register
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteAccount(account.id, account.name)}
                      disabled={saving}
                      className="btn-danger min-h-9 px-3 text-xs"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="mt-3 space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  <label className="text-[11px] text-zinc-500 dark:text-zinc-400">Account name</label>
                  <input
                    type="text"
                    value={nameDrafts[account.id] ?? account.name}
                    onChange={(event) =>
                      setNameDrafts((prev) => ({
                        ...prev,
                        [account.id]: event.target.value,
                      }))
                    }
                    className="min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                  />
                  {(account.account_type === 'credit_card' || account.account_type === 'debt') && (
                    <div className="space-y-2">
                      <div>
                        <label className="text-[11px] text-zinc-500 dark:text-zinc-400">APR (%)</label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={aprDrafts[account.id] ?? ''}
                          onChange={(event) =>
                            setAprDrafts((prev) => ({
                              ...prev,
                              [account.id]: event.target.value,
                            }))
                          }
                          placeholder="e.g. 24.99"
                          className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          Minimum payment ($/mo) — stored on account; syncs debt envelope monthly goal
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={minimumDrafts[account.id] ?? ''}
                          onChange={(event) =>
                            setMinimumDrafts((prev) => ({
                              ...prev,
                              [account.id]: event.target.value,
                            }))
                          }
                          placeholder="0.00"
                          className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-500 dark:text-zinc-400">Planned paydown ($/mo)</label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={plannedDrafts[account.id] ?? ''}
                          onChange={(event) =>
                            setPlannedDrafts((prev) => ({
                              ...prev,
                              [account.id]: event.target.value,
                            }))
                          }
                          placeholder="Optional"
                          className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                        />
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => void saveAccountDetails(account.id)}
                    disabled={saving}
                    className="btn-secondary min-h-10 w-full px-3 text-xs sm:w-auto"
                  >
                    Save account details
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Pay credit card or debt" storageKey="accounts-debt-payment">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Record a payment in one step: cash leaves the account you choose, the envelope you choose loses that assigned
          amount, and the card or loan balance improves. Two ledger lines are created (bank outflow + card inflow); the
          card line does not touch envelopes—use <strong>Envelopes</strong> if you need to move money between
          categories.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Date</span>
            <input
              type="date"
              value={transferDate}
              onChange={(event) => setTransferDate(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Pay from account</span>
            <select
              value={transferFromAccountId}
              onChange={(event) => setTransferFromAccountId(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Select account</option>
              {accounts
                .filter((a) => a.account_type !== 'credit_card' && a.account_type !== 'debt')
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {formatAccountDropdownLabel(account.name, account.balance_cents)}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Pay toward (card or debt)</span>
            <select
              value={transferToAccountId}
              onChange={(event) => setTransferToAccountId(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Select card or debt account</option>
              {accounts
                .filter((a) => a.account_type === 'credit_card' || a.account_type === 'debt')
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {formatAccountDropdownLabel(account.name, account.balance_cents)}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm sm:col-span-2 xl:col-span-3">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">From envelope</span>
            <select
              value={transferFromEnvelopeId}
              onChange={(event) => setTransferFromEnvelopeId(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Select envelope</option>
              {envelopes.map((envelope) => (
                <option key={envelope.id} value={envelope.id}>
                  {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              Only this envelope's balance changes (the cash you had assigned for this payment).
            </p>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Amount ($)</span>
            <input
              type="text"
              inputMode="decimal"
              value={transferAmountDollars}
              onChange={(event) => setTransferAmountDollars(event.target.value)}
              placeholder="0.00"
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="text-sm sm:col-span-2 xl:col-span-3">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Note (optional)</span>
            <input
              type="text"
              value={transferNote}
              onChange={(event) => setTransferNote(event.target.value)}
              placeholder="e.g. Statement payment"
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => void submitDebtPayment()}
          disabled={saving}
          className="btn-primary mt-3 min-h-11 px-4 text-sm"
        >
          Save payment
        </button>
      </CollapsibleCard>

      <CollapsibleCard title="Transfer between accounts" storageKey="accounts-internal-transfer">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Move cash between checking, savings, cash, or other asset accounts. Creates two linked register lines (out
          from one account, in to the other). Envelope balances are unchanged—only account balances move.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Date</span>
            <input
              type="date"
              value={transferDate}
              onChange={(event) => setTransferDate(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">From account</span>
            <select
              value={internalXferFromId}
              onChange={(event) => {
                const next = event.target.value
                setInternalXferFromId(next)
                setInternalXferToId((prev) => {
                  if (prev !== next) return prev
                  const other = accounts.find(
                    (a) =>
                      a.id !== next && a.account_type !== 'credit_card' && a.account_type !== 'debt',
                  )
                  return other?.id ?? ''
                })
              }}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {accounts.filter((a) => a.account_type !== 'credit_card' && a.account_type !== 'debt').length === 0 ? (
                <option value="">Add a checking or savings account first</option>
              ) : (
                accounts
                  .filter((a) => a.account_type !== 'credit_card' && a.account_type !== 'debt')
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {formatAccountDropdownLabel(account.name, account.balance_cents)}
                    </option>
                  ))
              )}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">To account</span>
            <select
              value={internalXferToId}
              onChange={(event) => setInternalXferToId(event.target.value)}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {accounts
                .filter((a) => a.account_type !== 'credit_card' && a.account_type !== 'debt')
                .map((account) => (
                  <option key={account.id} value={account.id} disabled={account.id === internalXferFromId}>
                    {formatAccountDropdownLabel(account.name, account.balance_cents)}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Amount ($)</span>
            <input
              type="text"
              inputMode="decimal"
              value={internalXferAmountDollars}
              onChange={(event) => setInternalXferAmountDollars(event.target.value)}
              placeholder="0.00"
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="text-sm sm:col-span-2 xl:col-span-3">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Note (optional)</span>
            <input
              type="text"
              value={internalXferNote}
              onChange={(event) => setInternalXferNote(event.target.value)}
              placeholder="e.g. Move to high-yield savings"
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => void submitInternalTransfer()}
          disabled={saving}
          className="btn-primary mt-3 min-h-11 px-4 text-sm"
        >
          Transfer
        </button>
      </CollapsibleCard>

      <CollapsibleCard title="Account Register" storageKey="accounts-register">
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {activeAccount ? `Showing ${activeAccount.name}` : 'Choose an account above'}
        </p>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {(
            [
              ['all_time', 'All time'],
              ['this_month', 'This month'],
              ['last_30', 'Last 30'],
              ['last_90', 'Last 90'],
              ['custom', 'Custom'],
            ] as Array<[DatePreset, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => applyRegisterDatePreset(value)}
              className={[
                'min-h-10 rounded-lg border px-3 text-xs font-medium',
                registerDatePreset === value
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <input
            type="text"
            value={registerSearch}
            onChange={(event) => setRegisterSearch(event.target.value)}
            placeholder="Search payee or note"
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950 lg:col-span-2 xl:col-span-4"
          />
          <input
            type="date"
            value={registerFromDate}
            onChange={(event) => {
              setRegisterDatePreset('custom')
              setRegisterFromDate(event.target.value)
            }}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            type="date"
            value={registerToDate}
            onChange={(event) => {
              setRegisterDatePreset('custom')
              setRegisterToDate(event.target.value)
            }}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading register...</p>
        ) : !activeAccount ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Select an account to view transactions.</p>
        ) : registerRows.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No register activity for this account yet (transactions and paycheck deposits appear here).
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {registerRows.map((row) => (
              <div
                key={row.id}
                className="flex flex-col gap-1 rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.payee}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {format(new Date(row.date), 'MMM d, yyyy')} •{' '}
                    {row.entry_kind === 'paycheck'
                      ? 'Journal paycheck'
                      : row.cleared
                        ? 'Cleared'
                        : 'Pending'}
                  </p>
                  {row.note && <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{row.note}</p>}
                </div>
                <div className="text-right">
                  <p
                    className={[
                      'text-sm font-semibold',
                      row.amount_cents < 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300',
                    ].join(' ')}
                  >
                    {row.amount_cents < 0
                      ? `+${formatCurrencyFromCents(Math.abs(row.amount_cents))}`
                      : `-${formatCurrencyFromCents(row.amount_cents)}`}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Balance: {formatCurrencyFromCents(row.running_balance_cents)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>
    </div>
  )
}
