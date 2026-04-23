import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addMonths,
  eachMonthOfInterval,
  endOfMonth,
  format,
  startOfMonth,
  subDays,
  subMonths,
  differenceInCalendarDays,
} from 'date-fns'
import { Link } from 'react-router-dom'
import { SpendingPieChart, type PieSlice } from '../components/reports/SpendingPieChart'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import { DatePickerInput } from '../components/ui/DatePickerInput'
import { formatCurrencyFromCents } from '../lib/currency'
import { modelMonthlyPaymentCents, simulateDebtPayoff } from '../lib/debtPayoff'
import { downloadReportsPdf, pdfCell } from '../lib/reportsPdf'
import { parseCalendarDateLocal } from '../lib/localCalendarDate'
import { getSupabase } from '../lib/supabase'

type DatePreset = 'this_month' | 'last_month' | 'last_3_months' | 'this_year' | 'last_12_months' | 'all_time' | 'custom'

type TxRow = {
  id: string
  date: string
  payee: string
  amount_cents: number
  envelope_id: string | null
  account_id: string | null
  transaction_kind: string
  note: string | null
  envelope: { name: string } | { name: string }[] | null
  account: { name: string } | { name: string }[] | null
}

type PaycheckRow = {
  id: string
  date: string
  source: string
  net_amount_cents: number
  source_id?: string | null
  paycheck_sources?: { expected_amount_cents: number } | { expected_amount_cents: number }[] | null
}

function linkedPaycheckSourceExpected(
  rel: PaycheckRow['paycheck_sources'],
): number | null {
  if (!rel) return null
  const row = Array.isArray(rel) ? rel[0] : rel
  if (!row || typeof row.expected_amount_cents !== 'number') return null
  return row.expected_amount_cents
}

function sumPaycheckExtraOverExpectedCents(pcs: PaycheckRow[]): number {
  let sum = 0
  for (const p of pcs) {
    const expected = linkedPaycheckSourceExpected(p.paycheck_sources)
    if (expected == null) continue
    if (p.net_amount_cents > expected) sum += p.net_amount_cents - expected
  }
  return sum
}

type EnvelopeMoveDetail = {
  id: string
  created_at: string
  amount_cents: number
  reason: string | null
  from_envelope: { name: string } | { name: string }[] | null
  to_envelope: { name: string } | { name: string }[] | null
}

type PaycheckAllocDetailRow = {
  paycheck_id: string
  envelope_id: string
  amount_cents: number
  allocation_month: string
  envelope: { name: string } | { name: string }[] | null
  paycheck: { date: string; source: string; net_amount_cents: number } | { date: string; source: string; net_amount_cents: number }[] | null
}

type LiabilityAccount = {
  id: string
  name: string
  account_type: string
  balance_cents: number
  apr_bps: number | null
  minimum_payment_cents: number | null
  planned_monthly_payment_cents: number | null
}

type AllocationRow = {
  envelope_id: string
  amount_cents: number
  allocation_month: string
  envelope: { name: string } | { name: string }[] | null
}

const PRESETS: Array<[DatePreset, string]> = [
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['last_3_months', 'Last 3 months'],
  ['this_year', 'Year to date'],
  ['last_12_months', 'Last 12 months'],
  ['all_time', 'All time'],
  ['custom', 'Custom'],
]

function applyPreset(preset: DatePreset, today = new Date()): { from: string; to: string } {
  const to = format(today, 'yyyy-MM-dd')
  if (preset === 'all_time') {
    return { from: '2000-01-01', to }
  }
  if (preset === 'this_month') {
    return { from: format(startOfMonth(today), 'yyyy-MM-dd'), to }
  }
  if (preset === 'last_month') {
    const start = startOfMonth(subMonths(today, 1))
    const end = endOfMonth(subMonths(today, 1))
    return { from: format(start, 'yyyy-MM-dd'), to: format(end, 'yyyy-MM-dd') }
  }
  if (preset === 'last_3_months') {
    const start = startOfMonth(subMonths(today, 2))
    return { from: format(start, 'yyyy-MM-dd'), to }
  }
  if (preset === 'this_year') {
    return { from: `${today.getFullYear()}-01-01`, to }
  }
  if (preset === 'last_12_months') {
    const start = startOfMonth(subMonths(today, 11))
    return { from: format(start, 'yyyy-MM-dd'), to }
  }
  return { from: format(startOfMonth(today), 'yyyy-MM-dd'), to }
}

function downloadCsv(filename: string, lines: string[][]) {
  const csv = lines.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Outflows are positive `amount_cents` in this app. */
function outflowCents(amount: number): number {
  return amount > 0 ? amount : 0
}

function inflowCents(amount: number): number {
  return amount < 0 ? -amount : 0
}

function joinName(rel: { name: string } | { name: string }[] | null | undefined, fallback: string): string {
  if (rel == null) return fallback
  if (Array.isArray(rel)) return rel[0]?.name ?? fallback
  return rel.name ?? fallback
}

/**
 * Inclusive calendar range for `envelope_moves.created_at` (timestamptz).
 * `fromDate` / `toDate` are plain `yyyy-MM-dd` from the same presets as transactions;
 * those are local calendar days, so bounds must be local midnight — not UTC midnight.
 */
function envelopeMovesCreatedAtFilter(fromDate: string, toDate: string): { gte: string; lt: string } {
  const start = new Date(`${fromDate}T00:00:00`)
  const endExclusive = new Date(`${toDate}T00:00:00`)
  endExclusive.setDate(endExclusive.getDate() + 1)
  return {
    gte: start.toISOString(),
    lt: endExclusive.toISOString(),
  }
}

type AccountTransferPairRow = {
  id: string
  date: string
  fromAccount: string
  toAccount: string
  amount_cents: number
  note: string | null
  outTransactionId: string
  inTransactionId: string
}

/** Pairs the two register lines produced by `create_account_transfer`; leaves odd rows as unpaired. */
function pairInternalAccountTransfers(transfers: TxRow[]): { pairs: AccountTransferPairRow[]; unpaired: TxRow[] } {
  const accountName = (t: TxRow) => joinName(t.account, 'Account')
  const negatives = transfers.filter((t) => t.amount_cents < 0)
  const usedNeg = new Set<string>()
  const pairs: AccountTransferPairRow[] = []

  for (const out of transfers) {
    if (out.amount_cents <= 0) continue
    const toMatch = out.payee.match(/^Transfer to (.+)$/)
    if (!toMatch) continue
    const toName = toMatch[1].trim()
    const noteKey = (out.note ?? '').trim()
    const fromAcc = accountName(out)

    for (const inc of negatives) {
      if (usedNeg.has(inc.id)) continue
      if (inc.date !== out.date) continue
      if (inc.amount_cents !== -out.amount_cents) continue
      if ((inc.note ?? '').trim() !== noteKey) continue
      if (!inc.account_id || inc.account_id === out.account_id) continue
      const fromMatch = inc.payee.match(/^Transfer from (.+)$/)
      if (!fromMatch) continue
      if (fromMatch[1].trim() !== fromAcc) continue
      if (accountName(inc) !== toName) continue

      usedNeg.add(inc.id)
      pairs.push({
        id: `${out.id}:${inc.id}`,
        date: out.date,
        fromAccount: fromAcc,
        toAccount: accountName(inc),
        amount_cents: out.amount_cents,
        note: out.note,
        outTransactionId: out.id,
        inTransactionId: inc.id,
      })
      break
    }
  }

  const inPair = new Set<string>()
  for (const p of pairs) {
    inPair.add(p.outTransactionId)
    inPair.add(p.inTransactionId)
  }
  const unpaired = transfers.filter((t) => !inPair.has(t.id))
  return { pairs, unpaired }
}

/** Same calendar length immediately before `from`…`to`. */
function computePreviousPeriod(fromStr: string, toStr: string): { from: string; to: string } | null {
  try {
    const from = parseCalendarDateLocal(fromStr)
    const to = parseCalendarDateLocal(toStr)
    if (from > to) return null
    const len = differenceInCalendarDays(to, from) + 1
    if (len < 1) return null
    const prevTo = subDays(from, 1)
    const prevFrom = subDays(prevTo, len - 1)
    return { from: format(prevFrom, 'yyyy-MM-dd'), to: format(prevTo, 'yyyy-MM-dd') }
  } catch {
    return null
  }
}

type KpiPack = {
  outEnvelope: number
  inEnvelope: number
  paycheckTotal: number
  paycheckExtraOverExpectedCents: number
  moveVolume: number
  moveCount: number
  funded: number
  paymentTotal: number
  txCount: number
  byKind: Array<[string, number]>
  netAfterPaychecks: number
}

function buildKpis(
  txs: TxRow[],
  pcs: PaycheckRow[],
  moves: EnvelopeMoveDetail[],
  allocs: AllocationRow[],
): KpiPack {
  let outEnvelope = 0
  let inEnvelope = 0
  const byKind = new Map<string, number>()
  for (const tx of txs) {
    outEnvelope += outflowCents(tx.amount_cents)
    inEnvelope += inflowCents(tx.amount_cents)
    const k = tx.transaction_kind || 'regular'
    byKind.set(k, (byKind.get(k) ?? 0) + tx.amount_cents)
  }
  const paycheckTotal = pcs.reduce((s, p) => s + p.net_amount_cents, 0)
  const paycheckExtraOverExpectedCents = sumPaycheckExtraOverExpectedCents(pcs)
  const moveVolume = moves.reduce((s, m) => s + Math.abs(m.amount_cents), 0)
  const funded = allocs.reduce((s, a) => s + a.amount_cents, 0)
  const paymentTotal = txs
    .filter((t) => t.transaction_kind === 'payment')
    .reduce((s, t) => s + outflowCents(t.amount_cents), 0)
  return {
    outEnvelope,
    inEnvelope,
    paycheckTotal,
    paycheckExtraOverExpectedCents,
    moveVolume,
    moveCount: moves.length,
    funded,
    paymentTotal,
    txCount: txs.length,
    byKind: [...byKind.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
    netAfterPaychecks: paycheckTotal - outEnvelope + inEnvelope,
  }
}

function pctChange(curr: number, prev: number): string {
  if (prev === 0) return curr === 0 ? '—' : '— (no prior)'
  const p = Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10
  const sign = p > 0 ? '+' : ''
  return `${sign}${p}%`
}

function toPieSlicesTopN(rows: Array<{ name: string; spent: number }>, n: number): PieSlice[] {
  const pos = rows.filter((r) => r.spent > 0).sort((a, b) => b.spent - a.spent)
  const top = pos.slice(0, n)
  const rest = pos.slice(n).reduce((s, r) => s + r.spent, 0)
  const out: PieSlice[] = top.map((r) => ({ name: r.name, value: r.spent }))
  if (rest > 0) out.push({ name: 'Other', value: rest })
  return out
}

function paycheckMeta(
  row: PaycheckAllocDetailRow,
): { date: string; source: string; net_amount_cents: number } {
  const p = row.paycheck
  if (p == null) return { date: '', source: '', net_amount_cents: 0 }
  if (Array.isArray(p)) return p[0] ?? { date: '', source: '', net_amount_cents: 0 }
  return p
}

export function ReportsPage() {
  const [preset, setPreset] = useState<DatePreset>('this_month')
  const [fromDate, setFromDate] = useState(() => applyPreset('this_month').from)
  const [toDate, setToDate] = useState(() => applyPreset('this_month').to)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [transactions, setTransactions] = useState<TxRow[]>([])
  const [paychecks, setPaychecks] = useState<PaycheckRow[]>([])
  const [envelopeMovesDetail, setEnvelopeMovesDetail] = useState<EnvelopeMoveDetail[]>([])
  const [allocations, setAllocations] = useState<AllocationRow[]>([])
  const [paycheckLinkedAllocations, setPaycheckLinkedAllocations] = useState<PaycheckAllocDetailRow[]>([])
  const [liabilities, setLiabilities] = useState<LiabilityAccount[]>([])
  const [avgDebtPaymentByAccount, setAvgDebtPaymentByAccount] = useState<Record<string, number>>({})
  const [debtAvgWindowMonths, setDebtAvgWindowMonths] = useState<3 | 6 | 12>(6)

  const [compareEnabled, setCompareEnabled] = useState(false)
  const [compareNotice, setCompareNotice] = useState<string | null>(null)
  const [cmpTransactions, setCmpTransactions] = useState<TxRow[]>([])
  const [cmpPaychecks, setCmpPaychecks] = useState<PaycheckRow[]>([])
  const [cmpMoves, setCmpMoves] = useState<EnvelopeMoveDetail[]>([])
  const [cmpAllocations, setCmpAllocations] = useState<AllocationRow[]>([])
  const [groupNamesById, setGroupNamesById] = useState<Record<string, string>>({})
  const [envelopeGroupIdByEnvelopeId, setEnvelopeGroupIdByEnvelopeId] = useState<Record<string, string | null>>({})

  const applyPresetAndDates = useCallback((p: DatePreset) => {
    setPreset(p)
    if (p === 'custom') return
    const { from, to } = applyPreset(p)
    setFromDate(from)
    setToDate(to)
  }, [])

  const loadReports = useCallback(async () => {
    if (!fromDate || !toDate || fromDate > toDate) {
      setError('Choose a valid date range (from ≤ to).')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const primaryLen = differenceInCalendarDays(parseCalendarDateLocal(toDate), parseCalendarDateLocal(fromDate)) + 1
      const compareBlocked = preset === 'all_time' || primaryLen > 366
      const compareRange = !compareBlocked && compareEnabled ? computePreviousPeriod(fromDate, toDate) : null
      if (compareEnabled && compareBlocked) {
        setCompareNotice('Compare needs a range of 366 days or less and is not available for All time.')
      } else {
        setCompareNotice(null)
      }

      const allocFrom = format(startOfMonth(parseCalendarDateLocal(fromDate)), 'yyyy-MM-dd')
      const allocTo = format(endOfMonth(parseCalendarDateLocal(toDate)), 'yyyy-MM-dd')
      const debtPaymentsSince = format(subMonths(new Date(), debtAvgWindowMonths), 'yyyy-MM-dd')
      const moveTs = envelopeMovesCreatedAtFilter(fromDate, toDate)

      const [txResp, pcResp, mvResp, alResp, liabResp, groupsResp, envResp] = await Promise.all([
        supabase
          .from('transactions')
          .select(
            'id,date,payee,amount_cents,envelope_id,account_id,transaction_kind,note,envelope:envelope_id(name),account:account_id(name)',
          )
          .eq('archived', false)
          .gte('date', fromDate)
          .lte('date', toDate)
          .order('date', { ascending: true })
          .limit(10_000),
        supabase
          .from('paychecks')
          .select(
            'id,date,source,net_amount_cents,source_id,paycheck_sources:source_id(expected_amount_cents)',
          )
          .gte('date', fromDate)
          .lte('date', toDate)
          .order('date', { ascending: false })
          .limit(2000),
        supabase
          .from('envelope_moves')
          .select(
            'id,created_at,amount_cents,reason,from_envelope:from_envelope_id(name),to_envelope:to_envelope_id(name)',
          )
          .gte('created_at', moveTs.gte)
          .lt('created_at', moveTs.lt)
          .order('created_at', { ascending: false })
          .limit(5000),
        supabase
          .from('paycheck_allocations')
          .select('envelope_id,amount_cents,allocation_month,envelope:envelope_id(name)')
          .gte('allocation_month', allocFrom)
          .lte('allocation_month', allocTo)
          .limit(20_000),
        supabase
          .from('financial_accounts')
          .select(
            'id,name,account_type,balance_cents,apr_bps,minimum_payment_cents,planned_monthly_payment_cents',
          )
          .eq('archived', false)
          .in('account_type', ['credit_card', 'debt'])
          .order('name', { ascending: true }),
        supabase.from('envelope_groups').select('id,name').eq('archived', false),
        supabase.from('envelopes').select('id,group_id').eq('archived', false),
      ])
      if (txResp.error) throw txResp.error
      if (pcResp.error) throw pcResp.error
      if (mvResp.error) throw mvResp.error
      if (alResp.error) throw alResp.error
      if (liabResp.error) throw liabResp.error
      if (groupsResp.error) throw groupsResp.error
      if (envResp.error) throw envResp.error

      const gNames: Record<string, string> = {}
      for (const g of (groupsResp.data ?? []) as Array<{ id: string; name: string }>) {
        gNames[g.id] = g.name
      }
      const egMap: Record<string, string | null> = {}
      for (const e of (envResp.data ?? []) as Array<{ id: string; group_id: string | null }>) {
        egMap[e.id] = e.group_id
      }
      setGroupNamesById(gNames)
      setEnvelopeGroupIdByEnvelopeId(egMap)

      setTransactions((txResp.data ?? []) as TxRow[])
      const paycheckRows = (pcResp.data ?? []) as PaycheckRow[]
      setPaychecks(paycheckRows)
      setEnvelopeMovesDetail((mvResp.data ?? []) as EnvelopeMoveDetail[])
      setAllocations((alResp.data ?? []) as AllocationRow[])

      const liabilityRows = (liabResp.data ?? []) as LiabilityAccount[]
      setLiabilities(liabilityRows)

      const paycheckIds = paycheckRows.map((p) => p.id)
      let linked: PaycheckAllocDetailRow[] = []
      if (paycheckIds.length > 0) {
        const par = await supabase
          .from('paycheck_allocations')
          .select(
            'paycheck_id,envelope_id,amount_cents,allocation_month,envelope:envelope_id(name),paycheck:paycheck_id(date,source,net_amount_cents)',
          )
          .in('paycheck_id', paycheckIds)
          .limit(20_000)
        if (par.error) throw par.error
        linked = (par.data ?? []) as PaycheckAllocDetailRow[]
      }
      linked.sort((a, b) => {
        const da = paycheckMeta(a).date
        const db = paycheckMeta(b).date
        if (da !== db) return db.localeCompare(da)
        return joinName(a.envelope, 'Envelope').localeCompare(joinName(b.envelope, 'Envelope'))
      })
      setPaycheckLinkedAllocations(linked)

      const liabIds = liabilityRows.map((l) => l.id)
      const avgPayments: Record<string, number> = {}
      if (liabIds.length > 0) {
        const payResp = await supabase
          .from('transactions')
          .select('account_id,amount_cents')
          .eq('archived', false)
          .eq('transaction_kind', 'payment')
          .in('account_id', liabIds)
          .gte('date', debtPaymentsSince)
        if (payResp.error) throw payResp.error
        const buckets: Record<string, number[]> = {}
        for (const row of (payResp.data ?? []) as Array<{ account_id: string; amount_cents: number }>) {
          const sz = Math.abs(row.amount_cents)
          if (sz <= 0) continue
          if (!buckets[row.account_id]) buckets[row.account_id] = []
          buckets[row.account_id].push(sz)
        }
        for (const [id, arr] of Object.entries(buckets)) {
          avgPayments[id] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
        }
      }
      setAvgDebtPaymentByAccount(avgPayments)

      if (compareRange) {
        const cf = compareRange.from
        const ct = compareRange.to
        const allocFromB = format(startOfMonth(parseCalendarDateLocal(cf)), 'yyyy-MM-dd')
        const allocToB = format(endOfMonth(parseCalendarDateLocal(ct)), 'yyyy-MM-dd')
        const moveTsB = envelopeMovesCreatedAtFilter(cf, ct)
        const [btxResp, bpcResp, bmvResp, balResp] = await Promise.all([
          supabase
            .from('transactions')
            .select(
              'id,date,payee,amount_cents,envelope_id,account_id,transaction_kind,note,envelope:envelope_id(name),account:account_id(name)',
            )
            .eq('archived', false)
            .gte('date', cf)
            .lte('date', ct)
            .order('date', { ascending: true })
            .limit(10_000),
          supabase
            .from('paychecks')
            .select(
              'id,date,source,net_amount_cents,source_id,paycheck_sources:source_id(expected_amount_cents)',
            )
            .gte('date', cf)
            .lte('date', ct)
            .order('date', { ascending: false })
            .limit(2000),
          supabase
            .from('envelope_moves')
            .select(
              'id,created_at,amount_cents,reason,from_envelope:from_envelope_id(name),to_envelope:to_envelope_id(name)',
            )
            .gte('created_at', moveTsB.gte)
            .lt('created_at', moveTsB.lt)
            .order('created_at', { ascending: false })
            .limit(5000),
          supabase
            .from('paycheck_allocations')
            .select('envelope_id,amount_cents,allocation_month,envelope:envelope_id(name)')
            .gte('allocation_month', allocFromB)
            .lte('allocation_month', allocToB)
            .limit(20_000),
        ])
        if (btxResp.error) throw btxResp.error
        if (bpcResp.error) throw bpcResp.error
        if (bmvResp.error) throw bmvResp.error
        if (balResp.error) throw balResp.error
        setCmpTransactions((btxResp.data ?? []) as TxRow[])
        setCmpPaychecks((bpcResp.data ?? []) as PaycheckRow[])
        setCmpMoves((bmvResp.data ?? []) as EnvelopeMoveDetail[])
        setCmpAllocations((balResp.data ?? []) as AllocationRow[])
      } else {
        setCmpTransactions([])
        setCmpPaychecks([])
        setCmpMoves([])
        setCmpAllocations([])
      }
    } catch (err) {
      setCmpTransactions([])
      setCmpPaychecks([])
      setCmpMoves([])
      setCmpAllocations([])
      const msg = err instanceof Error ? err.message : 'Could not load reports.'
      if (msg.includes('minimum_payment') || msg.includes('planned_monthly')) {
        setError(`${msg} Apply the latest Supabase migration for debt columns if needed.`)
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [fromDate, toDate, debtAvgWindowMonths, compareEnabled, preset])

  useEffect(() => {
    void loadReports()
  }, [loadReports])

  const daysInRange = useMemo(() => {
    try {
      const a = parseCalendarDateLocal(fromDate)
      const b = parseCalendarDateLocal(toDate)
      return Math.max(1, differenceInCalendarDays(b, a) + 1)
    } catch {
      return 1
    }
  }, [fromDate, toDate])

  const compareBlocked = useMemo(() => {
    try {
      const primaryLen = differenceInCalendarDays(parseCalendarDateLocal(toDate), parseCalendarDateLocal(fromDate)) + 1
      return preset === 'all_time' || primaryLen > 366
    } catch {
      return true
    }
  }, [preset, fromDate, toDate])

  const kpis = useMemo(
    () => buildKpis(transactions, paychecks, envelopeMovesDetail, allocations),
    [transactions, paychecks, envelopeMovesDetail, allocations],
  )

  const kpisCompare = useMemo(() => {
    if (!compareEnabled) return null
    return buildKpis(cmpTransactions, cmpPaychecks, cmpMoves, cmpAllocations)
  }, [compareEnabled, cmpTransactions, cmpPaychecks, cmpMoves, cmpAllocations])

  const compareRangeLabel = useMemo(() => {
    if (!compareEnabled || compareBlocked) return null
    const r = computePreviousPeriod(fromDate, toDate)
    return r ? `${r.from} → ${r.to}` : null
  }, [compareEnabled, compareBlocked, fromDate, toDate])

  const byEnvelope = useMemo(() => {
    const m = new Map<string, { name: string; spent: number; inflow: number; count: number }>()
    for (const tx of transactions) {
      if (!tx.envelope_id) continue
      const name = joinName(tx.envelope, 'Envelope')
      const cur = m.get(tx.envelope_id) ?? { name, spent: 0, inflow: 0, count: 0 }
      cur.spent += outflowCents(tx.amount_cents)
      cur.inflow += inflowCents(tx.amount_cents)
      cur.count += 1
      m.set(tx.envelope_id, cur)
    }
    return [...m.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.spent - a.spent)
  }, [transactions])

  const byEnvelopeGroup = useMemo(() => {
    const m = new Map<string, { key: string; name: string; spent: number; inflow: number; count: number }>()
    for (const row of byEnvelope) {
      const gid = envelopeGroupIdByEnvelopeId[row.id] ?? null
      const key = gid ?? '__ungrouped__'
      const name = gid ? (groupNamesById[gid] ?? 'Envelope group') : 'Ungrouped'
      const cur = m.get(key) ?? { key, name, spent: 0, inflow: 0, count: 0 }
      cur.spent += row.spent
      cur.inflow += row.inflow
      cur.count += row.count
      m.set(key, cur)
    }
    return [...m.values()].sort((a, b) => b.spent - a.spent)
  }, [byEnvelope, envelopeGroupIdByEnvelopeId, groupNamesById])

  const pieSlicesByEnvelope = useMemo(
    () => toPieSlicesTopN(byEnvelope.map((r) => ({ name: r.name, spent: r.spent })), 7),
    [byEnvelope],
  )

  const pieSlicesByGroup = useMemo(
    () => toPieSlicesTopN(byEnvelopeGroup.map((r) => ({ name: r.name, spent: r.spent })), 7),
    [byEnvelopeGroup],
  )

  const byAccount = useMemo(() => {
    const m = new Map<string, { name: string; net: number; count: number }>()
    for (const tx of transactions) {
      if (!tx.account_id) continue
      const name = joinName(tx.account, 'Account')
      const cur = m.get(tx.account_id) ?? { name, net: 0, count: 0 }
      cur.net += tx.amount_cents
      cur.count += 1
      m.set(tx.account_id, cur)
    }
    return [...m.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
  }, [transactions])

  const byPayee = useMemo(() => {
    const m = new Map<string, { out: number; count: number }>()
    for (const tx of transactions) {
      const key = tx.payee.trim() || '(blank payee)'
      const cur = m.get(key) ?? { out: 0, count: 0 }
      cur.out += outflowCents(tx.amount_cents)
      cur.count += 1
      m.set(key, cur)
    }
    return [...m.entries()]
      .map(([payee, v]) => ({ payee, ...v }))
      .filter((r) => r.out > 0)
      .sort((a, b) => b.out - a.out)
      .slice(0, 25)
  }, [transactions])

  const byMonth = useMemo(() => {
    const m = new Map<string, { out: number; inflow: number }>()
    for (const tx of transactions) {
      const month = tx.date.slice(0, 7)
      const cur = m.get(month) ?? { out: 0, inflow: 0 }
      cur.out += outflowCents(tx.amount_cents)
      cur.inflow += inflowCents(tx.amount_cents)
      m.set(month, cur)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [transactions])

  const fundedByEnvelope = useMemo(() => {
    const m = new Map<string, { name: string; cents: number }>()
    for (const row of allocations) {
      const name = joinName(row.envelope, 'Envelope')
      const cur = m.get(row.envelope_id) ?? { name, cents: 0 }
      cur.cents += row.amount_cents
      m.set(row.envelope_id, cur)
    }
    return [...m.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.cents - a.cents)
  }, [allocations])

  const calendarMonthsTouched = useMemo(() => {
    try {
      return eachMonthOfInterval({
        start: parseCalendarDateLocal(fromDate),
        end: parseCalendarDateLocal(toDate),
      }).length
    } catch {
      return 1
    }
  }, [fromDate, toDate])

  const accountTransferTransactions = useMemo(
    () => transactions.filter((t) => t.transaction_kind === 'transfer'),
    [transactions],
  )

  const { pairs: accountTransferPairs, unpaired: accountTransferUnpaired } = useMemo(
    () => pairInternalAccountTransfers(accountTransferTransactions),
    [accountTransferTransactions],
  )

  const debtReportRows = useMemo(() => {
    return liabilities.map((L) => {
      const avg = avgDebtPaymentByAccount[L.id] ?? 0
      const minC = L.minimum_payment_cents ?? 0
      const plannedC = L.planned_monthly_payment_cents
      const modeled = modelMonthlyPaymentCents({
        minimumCents: minC,
        plannedCents: plannedC ?? null,
        avgPaymentCents: avg,
      })
      const sim = simulateDebtPayoff({
        balanceCents: L.balance_cents,
        aprBps: L.apr_bps,
        monthlyPaymentCents: modeled,
      })
      let payoffLabel = '—'
      let notes = ''
      if (sim.neverReason) {
        notes = sim.neverReason
      } else if (sim.months === 0) {
        payoffLabel = 'No balance'
      } else if (sim.months != null && sim.months > 0) {
        payoffLabel = format(addMonths(new Date(), sim.months), 'MMMM yyyy')
        notes = `${sim.months} mo · est. interest ${formatCurrencyFromCents(sim.totalInterestCents)}`
      }
      const aprLabel = L.apr_bps != null ? `${(L.apr_bps / 10000).toFixed(2)}%` : '—'
      return {
        id: L.id,
        name: L.name,
        balance_cents: L.balance_cents,
        aprLabel,
        minCents: L.minimum_payment_cents,
        plannedCents: L.planned_monthly_payment_cents,
        avgPaymentCents: avg,
        modeledPaymentCents: modeled,
        payoffLabel,
        notes,
      }
    })
  }, [liabilities, avgDebtPaymentByAccount])

  function exportEnvelopeSpendingCsv() {
    const lines: string[][] = [['Envelope', 'Outflow (cents)', 'Inflow credits (cents)', 'Txn count']]
    for (const row of byEnvelope) {
      lines.push([row.name, String(row.spent), String(row.inflow), String(row.count)])
    }
    downloadCsv(`reports-by-envelope-${fromDate}_${toDate}.csv`, lines)
  }

  function exportEnvelopeGroupsCsv() {
    const lines: string[][] = [['Envelope group', 'Outflow (cents)', 'Inflow credits (cents)', 'Txn count']]
    for (const row of byEnvelopeGroup) {
      lines.push([row.name, String(row.spent), String(row.inflow), String(row.count)])
    }
    downloadCsv(`reports-by-envelope-group-${fromDate}_${toDate}.csv`, lines)
  }

  function exportMonthlyCsv() {
    const lines: string[][] = [['Month', 'Outflow (cents)', 'Credits (cents)']]
    for (const [month, v] of byMonth) {
      lines.push([month, String(v.out), String(v.inflow)])
    }
    downloadCsv(`reports-by-month-${fromDate}_${toDate}.csv`, lines)
  }

  function exportPayeesCsv() {
    const lines: string[][] = [['Payee', 'Outflow (cents)', 'Txn count']]
    for (const row of byPayee) {
      lines.push([row.payee, String(row.out), String(row.count)])
    }
    downloadCsv(`reports-top-payees-${fromDate}_${toDate}.csv`, lines)
  }

  function handleDownloadPdf() {
    const summaryLines = [
      { label: 'Paychecks (net in range)', value: formatCurrencyFromCents(kpis.paycheckTotal) },
      {
        label: 'Extra above expected (linked paychecks)',
        value: formatCurrencyFromCents(kpis.paycheckExtraOverExpectedCents),
      },
      { label: 'Envelope outflows', value: `-${formatCurrencyFromCents(kpis.outEnvelope)}` },
      { label: 'Credits to envelopes', value: `+${formatCurrencyFromCents(kpis.inEnvelope)}` },
      { label: 'Net (paychecks - out + credits)', value: formatCurrencyFromCents(kpis.netAfterPaychecks) },
      { label: 'Paycheck allocations (budget months in range)', value: formatCurrencyFromCents(kpis.funded) },
      { label: 'Debt/card payments (out)', value: `-${formatCurrencyFromCents(kpis.paymentTotal)}` },
      { label: 'Envelope move volume', value: formatCurrencyFromCents(kpis.moveVolume) },
      { label: 'Transactions in range', value: String(kpis.txCount) },
    ]

    const payAllocRows = paycheckLinkedAllocations.map((row) => {
      const pc = paycheckMeta(row)
      return [
        pc.date,
        pdfCell(pc.source, 30),
        formatCurrencyFromCents(pc.net_amount_cents),
        pdfCell(joinName(row.envelope, 'Envelope'), 26),
        formatCurrencyFromCents(row.amount_cents),
        row.allocation_month.slice(0, 7),
      ]
    })

    const moveRows = envelopeMovesDetail.map((m) => [
      format(new Date(m.created_at), 'yyyy-MM-dd HH:mm'),
      pdfCell(joinName(m.from_envelope, 'From'), 22),
      pdfCell(joinName(m.to_envelope, 'To'), 22),
      formatCurrencyFromCents(m.amount_cents),
      pdfCell(m.reason ?? '', 28),
    ])

    const xferRows: string[][] = [
      ...accountTransferPairs.map((row) => [
        row.date,
        pdfCell(`${row.fromAccount} -> ${row.toAccount}`, 44),
        formatCurrencyFromCents(row.amount_cents),
        pdfCell(row.note ?? '', 36),
      ]),
      ...accountTransferUnpaired.map((t) => [
        t.date,
        pdfCell(`${joinName(t.account, 'Account')}: ${t.payee}`, 44),
        formatCurrencyFromCents(t.amount_cents),
        pdfCell(t.note ?? '', 36),
      ]),
    ]

    const spendRows = byEnvelope.map((r) => {
      const pct =
        kpis.outEnvelope > 0 ? `${Math.round((r.spent / kpis.outEnvelope) * 100)}%` : r.spent > 0 ? '100%' : '0%'
      return [r.name, formatCurrencyFromCents(r.spent), formatCurrencyFromCents(r.inflow), pct]
    })

    const debtRows = debtReportRows.map((d) => [
      d.name.trim() || '—',
      formatCurrencyFromCents(d.balance_cents),
      d.aprLabel,
      d.minCents != null ? formatCurrencyFromCents(d.minCents) : '—',
      d.plannedCents != null ? formatCurrencyFromCents(d.plannedCents) : '—',
      formatCurrencyFromCents(d.avgPaymentCents),
      formatCurrencyFromCents(d.modeledPaymentCents),
      d.payoffLabel,
      d.notes.trim() || '—',
    ])

    const trendRows = byMonth.map(([m, v]) => [m, formatCurrencyFromCents(v.out), formatCurrencyFromCents(v.inflow)])

    const pcRows = paychecks.map((p) => [p.date, pdfCell(p.source, 36), formatCurrencyFromCents(p.net_amount_cents)])

    downloadReportsPdf({
      meta: {
        title: 'Financial report',
        from: fromDate,
        to: toDate,
        generatedAt: format(new Date(), 'MMM d, yyyy h:mm a'),
        debtAvgMonths: debtAvgWindowMonths,
      },
      summaryLines,
      paycheckAllocations: payAllocRows,
      envelopeMoves: moveRows,
      accountTransfers: xferRows,
      spendingByEnvelope: spendRows,
      debtBreakdown: debtRows,
      monthlyTrend: trendRows,
      paychecksSummary: pcRows,
    })
  }

  return (
    <div className="min-w-0 space-y-6 sm:space-y-7 xl:space-y-8 print:space-y-4">
      <section className="card-surface min-w-0 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="section-title">Reports</h1>
            <p className="section-subtitle max-w-2xl">
              Cross-cutting views over any period. Data comes from{' '}
              <Link to="/transactions" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
                Transactions
              </Link>
              ,{' '}
              <Link to="/journal" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
                Paychecks
              </Link>
              , allocations, and envelope moves. Month-boundary paycheck allocations use each allocation’s budget month.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="whitespace-nowrap">Debt avg window</span>
              <select
                value={debtAvgWindowMonths}
                onChange={(e) => setDebtAvgWindowMonths(Number(e.target.value) as 3 | 6 | 12)}
                className="min-h-10 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value={3}>3 mo</option>
                <option value={6}>6 mo</option>
                <option value={12}>12 mo</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void loadReports()}
              disabled={loading}
              className="btn-secondary px-3 text-xs"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => handleDownloadPdf()}
              className="btn-primary px-3 text-xs"
            >
              Download PDF
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="btn-secondary px-3 text-xs"
            >
              Print
            </button>
          </div>
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">{error}</p>
        )}

        <div className="mt-4 flex flex-wrap gap-2 print:hidden">
          {PRESETS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => applyPresetAndDates(value)}
              className={[
                'min-h-10 shrink-0 rounded-lg border px-3 text-xs font-medium transition-colors',
                preset === value
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2 print:hidden">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">From</span>
            <DatePickerInput
              value={fromDate}
              onChange={(value) => {
                setPreset('custom')
                setFromDate(value)
              }}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              aria-label="report from date"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">To</span>
            <DatePickerInput
              value={toDate}
              onChange={(value) => {
                setPreset('custom')
                setToDate(value)
              }}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              aria-label="report to date"
            />
          </label>
        </div>
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm print:hidden">
          <input
            type="checkbox"
            checked={compareEnabled}
            disabled={compareBlocked}
            onChange={(e) => setCompareEnabled(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-zinc-300 text-emerald-600 disabled:opacity-50"
          />
          <span className="text-zinc-700 dark:text-zinc-300">
            Compare to the <strong>previous period</strong> of the same length
            {compareRangeLabel ? (
              <span className="block text-xs font-normal text-zinc-500 dark:text-zinc-400">Comparison window: {compareRangeLabel}</span>
            ) : null}
          </span>
        </label>
        {compareNotice && (
          <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100 print:hidden">
            {compareNotice}
          </p>
        )}
      </section>

      <CollapsibleCard title="Overview" storageKey="reports-overview">
        {loading && transactions.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : (
          <div className="mt-1 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi label="Paychecks (net in range)" value={formatCurrencyFromCents(kpis.paycheckTotal)} sub={`${paychecks.length} deposits`} />
            <Kpi
              label="Extra above expected"
              value={`+${formatCurrencyFromCents(kpis.paycheckExtraOverExpectedCents)}`}
              sub="Paychecks linked to a saved source: net over that source’s expected amount"
            />
            <Kpi
              label="Envelope outflows"
              value={`-${formatCurrencyFromCents(kpis.outEnvelope)}`}
              sub={`${kpis.txCount} tx · ~${formatCurrencyFromCents(Math.round(kpis.outEnvelope / daysInRange))}/day avg out`}
            />
            <Kpi
              label="Credits to envelopes"
              value={`+${formatCurrencyFromCents(kpis.inEnvelope)}`}
              sub="Negative amounts on transactions"
            />
            <Kpi
              label="Net (paychecks − out + credits)"
              value={formatCurrencyFromCents(kpis.netAfterPaychecks)}
              sub="Rough cash-through-envelopes story"
            />
            <Kpi label="Paycheck allocations (sum)" value={formatCurrencyFromCents(kpis.funded)} sub={`${calendarMonthsTouched} calendar months touched`} />
            <Kpi label="Debt / card payments (out)" value={`-${formatCurrencyFromCents(kpis.paymentTotal)}`} sub="transaction_kind = payment" />
            <Kpi label="Envelope moves (volume)" value={formatCurrencyFromCents(kpis.moveVolume)} sub={`${kpis.moveCount} moves`} />
          </div>
        )}
      </CollapsibleCard>

      {compareEnabled && !compareBlocked && kpisCompare && compareRangeLabel && (
        <CollapsibleCard title="Period comparison" storageKey="reports-compare" defaultCollapsed={false}>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Primary range <strong>{fromDate}</strong> → <strong>{toDate}</strong> vs comparison <strong>{compareRangeLabel}</strong>.
          </p>
          <div className="table-frame">
            <table className="min-w-[760px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-semibold uppercase tracking-wide text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  <th className="p-2.5 align-top">Metric</th>
                  <th className="w-[22%] p-2.5 align-top">Primary</th>
                  <th className="w-[22%] p-2.5 align-top">Compare</th>
                  <th className="w-[18%] p-2.5 align-top">Δ</th>
                  <th className="w-[14%] p-2.5 align-top">% vs prior</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Paychecks (net)', 'paycheckTotal', true],
                    ['Extra above expected (paychecks)', 'paycheckExtraOverExpectedCents', true],
                    ['Envelope outflows', 'outEnvelope', true],
                    ['Credits to envelopes', 'inEnvelope', true],
                    ['Net (paychecks − out + credits)', 'netAfterPaychecks', true],
                    ['Paycheck allocations (sum)', 'funded', true],
                    ['Debt / card payments (out)', 'paymentTotal', true],
                    ['Envelope move volume', 'moveVolume', true],
                    ['Envelope moves (count)', 'moveCount', false],
                    ['Transactions (count)', 'txCount', false],
                  ] as const satisfies ReadonlyArray<readonly [string, keyof KpiPack, boolean]>
                ).map(([label, key, isMoney]) => {
                  const cur = kpis[key]
                  const prev = kpisCompare[key]
                  const delta = cur - prev
                  const deltaLabel = isMoney ? formatCurrencyFromCents(Math.abs(delta)) : String(Math.abs(delta))
                  const deltaSign = delta > 0 ? '+' : delta < 0 ? '−' : ''
                  const primaryLabel = isMoney ? formatCurrencyFromCents(cur) : String(cur)
                  const compareLabel = isMoney ? formatCurrencyFromCents(prev) : String(prev)
                  return (
                    <tr key={key} className="border-b border-zinc-100 dark:border-zinc-800/80">
                      <td className="p-2.5 align-top font-medium">{label}</td>
                      <td className="p-2.5 align-top whitespace-nowrap">{primaryLabel}</td>
                      <td className="p-2.5 align-top whitespace-nowrap">{compareLabel}</td>
                      <td className="p-2.5 align-top whitespace-nowrap">
                        {delta === 0 ? '—' : `${deltaSign}${deltaLabel}`}
                      </td>
                      <td className="p-2.5 align-top whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                        {pctChange(cur, prev)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CollapsibleCard>
      )}

      <CollapsibleCard title="Spending mix" storageKey="reports-pies" defaultCollapsed>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Share of envelope-linked <strong>outflows</strong> (top categories plus Other). Use with monthly or bounded ranges for the clearest story.
        </p>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          <SpendingPieChart title="By envelope" slices={pieSlicesByEnvelope} />
          <SpendingPieChart title="By envelope group" slices={pieSlicesByGroup} />
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="By envelope group" storageKey="reports-by-group" defaultCollapsed>
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Roll-up of the envelope spending table using your group assignments.</p>
          <button type="button" onClick={() => exportEnvelopeGroupsCsv()} className="btn-secondary min-h-9 px-3 text-xs">
            Download CSV
          </button>
        </div>
        {byEnvelopeGroup.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No envelope-tagged spending in this range.</p>
        ) : (
          <div className="table-frame">
            <table className="min-w-[640px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-gradient-to-r from-emerald-50 to-white text-left text-xs font-semibold uppercase tracking-wide text-emerald-900 dark:border-zinc-800 dark:from-emerald-950/50 dark:to-zinc-950 dark:text-emerald-200">
                  <th className="w-[34%] p-2.5 align-top">Group</th>
                  <th className="w-[22%] p-2.5 align-top">Outflow</th>
                  <th className="w-[22%] p-2.5 align-top">Credits</th>
                  <th className="w-[22%] p-2.5 align-top">Txn count</th>
                </tr>
              </thead>
              <tbody>
                {byEnvelopeGroup.map((row) => (
                  <tr key={row.key} className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="p-2.5 align-top font-medium break-words">{row.name}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(row.spent)}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(row.inflow)}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Paycheck allocations (detail)" storageKey="reports-paycheck-alloc-detail" defaultCollapsed>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Every line shows which <strong>paycheck dated in your range</strong> funded which <strong>envelope</strong>, how
          much, and which <strong>budget month</strong> the allocation applies to.
        </p>
        {paycheckLinkedAllocations.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No paychecks in range, or no allocations on those paychecks.</p>
        ) : (
          <div className="mt-3 min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-[860px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-gradient-to-r from-emerald-50 to-white text-left text-xs font-semibold uppercase tracking-wide text-emerald-900 dark:border-zinc-800 dark:from-emerald-950/50 dark:to-zinc-950 dark:text-emerald-200">
                  <th className="w-[11%] p-2.5 align-top">Paycheck date</th>
                  <th className="w-[24%] p-2.5 align-top">Source</th>
                  <th className="w-[15%] p-2.5 align-top">Paycheck net</th>
                  <th className="w-[26%] p-2.5 align-top">Envelope</th>
                  <th className="w-[14%] p-2.5 align-top">Assigned</th>
                  <th className="w-[10%] p-2.5 align-top">Budget month</th>
                </tr>
              </thead>
              <tbody>
                {paycheckLinkedAllocations.map((row) => {
                  const pc = paycheckMeta(row)
                  return (
                    <tr key={`${row.paycheck_id}-${row.envelope_id}-${row.allocation_month}`} className="border-b border-zinc-100 dark:border-zinc-800/80">
                      <td className="p-2.5 align-top whitespace-nowrap">{pc.date}</td>
                      <td className="min-w-0 p-2.5 align-top break-words">{pc.source}</td>
                      <td className="p-2.5 align-top font-medium whitespace-nowrap text-emerald-700 dark:text-emerald-300">
                        +{formatCurrencyFromCents(pc.net_amount_cents)}
                      </td>
                      <td className="min-w-0 p-2.5 align-top font-medium break-words">{joinName(row.envelope, 'Envelope')}</td>
                      <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(row.amount_cents)}</td>
                      <td className="p-2.5 align-top whitespace-nowrap text-zinc-600 dark:text-zinc-400">{row.allocation_month.slice(0, 7)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Envelope moves" storageKey="reports-envelope-moves" defaultCollapsed>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Cash reassigned between categories (same as Envelopes → Move money). Does not touch bank accounts.
        </p>
        {envelopeMovesDetail.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No envelope moves in this range.</p>
        ) : (
          <div className="mt-3 min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-[760px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-gradient-to-r from-sky-50 to-white text-left text-xs font-semibold uppercase tracking-wide text-sky-900 dark:border-zinc-800 dark:from-sky-950/40 dark:to-zinc-950 dark:text-sky-200">
                  <th className="w-[18%] p-2.5 align-top">When</th>
                  <th className="w-[24%] p-2.5 align-top">From</th>
                  <th className="w-[24%] p-2.5 align-top">To</th>
                  <th className="w-[14%] p-2.5 align-top">Amount</th>
                  <th className="w-[20%] p-2.5 align-top">Reason</th>
                </tr>
              </thead>
              <tbody>
                {envelopeMovesDetail.map((m) => (
                  <tr key={m.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="p-2.5 align-top text-xs whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                      {format(new Date(m.created_at), 'MMM d, yyyy HH:mm')}
                    </td>
                    <td className="min-w-0 p-2.5 align-top font-medium break-words">{joinName(m.from_envelope, 'From')}</td>
                    <td className="min-w-0 p-2.5 align-top font-medium break-words">{joinName(m.to_envelope, 'To')}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(m.amount_cents)}</td>
                    <td className="min-w-0 p-2.5 align-top text-xs break-words text-zinc-600 dark:text-zinc-400">{m.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Account transfers" storageKey="reports-account-xfers" defaultCollapsed>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Internal moves between asset accounts use <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">transaction_kind = transfer</code>
          . Each logical transfer is two register lines (out on the source, in on the destination); matched pairs are shown as one row.
        </p>
        {accountTransferTransactions.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No account transfers dated in this range.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {accountTransferPairs.length > 0 && (
              <div className="min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="min-w-[760px] w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 bg-gradient-to-r from-violet-50 to-white text-left text-xs font-semibold uppercase tracking-wide text-violet-900 dark:border-zinc-800 dark:from-violet-950/40 dark:to-zinc-950 dark:text-violet-200">
                      <th className="w-[12%] p-2.5 align-top">Date</th>
                      <th className="w-[38%] p-2.5 align-top">From → to</th>
                      <th className="w-[18%] p-2.5 align-top">Amount</th>
                      <th className="w-[32%] p-2.5 align-top">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountTransferPairs.map((row) => (
                      <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                        <td className="p-2.5 align-top whitespace-nowrap">{row.date}</td>
                        <td className="min-w-0 p-2.5 align-top font-medium break-words">
                          {row.fromAccount} <span className="text-zinc-400">→</span> {row.toAccount}
                        </td>
                        <td className="p-2.5 align-top font-medium whitespace-nowrap">{formatCurrencyFromCents(row.amount_cents)}</td>
                        <td className="min-w-0 p-2.5 align-top text-xs break-words text-zinc-600 dark:text-zinc-400">{row.note ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {accountTransferUnpaired.length > 0 && (
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {accountTransferPairs.length > 0 ? 'Additional transfer lines (not paired)' : 'Transfer register lines'}
                </p>
                <div className="mt-2 min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <table className="min-w-[760px] w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 bg-gradient-to-r from-violet-50 to-white text-left text-xs font-semibold uppercase tracking-wide text-violet-900 dark:border-zinc-800 dark:from-violet-950/40 dark:to-zinc-950 dark:text-violet-200">
                        <th className="w-[11%] p-2.5 align-top">Date</th>
                        <th className="w-[18%] p-2.5 align-top">Account</th>
                        <th className="w-[35%] p-2.5 align-top">Payee</th>
                        <th className="w-[14%] p-2.5 align-top">Amount</th>
                        <th className="w-[22%] p-2.5 align-top">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accountTransferUnpaired.map((t) => (
                        <tr key={t.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                          <td className="p-2.5 align-top whitespace-nowrap">{t.date}</td>
                          <td className="min-w-0 p-2.5 align-top font-medium break-words">{joinName(t.account, 'Account')}</td>
                          <td className="min-w-0 p-2.5 align-top break-words">{t.payee}</td>
                          <td className="p-2.5 align-top font-medium whitespace-nowrap">{formatCurrencyFromCents(t.amount_cents)}</td>
                          <td className="min-w-0 p-2.5 align-top text-xs break-words text-zinc-600 dark:text-zinc-400">{t.note ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Debt & cards — paydown & payoff outlook" storageKey="reports-debt" defaultCollapsed>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Projected payoff uses <strong>max(minimum, planned, average payment)</strong> where the average is from posted{' '}
          <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">payment</code> lines over the window you
          pick above. Same monthly interest simplification as the{' '}
          <Link to="/debt" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
            Debt tracker
          </Link>
          . Payoff math uses the absolute balance, so you do not need to type a leading minus for projections—match how
          you already track the account (bank-style negative vs positive is fine).
        </p>
        {debtReportRows.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No credit card or loan accounts.</p>
        ) : (
          <div className="mt-3 min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-[980px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-gradient-to-r from-amber-50 to-white text-left text-xs font-semibold uppercase tracking-wide text-amber-950 dark:border-zinc-800 dark:from-amber-950/40 dark:to-zinc-950 dark:text-amber-100">
                  <th className="w-[16%] p-2.5 align-top">Account</th>
                  <th className="w-[10%] p-2.5 align-top">Balance</th>
                  <th className="w-[8%] p-2.5 align-top">APR</th>
                  <th className="w-[10%] p-2.5 align-top">Min / mo</th>
                  <th className="w-[10%] p-2.5 align-top">Planned</th>
                  <th className="w-[10%] p-2.5 align-top">Avg pay</th>
                  <th className="w-[12%] p-2.5 align-top">Modeled pay</th>
                  <th className="w-[12%] p-2.5 align-top">Est. payoff</th>
                  <th className="w-[12%] p-2.5 align-top">Notes</th>
                </tr>
              </thead>
              <tbody>
                {debtReportRows.map((d) => (
                  <tr key={d.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="min-w-0 p-2.5 align-top font-medium break-words">{d.name}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(d.balance_cents)}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{d.aprLabel}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{d.minCents != null ? formatCurrencyFromCents(d.minCents) : '—'}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{d.plannedCents != null ? formatCurrencyFromCents(d.plannedCents) : '—'}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(d.avgPaymentCents)}</td>
                    <td className="p-2.5 align-top font-semibold whitespace-nowrap text-emerald-800 dark:text-emerald-200">
                      {formatCurrencyFromCents(d.modeledPaymentCents)}
                    </td>
                    <td className="min-w-0 p-2.5 align-top font-medium break-words text-zinc-900 dark:text-zinc-50">{d.payoffLabel}</td>
                    <td className="min-w-0 p-2.5 align-top text-xs break-words text-zinc-600 dark:text-zinc-400">{d.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard
        title="Spending by envelope"
        storageKey="reports-by-envelope"
        actions={
          <button
            type="button"
            onClick={exportEnvelopeSpendingCsv}
            disabled={byEnvelope.length === 0}
            className="min-h-9 rounded-lg border border-zinc-300 px-2 text-xs font-medium print:hidden dark:border-zinc-700"
          >
            CSV
          </button>
        }
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Sums positive transaction amounts per envelope (typical spending). Credits (returns) shown separately.
        </p>
        {byEnvelope.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No envelope-tied transactions in this range.</p>
        ) : (
          <div className="mt-3 min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-[680px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
                  <th className="w-[36%] p-2.5 align-top">Envelope</th>
                  <th className="w-[20%] p-2.5 align-top">Out</th>
                  <th className="w-[20%] p-2.5 align-top">Credits</th>
                  <th className="w-[12%] p-2.5 align-top">Txns</th>
                  <th className="w-[12%] p-2.5 align-top">% of out</th>
                </tr>
              </thead>
              <tbody>
                {byEnvelope.map((row) => {
                  const pct =
                    kpis.outEnvelope > 0 ? Math.round((row.spent / kpis.outEnvelope) * 100) : row.spent > 0 ? 100 : 0
                  return (
                    <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                      <td className="min-w-0 p-2.5 align-top font-medium break-words">{row.name}</td>
                      <td className="p-2.5 align-top whitespace-nowrap text-red-700 dark:text-red-300">-{formatCurrencyFromCents(row.spent)}</td>
                      <td className="p-2.5 align-top whitespace-nowrap text-emerald-700 dark:text-emerald-300">+{formatCurrencyFromCents(row.inflow)}</td>
                      <td className="p-2.5 align-top whitespace-nowrap text-zinc-600 dark:text-zinc-400">{row.count}</td>
                      <td className="p-2.5 align-top whitespace-nowrap">{pct}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Funded from paychecks (by envelope)" storageKey="reports-funded">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Sum of paycheck allocation lines whose <strong>budget month</strong> falls in this range (not necessarily the
          same as transaction posting dates).
        </p>
        {fundedByEnvelope.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No allocations in range.</p>
        ) : (
          <div className="mt-3 min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-[520px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
                  <th className="w-[70%] p-2.5 align-top">Envelope</th>
                  <th className="w-[30%] p-2.5 align-top">Allocated</th>
                </tr>
              </thead>
              <tbody>
                {fundedByEnvelope.slice(0, 40).map((row) => (
                  <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="min-w-0 p-2.5 align-top font-medium break-words">{row.name}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(row.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fundedByEnvelope.length > 40 && (
              <p className="p-2 text-xs text-zinc-500 dark:text-zinc-400">Showing top 40 by amount. Export from raw data if needed.</p>
            )}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Cash register activity by account" storageKey="reports-by-account">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Net sum of signed transaction amounts posted to each account (includes transfers and payments).</p>
        {byAccount.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No account-linked transactions in range.</p>
        ) : (
          <div className="mt-3 min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-[520px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
                  <th className="w-[45%] p-2.5 align-top">Account</th>
                  <th className="w-[35%] p-2.5 align-top">Net (signed)</th>
                  <th className="w-[20%] p-2.5 align-top">Txns</th>
                </tr>
              </thead>
              <tbody>
                {byAccount.map((row) => (
                  <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="min-w-0 p-2.5 align-top font-medium break-words">{row.name}</td>
                    <td className="p-2.5 align-top whitespace-nowrap">{formatCurrencyFromCents(row.net)}</td>
                    <td className="p-2.5 align-top whitespace-nowrap text-zinc-600 dark:text-zinc-400">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="By transaction kind" storageKey="reports-by-kind">
        {kpis.byKind.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No transactions.</p>
        ) : (
          <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {kpis.byKind.map(([kind, cents]) => (
              <li key={kind} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                <span className="font-medium capitalize">{kind.replace('_', ' ')}</span>
                <span className="ml-2 text-zinc-700 dark:text-zinc-300">{formatCurrencyFromCents(cents)}</span>
                <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">(signed sum)</span>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleCard>

      <CollapsibleCard
        title="Top payees (by outflow)"
        storageKey="reports-payees"
        actions={
          <button
            type="button"
            onClick={exportPayeesCsv}
            disabled={byPayee.length === 0}
            className="min-h-9 rounded-lg border border-zinc-300 px-2 text-xs font-medium print:hidden dark:border-zinc-700"
          >
            CSV
          </button>
        }
      >
        {byPayee.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No outflows in range.</p>
        ) : (
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm">
            {byPayee.map((row) => (
              <li key={row.payee} className="text-zinc-800 dark:text-zinc-200">
                <span className="font-medium">{row.payee}</span>
                <span className="text-zinc-600 dark:text-zinc-400"> — </span>
                <span className="text-red-700 dark:text-red-300">-{formatCurrencyFromCents(row.out)}</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400"> ({row.count} tx)</span>
              </li>
            ))}
          </ol>
        )}
      </CollapsibleCard>

      <CollapsibleCard
        title="Monthly trend (calendar month)"
        storageKey="reports-by-month"
        actions={
          <button
            type="button"
            onClick={exportMonthlyCsv}
            disabled={byMonth.length === 0}
            className="min-h-9 rounded-lg border border-zinc-300 px-2 text-xs font-medium print:hidden dark:border-zinc-700"
          >
            CSV
          </button>
        }
      >
        {byMonth.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No transactions in range.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {byMonth.map(([month, v]) => {
              const maxOut = Math.max(...byMonth.map(([, x]) => x.out), 1)
              const w = Math.round((v.out / maxOut) * 100)
              return (
                <div key={month}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-zinc-800 dark:text-zinc-200">{month}</span>
                    <span className="text-red-700 dark:text-red-300">-{formatCurrencyFromCents(v.out)}</span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                    <div className="h-full rounded-full bg-red-400/80" style={{ width: `${w}%` }} />
                  </div>
                  {v.inflow > 0 && (
                    <p className="mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                      Credits +{formatCurrencyFromCents(v.inflow)}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Paychecks in range" storageKey="reports-paychecks">
        {paychecks.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No paychecks dated in this range.</p>
        ) : (
          <div className="mt-2 min-w-0 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-[520px] w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
                  <th className="w-[18%] p-2.5 align-top">Date</th>
                  <th className="w-[52%] p-2.5 align-top">Source</th>
                  <th className="w-[30%] p-2.5 align-top">Net</th>
                </tr>
              </thead>
              <tbody>
                {paychecks.map((p) => (
                  <tr key={p.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                    <td className="p-2.5 align-top whitespace-nowrap">{p.date}</td>
                    <td className="min-w-0 p-2.5 align-top break-words">{p.source}</td>
                    <td className="p-2.5 align-top font-medium whitespace-nowrap text-emerald-700 dark:text-emerald-300">
                      +{formatCurrencyFromCents(p.net_amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Related" storageKey="reports-related" defaultCollapsed={true}>
        <ul className="list-inside list-disc space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          <li>
            <Link to="/budget" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
              Budget vs Actual
            </Link>{' '}
            — single calendar month, budgeted vs spent per envelope.
          </li>
          <li>
            <Link to="/journal" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
              Paycheck Journal
            </Link>{' '}
            — activity report with moves and paycheck detail lines.
          </li>
        </ul>
      </CollapsibleCard>
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-zinc-200/90 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="break-words text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-zinc-900 dark:text-zinc-50">{value}</p>
      {sub && <p className="mt-0.5 break-words text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</p>}
    </div>
  )
}
