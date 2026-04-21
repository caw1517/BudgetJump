import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { format } from 'date-fns'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import {
  dollarsStringToCents,
  formatAccountDropdownLabel,
  formatCurrencyFromCents,
  formatEnvelopeDropdownLabel,
} from '../lib/currency'
import { getSupabase } from '../lib/supabase'

function envelopeMovesCreatedAtFilter(fromDate: string, toDate: string): { gte: string; lt: string } {
  const start = new Date(`${fromDate}T00:00:00`)
  const endExclusive = new Date(`${toDate}T00:00:00`)
  endExclusive.setDate(endExclusive.getDate() + 1)
  return {
    gte: start.toISOString(),
    lt: endExclusive.toISOString(),
  }
}

type Envelope = {
  id: string
  name: string
  balance_cents: number
  budget_target_cents: number
  goal_type: 'assign_monthly' | 'refill_up_to' | null
  goal_target_cents: number | null
}

type PaycheckSummary = {
  id: string
  date: string
  source: string
  net_amount_cents: number
  deposit_account_id: string | null
  source_id: string | null
}

type PaycheckDetail = {
  id: string
  date: string
  source: string
  net_amount_cents: number
  notes: string | null
  deposit_account_id: string | null
  source_id: string | null
  paycheck_sources?: { name: string; expected_amount_cents: number } | { name: string; expected_amount_cents: number }[] | null
}

type DepositAccount = {
  id: string
  name: string
  balance_cents: number
  account_type: string
}

type PaycheckSource = {
  id: string
  name: string
  expected_amount_cents: number
  sort_order: number
  archived: boolean
}

type AllocationLine = {
  /** Stable React key; multiple lines may share the same envelope (e.g. April + May). */
  lineId: string
  envelopeId: string
  amountDollars: string
  allocationMonth: string
}

function newAllocationLineId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function unwrapPaycheckSourceRelation(
  rel: PaycheckDetail['paycheck_sources'],
): { name: string; expected_amount_cents: number } | null {
  if (!rel) return null
  return Array.isArray(rel) ? (rel[0] ?? null) : rel
}

type DatePreset = 'this_month' | 'last_30' | 'last_90' | 'all_time' | 'custom'

const PaycheckSourceRowEditor = memo(function PaycheckSourceRowEditor(props: {
  row: PaycheckSource
  busy: boolean
  onUpdate: (row: PaycheckSource, name: string, expectedDollars: string) => void | Promise<void>
  onArchive: (id: string) => void | Promise<void>
}) {
  const [name, setName] = useState(props.row.name)
  const [expectedDollars, setExpectedDollars] = useState((props.row.expected_amount_cents / 100).toFixed(2))
  useEffect(() => {
    setName(props.row.name)
    setExpectedDollars((props.row.expected_amount_cents / 100).toFixed(2))
  }, [props.row.id, props.row.name, props.row.expected_amount_cents])
  return (
    <div
      className={[
        'flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:flex-wrap sm:items-end',
        props.row.archived ? 'border-zinc-300 opacity-60 dark:border-zinc-700' : 'border-zinc-200 dark:border-zinc-800',
      ].join(' ')}
    >
      <label className="min-w-0 flex-1 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="mb-1 block text-zinc-600 dark:text-zinc-300">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={props.row.archived || props.busy}
          className="min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>
      <label className="w-full text-xs text-zinc-500 dark:text-zinc-400 sm:w-36">
        <span className="mb-1 block text-zinc-600 dark:text-zinc-300">Expected / check ($)</span>
        <input
          type="text"
          inputMode="decimal"
          value={expectedDollars}
          onChange={(e) => setExpectedDollars(e.target.value)}
          disabled={props.row.archived || props.busy}
          className="min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={props.row.archived || props.busy}
          onClick={() => void props.onUpdate(props.row, name, expectedDollars)}
          className="min-h-10 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={props.row.archived || props.busy}
          onClick={() => void props.onArchive(props.row.id)}
          className="btn-danger min-h-10 px-3 text-xs disabled:opacity-40"
        >
          Archive
        </button>
      </div>
      {props.row.archived && (
        <p className="w-full text-[11px] text-zinc-500 dark:text-zinc-400">Archived — hidden from new paychecks.</p>
      )}
    </div>
  )
})

export function JournalPage() {
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [history, setHistory] = useState<PaycheckSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [source, setSource] = useState('')
  const [netDollars, setNetDollars] = useState('')
  const [notes, setNotes] = useState('')
  const [allocations, setAllocations] = useState<AllocationLine[]>([])
  const [depositAccounts, setDepositAccounts] = useState<DepositAccount[]>([])
  const [depositAccountId, setDepositAccountId] = useState('')
  const [paycheckSources, setPaycheckSources] = useState<PaycheckSource[]>([])
  const [sourceMode, setSourceMode] = useState<'saved' | 'other'>('other')
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [newSourceName, setNewSourceName] = useState('')
  const [newSourceExpectedDollars, setNewSourceExpectedDollars] = useState('')
  const [sourceMutationBusy, setSourceMutationBusy] = useState(false)
  const [editingPaycheckId, setEditingPaycheckId] = useState<string | null>(null)

  const [selectedPaycheckId, setSelectedPaycheckId] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<PaycheckDetail | null>(null)
  const [selectedAllocations, setSelectedAllocations] = useState<
    Array<{
      envelope_id: string
      amount_cents: number
      allocation_month: string
      envelope: { name: string } | null
    }>
  >([])
  const [reportFromDate, setReportFromDate] = useState(format(new Date(), 'yyyy-MM-01'))
  const [reportToDate, setReportToDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [reportLoading, setReportLoading] = useState(false)
  const [reportPreset, setReportPreset] = useState<DatePreset>('this_month')
  const [reportItems, setReportItems] = useState<
    Array<
      | {
          type: 'paycheck'
          id: string
          date: string
          title: string
          amount_cents: number
          allocations: Array<{ envelopeName: string; amount_cents: number; allocationMonth: string }>
        }
      | {
          type: 'move'
          id: string
          date: string
          title: string
          amount_cents: number
          reason: string | null
          fromName: string
          toName: string
        }
    >
  >([])
  const [reportSpendingTotalCents, setReportSpendingTotalCents] = useState(0)
  const [reportSpendingByCategory, setReportSpendingByCategory] = useState<
    Array<{ envelopeId: string; envelopeName: string; spent_cents: number }>
  >([])
  const [reportDailySpending, setReportDailySpending] = useState<
    Array<{ date: string; spent_cents: number }>
  >([])
  const [reportOverspentEnvelopes, setReportOverspentEnvelopes] = useState<
    Array<{ name: string; balance_cents: number }>
  >([])
  const currentMonthForNewRows = format(new Date(), 'yyyy-MM')
  const defaultAllocationMonth = date.slice(0, 7)
  const [assignedByEnvelopeMonth, setAssignedByEnvelopeMonth] = useState<Record<string, number>>({})
  const [editingOriginalAssigned, setEditingOriginalAssigned] = useState<Record<string, number>>({})
  const editingPaycheckIdRef = useRef<string | null>(null)

  useEffect(() => {
    editingPaycheckIdRef.current = editingPaycheckId
  }, [editingPaycheckId])

  useEffect(() => {
    if (sourceMode !== 'saved' || !selectedSourceId) return
    const row = paycheckSources.find((item) => item.id === selectedSourceId)
    if (row) setSource(row.name)
  }, [sourceMode, selectedSourceId, paycheckSources])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const [envelopesResp, historyResp, assignmentsResp, accountsResp, sourcesResp] = await Promise.all([
        supabase
          .from('envelopes')
          .select('id,name,balance_cents,budget_target_cents,goal_type,goal_target_cents')
          .eq('archived', false)
          .order('name', { ascending: true }),
        supabase
          .from('paychecks')
          .select('id,date,source,net_amount_cents,deposit_account_id,source_id')
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase.from('paycheck_allocations').select('envelope_id,allocation_month,amount_cents'),
        supabase
          .from('financial_accounts')
          .select('id,name,balance_cents,account_type')
          .eq('archived', false)
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
        supabase
          .from('paycheck_sources')
          .select('id,name,expected_amount_cents,sort_order,archived')
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
      ])
      if (envelopesResp.error) throw envelopesResp.error
      if (historyResp.error) throw historyResp.error
      if (assignmentsResp.error) throw assignmentsResp.error
      if (accountsResp.error) throw accountsResp.error
      if (sourcesResp.error) throw sourcesResp.error
      const loadedEnvelopes = (envelopesResp.data ?? []) as Envelope[]
      const depositCandidates = ((accountsResp.data ?? []) as DepositAccount[]).filter(
        (account) => account.account_type !== 'credit_card' && account.account_type !== 'debt',
      )
      setEnvelopes(loadedEnvelopes)
      setDepositAccounts(depositCandidates)
      setHistory((historyResp.data ?? []) as PaycheckSummary[])
      setPaycheckSources((sourcesResp.data ?? []) as PaycheckSource[])
      setDepositAccountId((prev) => {
        if (prev && depositCandidates.some((account) => account.id === prev)) return prev
        return depositCandidates[0]?.id ?? ''
      })
      const assignedMap: Record<string, number> = {}
      for (const row of (assignmentsResp.data ?? []) as Array<{
        envelope_id: string
        allocation_month: string
        amount_cents: number
      }>) {
        const key = `${row.envelope_id}|${row.allocation_month.slice(0, 7)}`
        assignedMap[key] = (assignedMap[key] ?? 0) + row.amount_cents
      }
      setAssignedByEnvelopeMonth(assignedMap)
      if (!editingPaycheckIdRef.current) {
        if (loadedEnvelopes.length === 0) {
          setAllocations([
            {
              lineId: newAllocationLineId(),
              envelopeId: '',
              amountDollars: '',
              allocationMonth: currentMonthForNewRows,
            },
          ])
        } else {
          setAllocations(
            loadedEnvelopes.map((envelope) => ({
              lineId: newAllocationLineId(),
              envelopeId: envelope.id,
              amountDollars: '',
              allocationMonth: currentMonthForNewRows,
            })),
          )
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load paycheck journal data.')
    } finally {
      setLoading(false)
    }
  }, [currentMonthForNewRows])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const netCents = dollarsStringToCents(netDollars) ?? 0
  const selectableSourceRows = useMemo(
    () =>
      paycheckSources.filter(
        (row) => !row.archived || (Boolean(selectedSourceId) && row.id === selectedSourceId),
      ),
    [paycheckSources, selectedSourceId],
  )
  const expectedBaselineCents = useMemo(() => {
    if (sourceMode !== 'saved' || !selectedSourceId) return null
    const row = paycheckSources.find((item) => item.id === selectedSourceId)
    return row ? row.expected_amount_cents : null
  }, [sourceMode, selectedSourceId, paycheckSources])
  const allocationSumCents = useMemo(
    () =>
      allocations.reduce((sum, row) => {
        const cents = dollarsStringToCents(row.amountDollars)
        return sum + (cents && cents > 0 ? cents : 0)
      }, 0),
    [allocations],
  )
  const remainderCents = netCents - allocationSumCents
  const sourceOk =
    sourceMode === 'other'
      ? source.trim().length > 0
      : Boolean(selectedSourceId) && Boolean(paycheckSources.some((item) => item.id === selectedSourceId))
  const canSave =
    sourceOk &&
    netCents > 0 &&
    remainderCents === 0 &&
    Boolean(depositAccountId) &&
    depositAccounts.length > 0

  async function addPaycheckSource() {
    setError(null)
    setNotice(null)
    const name = newSourceName.trim()
    const cents = dollarsStringToCents(newSourceExpectedDollars)
    if (!name) {
      setError('Source name is required.')
      return
    }
    if (cents === null || cents < 0) {
      setError('Expected amount must be zero or a positive dollar value.')
      return
    }
    setSourceMutationBusy(true)
    try {
      const supabase = getSupabase()
      const insertResp = await supabase
        .from('paycheck_sources')
        .insert({
          name,
          expected_amount_cents: cents,
          sort_order: 0,
          archived: false,
        })
        .select('id,name,expected_amount_cents,sort_order,archived')
        .single()
      if (insertResp.error) throw insertResp.error
      setNewSourceName('')
      setNewSourceExpectedDollars('')
      setNotice('Paycheck source saved.')
      await loadData()
      const created = insertResp.data as PaycheckSource
      setSourceMode('saved')
      setSelectedSourceId(created.id)
      setSource(created.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save paycheck source.')
    } finally {
      setSourceMutationBusy(false)
    }
  }

  async function updatePaycheckSource(row: PaycheckSource, name: string, expectedDollars: string) {
    setError(null)
    setNotice(null)
    const trimmed = name.trim()
    const cents = dollarsStringToCents(expectedDollars)
    if (!trimmed) {
      setError('Source name is required.')
      return
    }
    if (cents === null || cents < 0) {
      setError('Expected amount must be zero or a positive dollar value.')
      return
    }
    setSourceMutationBusy(true)
    try {
      const supabase = getSupabase()
      const updateResp = await supabase
        .from('paycheck_sources')
        .update({ name: trimmed, expected_amount_cents: cents })
        .eq('id', row.id)
      if (updateResp.error) throw updateResp.error
      if (selectedSourceId === row.id) {
        setSource(trimmed)
      }
      setNotice('Paycheck source updated.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update paycheck source.')
    } finally {
      setSourceMutationBusy(false)
    }
  }

  async function archivePaycheckSource(id: string) {
    setError(null)
    setNotice(null)
    setSourceMutationBusy(true)
    try {
      const supabase = getSupabase()
      const updateResp = await supabase.from('paycheck_sources').update({ archived: true }).eq('id', id)
      if (updateResp.error) throw updateResp.error
      if (selectedSourceId === id) {
        setSelectedSourceId('')
        setSourceMode('other')
      }
      setNotice('Source archived. Existing paychecks keep their labels; pick a new source for future entries.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive paycheck source.')
    } finally {
      setSourceMutationBusy(false)
    }
  }

  async function savePaycheck(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    if (!canSave) {
      setError('Paycheck must be fully allocated (remainder $0.00) before saving.')
      return
    }

    for (const row of allocations) {
      const cents = dollarsStringToCents(row.amountDollars) ?? 0
      if (cents > 0 && !row.envelopeId) {
        setError('Each line with an amount needs an envelope selected.')
        return
      }
    }

    const allocationPayload = allocations
      .map((row) => ({
        envelope_id: row.envelopeId,
        amount_cents: dollarsStringToCents(row.amountDollars) ?? 0,
        allocation_month: `${(row.allocationMonth || defaultAllocationMonth).slice(0, 7)}-01`,
      }))
      .filter((row) => row.amount_cents > 0 && row.envelope_id)

    setSaving(true)
    try {
      const pSourceId = sourceMode === 'saved' && selectedSourceId ? selectedSourceId : null
      const result = editingPaycheckId
        ? await getSupabase().rpc('update_paycheck_journal_entry', {
            p_paycheck_id: editingPaycheckId,
            p_date: date,
            p_source: source.trim(),
            p_net_amount_cents: netCents,
            p_notes: notes.trim() || null,
            p_allocations: allocationPayload,
            p_deposit_account_id: depositAccountId,
            p_source_id: pSourceId,
          })
        : await getSupabase().rpc('save_paycheck_journal_entry', {
            p_date: date,
            p_source: source.trim(),
            p_net_amount_cents: netCents,
            p_notes: notes.trim() || null,
            p_allocations: allocationPayload,
            p_deposit_account_id: depositAccountId,
            p_moves: [],
            p_source_id: pSourceId,
          })
      if (result.error) throw result.error

      const detailId = editingPaycheckId ?? (typeof result.data === 'string' ? result.data : null)
      const wasEditing = Boolean(editingPaycheckId)
      editingPaycheckIdRef.current = null
      setEditingPaycheckId(null)
      setEditingOriginalAssigned({})
      setSourceMode('other')
      setSelectedSourceId('')
      setSource('')
      setNetDollars('')
      setNotes('')
      setNotice(wasEditing ? 'Paycheck journal entry updated.' : 'Paycheck journal entry saved.')
      await loadData()
      if (detailId) {
        setSelectedPaycheckId(detailId)
        await viewPaycheck(detailId)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save paycheck entry.')
    } finally {
      setSaving(false)
    }
  }

  async function viewPaycheck(paycheckId: string) {
    setSelectedPaycheckId(paycheckId)
    setError(null)
    try {
      const supabase = getSupabase()
      const [detailResp, allocationsResp] = await Promise.all([
        supabase
          .from('paychecks')
          .select(
            'id,date,source,net_amount_cents,notes,deposit_account_id,source_id,paycheck_sources:source_id(name,expected_amount_cents)',
          )
          .eq('id', paycheckId)
          .single(),
        supabase
          .from('paycheck_allocations')
          .select('envelope_id,amount_cents,allocation_month,envelope:envelope_id(name)')
          .eq('paycheck_id', paycheckId)
          .order('amount_cents', { ascending: false }),
      ])
      if (detailResp.error) throw detailResp.error
      if (allocationsResp.error) throw allocationsResp.error
      setSelectedDetail(detailResp.data as PaycheckDetail)
      setSelectedAllocations(
        (allocationsResp.data ?? []) as unknown as Array<{
          envelope_id: string
          amount_cents: number
          allocation_month: string
          envelope: { name: string } | null
        }>,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load paycheck detail.')
    }
  }

  async function startEditingPaycheck(paycheckId: string) {
    setError(null)
    editingPaycheckIdRef.current = paycheckId
    const supabase = getSupabase()
    const [detailResp, allocationsResp] = await Promise.all([
      supabase
        .from('paychecks')
        .select('id,date,source,net_amount_cents,notes,deposit_account_id,source_id')
        .eq('id', paycheckId)
        .single(),
      supabase
        .from('paycheck_allocations')
        .select('envelope_id,amount_cents,allocation_month')
        .eq('paycheck_id', paycheckId),
    ])
    if (detailResp.error) {
      editingPaycheckIdRef.current = null
      setError(detailResp.error.message)
      return
    }
    if (allocationsResp.error) {
      editingPaycheckIdRef.current = null
      setError(allocationsResp.error.message)
      return
    }

    const detail = detailResp.data as {
      date: string
      source: string
      net_amount_cents: number
      notes: string | null
      deposit_account_id: string | null
      source_id: string | null
    }
    const rows = (allocationsResp.data ?? []) as Array<{
      envelope_id: string
      amount_cents: number
      allocation_month: string
    }>
    const baseline: Record<string, number> = {}
    for (const row of rows) {
      const key = `${row.envelope_id}|${row.allocation_month.slice(0, 7)}`
      baseline[key] = (baseline[key] ?? 0) + row.amount_cents
    }
    setEditingOriginalAssigned(baseline)
    setDate(detail.date)
    if (detail.source_id) {
      setSourceMode('saved')
      setSelectedSourceId(detail.source_id)
    } else {
      setSourceMode('other')
      setSelectedSourceId('')
    }
    setSource(detail.source)
    setNetDollars((detail.net_amount_cents / 100).toFixed(2))
    setNotes(detail.notes ?? '')
    setDepositAccountId(
      detail.deposit_account_id && depositAccounts.some((a) => a.id === detail.deposit_account_id)
        ? detail.deposit_account_id
        : depositAccounts[0]?.id ?? '',
    )
    const monthDefault = detail.date.slice(0, 7)
    if (rows.length === 0) {
      setAllocations(
        envelopes.length === 0
          ? [{ lineId: newAllocationLineId(), envelopeId: '', amountDollars: '', allocationMonth: monthDefault }]
          : envelopes.map((e) => ({
              lineId: newAllocationLineId(),
              envelopeId: e.id,
              amountDollars: '',
              allocationMonth: monthDefault,
            })),
      )
    } else {
      setAllocations(
        rows.map((r) => ({
          lineId: newAllocationLineId(),
          envelopeId: r.envelope_id,
          amountDollars: (r.amount_cents / 100).toFixed(2),
          allocationMonth: r.allocation_month.slice(0, 7),
        })),
      )
    }
    setEditingPaycheckId(paycheckId)
    editingPaycheckIdRef.current = paycheckId
  }

  async function loadRangeReport() {
    setReportLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const moveTs = envelopeMovesCreatedAtFilter(reportFromDate, reportToDate)
      const [paychecksResp, movesResp, transactionsResp, overspentResp] = await Promise.all([
        supabase
          .from('paychecks')
          .select('id,date,source,net_amount_cents')
          .gte('date', reportFromDate)
          .lte('date', reportToDate)
          .order('date', { ascending: false }),
        supabase
          .from('envelope_moves')
          .select(
            'id,created_at,amount_cents,reason,from_envelope:from_envelope_id(name),to_envelope:to_envelope_id(name)',
          )
          .gte('created_at', moveTs.gte)
          .lt('created_at', moveTs.lt)
          .order('created_at', { ascending: false }),
        supabase
          .from('transactions')
          .select('date,amount_cents,envelope_id,envelope:envelope_id(name)')
          .eq('archived', false)
          .gte('date', reportFromDate)
          .lte('date', reportToDate),
        supabase
          .from('envelopes')
          .select('id,name,balance_cents')
          .eq('archived', false)
          .lt('balance_cents', 0)
          .order('balance_cents', { ascending: true }),
      ])
      if (paychecksResp.error) throw paychecksResp.error
      if (movesResp.error) throw movesResp.error
      if (transactionsResp.error) throw transactionsResp.error
      if (overspentResp.error) throw overspentResp.error

      const paycheckRows = paychecksResp.data ?? []
      const paycheckIds = paycheckRows.map((row) => row.id)
      let allocationMap = new Map<
        string,
        Array<{ envelopeName: string; amount_cents: number; allocationMonth: string }>
      >()
      if (paycheckIds.length > 0) {
        const allocationsResp = await supabase
          .from('paycheck_allocations')
          .select('paycheck_id,amount_cents,allocation_month,envelope:envelope_id(name)')
          .in('paycheck_id', paycheckIds)
        if (allocationsResp.error) throw allocationsResp.error
        allocationMap = new Map()
        for (const row of allocationsResp.data ?? []) {
          const arr = allocationMap.get(row.paycheck_id) ?? []
          const envRel = row.envelope as { name: string } | { name: string }[] | null | undefined
          const envelopeName = Array.isArray(envRel) ? (envRel[0]?.name ?? 'Envelope') : (envRel?.name ?? 'Envelope')
          arr.push({
            envelopeName,
            amount_cents: row.amount_cents,
            allocationMonth: row.allocation_month,
          })
          allocationMap.set(row.paycheck_id, arr)
        }
      }

      const merged: Array<
        | {
            type: 'paycheck'
            id: string
            date: string
            title: string
            amount_cents: number
            allocations: Array<{ envelopeName: string; amount_cents: number; allocationMonth: string }>
          }
        | {
            type: 'move'
            id: string
            date: string
            title: string
            amount_cents: number
            reason: string | null
            fromName: string
            toName: string
          }
      > = []

      for (const row of paycheckRows) {
        merged.push({
          type: 'paycheck',
          id: row.id,
          date: row.date,
          title: row.source,
          amount_cents: row.net_amount_cents,
          allocations: allocationMap.get(row.id) ?? [],
        })
      }

      for (const row of movesResp.data ?? []) {
        const fromRel = row.from_envelope as { name: string } | { name: string }[] | null | undefined
        const toRel = row.to_envelope as { name: string } | { name: string }[] | null | undefined
        const fromName = Array.isArray(fromRel) ? (fromRel[0]?.name ?? 'From') : (fromRel?.name ?? 'From')
        const toName = Array.isArray(toRel) ? (toRel[0]?.name ?? 'To') : (toRel?.name ?? 'To')
        merged.push({
          type: 'move',
          id: row.id,
          date: row.created_at.slice(0, 10),
          title: 'Envelope move',
          amount_cents: row.amount_cents,
          reason: row.reason,
          fromName,
          toName,
        })
      }

      merged.sort((a, b) => {
        if (a.date === b.date) return a.type === 'move' ? -1 : 1
        return a.date < b.date ? 1 : -1
      })
      setReportItems(merged)

      const txRows = (transactionsResp.data ?? []) as unknown as Array<{
        date: string
        amount_cents: number
        envelope_id: string
        envelope: { name: string } | { name: string }[] | null
      }>
      const byCategory = new Map<string, { envelopeId: string; envelopeName: string; spent_cents: number }>()
      const byDay = new Map<string, number>()
      let spendingTotal = 0
      for (const tx of txRows) {
        spendingTotal += tx.amount_cents
        const category = byCategory.get(tx.envelope_id)
        const envRel = tx.envelope as { name: string } | { name: string }[] | null | undefined
        const envelopeName = Array.isArray(envRel) ? (envRel[0]?.name ?? 'Unknown envelope') : (envRel?.name ?? 'Unknown envelope')
        if (category) {
          category.spent_cents += tx.amount_cents
        } else {
          byCategory.set(tx.envelope_id, {
            envelopeId: tx.envelope_id,
            envelopeName,
            spent_cents: tx.amount_cents,
          })
        }
        byDay.set(tx.date, (byDay.get(tx.date) ?? 0) + tx.amount_cents)
      }
      setReportSpendingTotalCents(spendingTotal)
      setReportSpendingByCategory(
        [...byCategory.values()].sort((a, b) => b.spent_cents - a.spent_cents),
      )
      setReportDailySpending(
        [...byDay.entries()]
          .map(([date, spent_cents]) => ({ date, spent_cents }))
          .sort((a, b) => (a.date < b.date ? -1 : 1)),
      )
      setReportOverspentEnvelopes(
        (overspentResp.data ?? []) as Array<{ name: string; balance_cents: number }>,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load range report.')
    } finally {
      setReportLoading(false)
    }
  }

  function applyReportPreset(preset: DatePreset) {
    const today = new Date()
    setReportPreset(preset)
    if (preset === 'all_time') {
      setReportFromDate('2000-01-01')
      setReportToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'this_month') {
      setReportFromDate(format(new Date(today.getFullYear(), today.getMonth(), 1), 'yyyy-MM-dd'))
      setReportToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'last_30') {
      const from = new Date(today)
      from.setDate(from.getDate() - 29)
      setReportFromDate(format(from, 'yyyy-MM-dd'))
      setReportToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'last_90') {
      const from = new Date(today)
      from.setDate(from.getDate() - 89)
      setReportFromDate(format(from, 'yyyy-MM-dd'))
      setReportToDate(format(today, 'yyyy-MM-dd'))
    }
  }

  function allocationMonthKey(envelopeId: string, monthRaw: string) {
    return `${envelopeId}|${(monthRaw || defaultAllocationMonth).slice(0, 7)}`
  }

  function draftSumForEnvelopeMonth(allRows: AllocationLine[], envelopeId: string, monthRaw: string) {
    const mk = allocationMonthKey(envelopeId, monthRaw)
    return allRows.reduce((sum, r) => {
      if (!r.envelopeId) return sum
      if (allocationMonthKey(r.envelopeId, r.allocationMonth) !== mk) return sum
      const c = dollarsStringToCents(r.amountDollars) ?? 0
      return sum + Math.max(c, 0)
    }, 0)
  }

  function goalProjection(envelope: Envelope | undefined, row: AllocationLine, allRows: AllocationLine[]) {
    if (!envelope || !row.envelopeId) return null

    const monthKey = allocationMonthKey(row.envelopeId, row.allocationMonth)
    const persisted = assignedByEnvelopeMonth[monthKey] ?? 0
    const baseline = editingOriginalAssigned[monthKey] ?? 0
    const draftSum = draftSumForEnvelopeMonth(allRows, row.envelopeId, row.allocationMonth)

    const isRefill = envelope.goal_type === 'refill_up_to' && (envelope.goal_target_cents ?? 0) > 0
    if (isRefill) {
      const cap = envelope.goal_target_cents ?? 0
      const projectedBalance = envelope.balance_cents - baseline + draftSum
      const remainingHeadroom = Math.max(cap - projectedBalance, 0)
      const progress = cap > 0 ? Math.max(0, Math.min(100, Math.round((projectedBalance / cap) * 100))) : 0
      const overCap = projectedBalance > cap
      return {
        text: overCap
          ? `Refill cap: projected balance ${formatCurrencyFromCents(projectedBalance)} is above ${formatCurrencyFromCents(cap)}.`
          : `Refill cap: projected balance ${formatCurrencyFromCents(projectedBalance)} / ${formatCurrencyFromCents(cap)} (${formatCurrencyFromCents(remainingHeadroom)} headroom).`,
        progress,
        warning: overCap,
      }
    }

    if (envelope.budget_target_cents <= 0) return null
    const target = envelope.budget_target_cents
    const effectiveAssignedForMonth = Math.max(0, persisted - baseline + draftSum)

    const remaining = Math.max(target - effectiveAssignedForMonth, 0)
    const progress = Math.max(0, Math.min(100, Math.round((effectiveAssignedForMonth / target) * 100)))
    const warning = effectiveAssignedForMonth >= target
    return {
      text: warning
        ? `Monthly target: assigned ${formatCurrencyFromCents(effectiveAssignedForMonth)} / ${formatCurrencyFromCents(target)} this month.`
        : `Monthly target: ${formatCurrencyFromCents(effectiveAssignedForMonth)} / ${formatCurrencyFromCents(target)} (${formatCurrencyFromCents(remaining)} to go)`,
      progress,
      warning,
    }
  }

  return (
    <div className="space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface p-4 sm:p-6">
        <h1 className="section-title">Paycheck Journal</h1>
        <p className="section-subtitle">
          Log paycheck allocations with zero-based budgeting validation. Net pay is deposited to a real account
          (checking, savings, etc.) and the same amount is allocated to envelopes. Envelope moves are tracked from the
          Envelopes screen.
        </p>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">
            {error}
          </p>
        )}
        {notice && (
          <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
            {notice}
          </p>
        )}
      </section>

      <CollapsibleCard title="Saved paycheck sources" storageKey="journal-paycheck-sources">
        <h2 className="text-base font-semibold">Saved paycheck sources</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Each source stores the label you see in history and the net amount you usually expect per paycheck. When you
          log a paycheck you can pick one of these or use a one-time label instead.
        </p>
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="min-w-0 flex-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-300">New source name</span>
            <input
              type="text"
              value={newSourceName}
              onChange={(e) => setNewSourceName(e.target.value)}
              placeholder="e.g. Acme Corp"
              disabled={sourceMutationBusy}
              className="min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="w-full text-xs text-zinc-500 dark:text-zinc-400 sm:w-40">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-300">Expected net ($)</span>
            <input
              type="text"
              inputMode="decimal"
              value={newSourceExpectedDollars}
              onChange={(e) => setNewSourceExpectedDollars(e.target.value)}
              placeholder="0.00"
              disabled={sourceMutationBusy}
              className="min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <button
            type="button"
            disabled={sourceMutationBusy}
            onClick={() => void addPaycheckSource()}
            className="min-h-10 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sourceMutationBusy ? 'Saving…' : 'Add source'}
          </button>
        </div>
        <div className="mt-4 space-y-2">
          {paycheckSources.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No saved sources yet.</p>
          ) : (
            paycheckSources.map((row) => (
              <PaycheckSourceRowEditor
                key={row.id}
                row={row}
                busy={sourceMutationBusy}
                onUpdate={(r, name, dollars) => void updatePaycheckSource(r, name, dollars)}
                onArchive={(id) => void archivePaycheckSource(id)}
              />
            ))
          )}
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Log Paycheck" storageKey="journal-log-paycheck">
        <h2 className="text-base font-semibold">Log Paycheck</h2>
        {editingPaycheckId && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            Editing paycheck entry. Saving will rebalance envelope allocations.
          </p>
        )}
        <form onSubmit={savePaycheck} className="mt-4 space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Date</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <div className="text-sm sm:col-span-2 xl:col-span-3">
              <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Source</span>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="inline-flex cursor-pointer items-center gap-2 text-zinc-700 dark:text-zinc-200">
                  <input
                    type="radio"
                    name="journal-paycheck-source-mode"
                    checked={sourceMode === 'saved'}
                    onChange={() => setSourceMode('saved')}
                    className="h-4 w-4 border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-600"
                  />
                  Saved source
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2 text-zinc-700 dark:text-zinc-200">
                  <input
                    type="radio"
                    name="journal-paycheck-source-mode"
                    checked={sourceMode === 'other'}
                    onChange={() => {
                      setSourceMode('other')
                      setSelectedSourceId('')
                    }}
                    className="h-4 w-4 border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-600"
                  />
                  One-time / other
                </label>
              </div>
              {sourceMode === 'saved' ? (
                <div className="mt-2 space-y-2">
                  {selectableSourceRows.length === 0 ? (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Add at least one saved source above, or choose &quot;One-time / other&quot;.
                    </p>
                  ) : (
                    <select
                      value={selectedSourceId}
                      onChange={(e) => setSelectedSourceId(e.target.value)}
                      required={sourceMode === 'saved'}
                      className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                    >
                      <option value="">Select a source…</option>
                      {selectableSourceRows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                          {row.archived ? ' (archived)' : ''} — exp. {formatCurrencyFromCents(row.expected_amount_cents)}
                        </option>
                      ))}
                    </select>
                  )}
                  {expectedBaselineCents !== null && (
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Expected net for this source: {formatCurrencyFromCents(expectedBaselineCents)}. Enter the actual
                      net above; while allocating you will see how much is extra vs that baseline.
                    </p>
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="e.g. Side gig, bonus, gift"
                  required={sourceMode === 'other'}
                  className="mt-2 min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                />
              )}
            </div>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Net ($)</span>
              <input
                type="text"
                inputMode="decimal"
                value={netDollars}
                onChange={(e) => setNetDollars(e.target.value)}
                placeholder="0.00"
                required
                className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Deposit to account</span>
              <select
                value={depositAccountId}
                onChange={(e) => setDepositAccountId(e.target.value)}
                required
                disabled={depositAccounts.length === 0}
                className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              >
                {depositAccounts.length === 0 ? (
                  <option value="">Add a checking or savings account first</option>
                ) : (
                  depositAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {formatAccountDropdownLabel(account.name, account.balance_cents)}
                    </option>
                  ))
                )}
              </select>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                This account's balance increases by the net amount when you save (credit cards and loan accounts are
                excluded here).
              </p>
            </label>
            <label className="text-sm sm:col-span-2 xl:col-span-3">
              <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Notes (optional)</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional context for this paycheck"
                className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
          </div>

          <div className="rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800">
            <h3 className="text-sm font-semibold">Allocations</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Allocate the full net amount across envelopes. Use multiple lines for the same category to fund
              different months from one paycheck (for example $400 to April and $100 to May). Opening-balance deposits
              start with no lines filled—add amounts until the remainder is $0.00.
            </p>
            {expectedBaselineCents !== null && netCents > 0 && (
              <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-200">
                Compared to saved source: expected {formatCurrencyFromCents(expectedBaselineCents)}, this entry net is{' '}
                {formatCurrencyFromCents(netCents)}.
                {netCents >= expectedBaselineCents ? (
                  <>
                    {' '}
                    Extra above expected:{' '}
                    <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                      {formatCurrencyFromCents(netCents - expectedBaselineCents)}
                    </span>
                    .
                  </>
                ) : (
                  <>
                    {' '}
                    Below expected by:{' '}
                    <span className="font-semibold text-amber-700 dark:text-amber-300">
                      {formatCurrencyFromCents(expectedBaselineCents - netCents)}
                    </span>
                    .
                  </>
                )}
              </p>
            )}
            <div className="mt-3 space-y-2">
              {allocations.map((row, idx) => {
                const envelope = envelopes.find((item) => item.id === row.envelopeId)
                const projection = goalProjection(envelope, row, allocations)
                return (
                  <div
                    key={row.lineId}
                    className="grid grid-cols-1 gap-2 rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_auto_auto_auto] sm:items-end"
                  >
                    <label className="text-xs text-zinc-500 dark:text-zinc-400 sm:col-span-2 lg:col-span-1">
                      <span className="mb-1 block text-zinc-600 dark:text-zinc-300">Envelope</span>
                      <select
                        value={row.envelopeId}
                        onChange={(e) =>
                          setAllocations((prev) =>
                            prev.map((item, itemIdx) =>
                              itemIdx === idx ? { ...item, envelopeId: e.target.value } : item,
                            ),
                          )
                        }
                        className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                      >
                        <option value="">Select…</option>
                        {envelopes.map((env) => (
                          <option key={env.id} value={env.id}>
                            {formatEnvelopeDropdownLabel(env.name, env.balance_cents)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-zinc-500 dark:text-zinc-400">
                      Budget month
                      <input
                        type="month"
                        value={row.allocationMonth}
                        onChange={(e) =>
                          setAllocations((prev) =>
                            prev.map((item, itemIdx) =>
                              itemIdx === idx ? { ...item, allocationMonth: e.target.value } : item,
                            ),
                          )
                        }
                        className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-xs outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                      />
                    </label>
                    <label className="text-xs text-zinc-500 dark:text-zinc-400">
                      Amount ($)
                      <input
                        type="text"
                        inputMode="decimal"
                        value={row.amountDollars}
                        onChange={(e) =>
                          setAllocations((prev) =>
                            prev.map((item, itemIdx) =>
                              itemIdx === idx ? { ...item, amountDollars: e.target.value } : item,
                            ),
                          )
                        }
                        placeholder="0.00"
                        className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950 lg:w-28"
                      />
                    </label>
                    <div className="flex items-end pb-0.5">
                      <button
                        type="button"
                        disabled={allocations.length <= 1}
                        onClick={() =>
                          setAllocations((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
                        }
                        className="btn-danger px-2.5 text-xs disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                    {envelope && (
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 sm:col-span-2 lg:col-span-4">
                        Current balance: {formatCurrencyFromCents(envelope.balance_cents)}
                      </p>
                    )}
                    {projection && (
                      <div className="sm:col-span-2 lg:col-span-4">
                        <p
                          className={[
                            'text-[11px]',
                            projection.warning
                              ? 'text-amber-700 dark:text-amber-300'
                              : 'text-zinc-500 dark:text-zinc-400',
                          ].join(' ')}
                        >
                          {projection.text}
                        </p>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                          <div
                            className={[
                              'h-full rounded-full',
                              projection.warning ? 'bg-amber-500' : 'bg-emerald-500',
                            ].join(' ')}
                            style={{ width: `${projection.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              onClick={() =>
                setAllocations((prev) => [
                  ...prev,
                  {
                    lineId: newAllocationLineId(),
                    envelopeId: prev[0]?.envelopeId || envelopes[0]?.id || '',
                    amountDollars: '',
                    allocationMonth: defaultAllocationMonth,
                  },
                ])
              }
              className="mt-2 min-h-10 rounded-lg border border-zinc-300 px-3 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
            >
              Add allocation line
            </button>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-sm">
                Allocated: <span className="font-semibold">{formatCurrencyFromCents(allocationSumCents)}</span>
              </p>
              <p
                className={[
                  'text-sm font-semibold',
                  remainderCents === 0
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-red-700 dark:text-red-300',
                ].join(' ')}
              >
                Remainder: {formatCurrencyFromCents(remainderCents)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={!canSave || saving}
              className="min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving...' : editingPaycheckId ? 'Update Journal Entry' : 'Save Journal Entry'}
            </button>
            {editingPaycheckId && (
              <button
                type="button"
                onClick={() => {
                  editingPaycheckIdRef.current = null
                  setEditingPaycheckId(null)
                  setEditingOriginalAssigned({})
                  setSourceMode('other')
                  setSelectedSourceId('')
                  setSource('')
                  setNetDollars('')
                  setNotes('')
                  setDepositAccountId(depositAccounts[0]?.id ?? '')
                  void loadData()
                }}
                className="min-h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium dark:border-zinc-700"
              >
                Cancel Edit
              </button>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Save is enabled only when remainder is exactly $0.00.
            </p>
          </div>
        </form>
      </CollapsibleCard>

      <CollapsibleCard title="Journal History" storageKey="journal-history">
        <h2 className="text-base font-semibold">Journal History</h2>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading history...</p>
        ) : history.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No paycheck entries yet.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => void viewPaycheck(entry.id)}
                className={[
                  'w-full rounded-xl border p-3.5 text-left transition',
                  selectedPaycheckId === entry.id
                    ? 'border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40'
                    : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50',
                ].join(' ')}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{entry.source}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {format(new Date(entry.date), 'MMM d, yyyy')} • Net{' '}
                      {formatCurrencyFromCents(entry.net_amount_cents)}
                      {entry.deposit_account_id
                        ? ` • ${depositAccounts.find((a) => a.id === entry.deposit_account_id)?.name ?? 'Account'}`
                        : ' • No deposit account (legacy)'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      void startEditingPaycheck(entry.id)
                    }}
                    className="min-h-9 rounded-lg border border-zinc-300 px-3 text-xs font-medium dark:border-zinc-700"
                  >
                    Edit
                  </button>
                </div>
              </button>
            ))}
          </div>
        )}
      </CollapsibleCard>

      {selectedDetail && (
        <CollapsibleCard title="Journal Report" storageKey="journal-report-selected">
          <h2 className="text-base font-semibold">Journal Report</h2>
          <div className="mt-3 space-y-2 text-sm">
            <p className="font-semibold">
              Paycheck — {selectedDetail.source} — {format(new Date(selectedDetail.date), 'MMMM d, yyyy')} — Net:{' '}
              {formatCurrencyFromCents(selectedDetail.net_amount_cents)}
            </p>
            {(() => {
              const linked = unwrapPaycheckSourceRelation(selectedDetail.paycheck_sources)
              if (!linked) return null
              const delta = selectedDetail.net_amount_cents - linked.expected_amount_cents
              return (
                <p className="text-zinc-600 dark:text-zinc-300">
                  Linked source expected {formatCurrencyFromCents(linked.expected_amount_cents)}.
                  {delta >= 0 ? (
                    <>
                      {' '}
                      Extra above expected: {formatCurrencyFromCents(delta)}.
                    </>
                  ) : (
                    <>
                      {' '}
                      Below expected by: {formatCurrencyFromCents(-delta)}.
                    </>
                  )}
                </p>
              )
            })()}
            <p className="text-zinc-600 dark:text-zinc-300">
              Deposited to:{' '}
              {selectedDetail.deposit_account_id
                ? depositAccounts.find((a) => a.id === selectedDetail.deposit_account_id)?.name ??
                  'Account (not in current list)'
                : 'Not recorded (legacy entry)'}
            </p>
            {selectedAllocations.length === 0 ? (
              <p className="text-zinc-600 dark:text-zinc-300">
                Nothing assigned to envelopes yet — this deposit is still fully unassigned (
                {formatCurrencyFromCents(selectedDetail.net_amount_cents)}).
              </p>
            ) : (
              selectedAllocations.map((allocation, allocIdx) => (
                <p key={`${allocation.envelope_id}-${allocIdx}-${allocation.allocation_month}`}>
                  • {allocation.envelope?.name ?? 'Envelope'} → {formatCurrencyFromCents(allocation.amount_cents)} (
                  {format(new Date(allocation.allocation_month), 'MMM yyyy')})
                </p>
              ))
            )}
            {selectedAllocations.length > 0 && (
              <p className="font-medium text-emerald-700 dark:text-emerald-300">
                Fully assigned to envelopes for this entry.
              </p>
            )}
            {selectedDetail.notes && (
              <p className="text-zinc-600 dark:text-zinc-300">Notes: {selectedDetail.notes}</p>
            )}
          </div>
        </CollapsibleCard>
      )}

      <CollapsibleCard title="Activity Report (Date Range)" storageKey="journal-activity-report">
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <h2 className="text-base font-semibold">Activity Report (Date Range)</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadRangeReport()}
              disabled={reportLoading}
              className="btn-secondary px-3 text-xs"
            >
              {reportLoading ? 'Loading...' : 'Load Report'}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="btn-secondary px-3 text-xs"
            >
              Print Report
            </button>
          </div>
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden print:hidden">
          {(
            [
              ['this_month', 'This month'],
              ['last_30', 'Last 30'],
              ['last_90', 'Last 90'],
              ['all_time', 'All time'],
              ['custom', 'Custom'],
            ] as Array<[DatePreset, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => applyReportPreset(value)}
              className={[
                'min-h-10 rounded-lg border px-3 text-xs font-medium',
                reportPreset === value
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:max-w-xl print:hidden">
          <input
            type="date"
            value={reportFromDate}
            onChange={(event) => {
              setReportPreset('custom')
              setReportFromDate(event.target.value)
            }}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            type="date"
            value={reportToDate}
            onChange={(event) => {
              setReportPreset('custom')
              setReportToDate(event.target.value)
            }}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>

        {(reportItems.length > 0 || reportSpendingByCategory.length > 0) && (
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Total spending</p>
              <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                -{formatCurrencyFromCents(reportSpendingTotalCents)}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Paychecks in range</p>
              <p className="text-sm font-semibold">
                {reportItems.filter((item) => item.type === 'paycheck').length}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Envelope moves in range</p>
              <p className="text-sm font-semibold">
                {reportItems.filter((item) => item.type === 'move').length}
              </p>
            </div>
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Overspent envelopes now</p>
              <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                {reportOverspentEnvelopes.length}
              </p>
            </div>
          </div>
        )}

        {reportSpendingByCategory.length > 0 && (
          <div className="mt-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-sm font-semibold">Category Breakdown</h3>
            <div className="mt-2 space-y-2">
              {reportSpendingByCategory.slice(0, 8).map((row) => {
                const pct =
                  reportSpendingTotalCents > 0
                    ? Math.round((row.spent_cents / reportSpendingTotalCents) * 100)
                    : 0
                return (
                  <div key={row.envelopeId}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate pr-2">{row.envelopeName}</span>
                      <span className="font-medium">
                        -{formatCurrencyFromCents(row.spent_cents)} ({pct}%)
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {reportDailySpending.length > 0 && (
          <div className="mt-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-sm font-semibold">Recent Daily Trend</h3>
            <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-3">
              {reportDailySpending.slice(-9).map((day) => (
                <p key={day.date} className="text-xs text-zinc-600 dark:text-zinc-300">
                  {format(new Date(day.date), 'MMM d')}: -{formatCurrencyFromCents(day.spent_cents)}
                </p>
              ))}
            </div>
          </div>
        )}

        {reportOverspentEnvelopes.length > 0 && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
            <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">Overspending Flags</h3>
            <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {reportOverspentEnvelopes.map((env) => (
                <p key={env.name} className="text-xs text-red-800 dark:text-red-200">
                  {env.name}: {formatCurrencyFromCents(env.balance_cents)}
                </p>
              ))}
            </div>
          </div>
        )}

        {reportItems.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            No report loaded yet (or no entries in selected range).
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {reportItems.map((item) => (
              <div key={`${item.type}-${item.id}`} className="rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800 print:break-inside-avoid">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">
                      {item.type === 'paycheck' ? `Paycheck • ${item.title}` : `Move • ${item.fromName} → ${item.toName}`}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {format(new Date(item.date), 'MMM d, yyyy')}
                      {item.type === 'move' && item.reason ? ` • ${item.reason}` : ''}
                    </p>
                  </div>
                  <p
                    className={[
                      'text-sm font-semibold',
                      item.type === 'paycheck'
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-zinc-700 dark:text-zinc-300',
                    ].join(' ')}
                  >
                    {item.type === 'paycheck' ? '+' : ''}
                    {formatCurrencyFromCents(item.amount_cents)}
                  </p>
                </div>
                {item.type === 'paycheck' && item.allocations.length > 0 && (
                  <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
                    {item.allocations.map((allocation) => (
                      <p key={`${item.id}-${allocation.envelopeName}-${allocation.allocationMonth}`}>
                        • {allocation.envelopeName}: {formatCurrencyFromCents(allocation.amount_cents)} (
                        {format(new Date(allocation.allocationMonth), 'MMM yyyy')})
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>
    </div>
  )
}
