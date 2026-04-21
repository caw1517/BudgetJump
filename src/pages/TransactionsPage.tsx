import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { differenceInCalendarDays, format, parse, startOfMonth, subDays } from 'date-fns'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import {
  dollarsStringToCents,
  formatAccountDropdownLabel,
  formatCurrencyFromCents,
  formatEnvelopeDropdownLabel,
} from '../lib/currency'
import { getSupabase } from '../lib/supabase'

type EnvelopeOption = {
  id: string
  name: string
  archived: boolean
  balance_cents: number
}

type AccountType = 'checking' | 'savings' | 'credit_card' | 'debt' | 'cash' | 'other'

type FinancialAccount = {
  id: string
  name: string
  account_type: AccountType
  archived: boolean
  balance_cents: number
}

type TransactionRow = {
  id: string
  date: string
  payee: string
  amount_cents: number
  envelope_id: string | null
  note: string | null
  cleared: boolean
  import_source: 'manual' | 'chase_csv'
  transaction_kind: 'regular' | 'payment' | 'interest' | 'refund' | 'transfer'
  archived: boolean
  account_id: string | null
  account: { name: string } | null
  envelope: { name: string } | null
}

type ImportStatus = 'new' | 'duplicate' | 'likely_update' | 'credit' | 'invalid'
type ImportAction = 'create' | 'skip' | 'update'

type ImportPreviewRow = {
  rowIndex: number
  rawDate: string
  rawDescription: string
  rawAmount: string
  parsedDate: string | null
  amountCents: number | null
  normalizedPayee: string
  status: ImportStatus
  action: ImportAction
  reason: string
  targetEnvelopeId: string | null
  matchTransactionId: string | null
  likelyMatches: string[]
}

type DatePreset = 'all_time' | 'this_month' | 'last_30' | 'last_90' | 'custom'

type TransactionForm = {
  date: string
  payee: string
  amountDollars: string
  direction: 'outflow' | 'inflow'
  transactionKind: 'regular' | 'payment' | 'interest' | 'refund'
  envelopeId: string
  accountId: string
  note: string
  cleared: boolean
}

type SplitLine = {
  id: string
  envelopeId: string
  amountDollars: string
}

const TODAY = new Date().toISOString().slice(0, 10)

const DEFAULT_FORM: TransactionForm = {
  date: TODAY,
  payee: '',
  amountDollars: '',
  direction: 'outflow',
  transactionKind: 'regular',
  envelopeId: '',
  accountId: '',
  note: '',
  cleared: false,
}

export function TransactionsPage() {
  const [envelopes, setEnvelopes] = useState<EnvelopeOption[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [transactions, setTransactions] = useState<TransactionRow[]>([])
  const [form, setForm] = useState<TransactionForm>(DEFAULT_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filterEnvelopeId, setFilterEnvelopeId] = useState('')
  const [filterCleared, setFilterCleared] = useState<'all' | 'cleared' | 'pending'>('all')
  const [filterFromDate, setFilterFromDate] = useState('')
  const [filterToDate, setFilterToDate] = useState('')
  const [datePreset, setDatePreset] = useState<DatePreset>('all_time')
  const [search, setSearch] = useState('')
  const [importRows, setImportRows] = useState<ImportPreviewRow[]>([])
  const [importFileName, setImportFileName] = useState('')
  const [applyingImport, setApplyingImport] = useState(false)
  const [importAccountId, setImportAccountId] = useState('')
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<string[]>([])
  const [bulkEnvelopeId, setBulkEnvelopeId] = useState('')
  const [splitMode, setSplitMode] = useState(false)
  const [splitLines, setSplitLines] = useState<SplitLine[]>([])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const [envelopesResp, accountsResp, transactionsResp] = await Promise.all([
        supabase.from('envelopes').select('id,name,archived,balance_cents').eq('archived', false).order('name', { ascending: true }),
        supabase
          .from('financial_accounts')
          .select('id,name,account_type,archived,balance_cents')
          .eq('archived', false)
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
        supabase
          .from('transactions')
          .select('id,date,payee,amount_cents,envelope_id,note,cleared,import_source,transaction_kind,archived,account_id,account:account_id(name),envelope:envelope_id(name)')
          .eq('archived', false)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
      ])
      if (envelopesResp.error) throw envelopesResp.error
      if (accountsResp.error) throw accountsResp.error
      if (transactionsResp.error) throw transactionsResp.error

      setEnvelopes(envelopesResp.data ?? [])
      setAccounts(accountsResp.data ?? [])
      setTransactions((transactionsResp.data ?? []) as unknown as TransactionRow[])
      setForm((prev) => ({
        ...prev,
        direction: prev.direction ?? 'outflow',
        transactionKind: prev.transactionKind ?? 'regular',
        envelopeId: prev.envelopeId || envelopesResp.data?.[0]?.id || '',
        accountId: prev.accountId || accountsResp.data?.[0]?.id || '',
      }))
      setImportAccountId((prev) => prev || accountsResp.data?.[0]?.id || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transactions.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const filteredTransactions = useMemo(() => {
    return transactions.filter((transaction) => {
      if (filterEnvelopeId && transaction.envelope_id !== filterEnvelopeId) return false
      if (filterCleared === 'cleared' && !transaction.cleared) return false
      if (filterCleared === 'pending' && transaction.cleared) return false
      if (filterFromDate && transaction.date < filterFromDate) return false
      if (filterToDate && transaction.date > filterToDate) return false
      if (search.trim()) {
        const target = `${transaction.payee} ${transaction.note ?? ''}`.toLowerCase()
        if (!target.includes(search.toLowerCase().trim())) return false
      }
      return true
    })
  }, [transactions, filterEnvelopeId, filterCleared, filterFromDate, filterToDate, search])

  const categorySummary = useMemo(() => {
    const rows = transactions.filter((transaction) => {
      if (filterCleared === 'cleared' && !transaction.cleared) return false
      if (filterCleared === 'pending' && transaction.cleared) return false
      if (filterFromDate && transaction.date < filterFromDate) return false
      if (filterToDate && transaction.date > filterToDate) return false
      if (search.trim()) {
        const target = `${transaction.payee} ${transaction.note ?? ''}`.toLowerCase()
        if (!target.includes(search.toLowerCase().trim())) return false
      }
      return true
    })

    const grouped = new Map<string, { envelopeId: string; name: string; total: number; count: number }>()
    for (const row of rows) {
      const envelopeId = row.envelope_id ?? '__none__'
      const name = row.envelope?.name ?? (row.envelope_id == null ? 'Account only' : 'Unknown envelope')
      const existing = grouped.get(envelopeId)
      if (existing) {
        existing.total += row.amount_cents
        existing.count += 1
      } else {
        grouped.set(envelopeId, { envelopeId, name, total: row.amount_cents, count: 1 })
      }
    }
    return [...grouped.values()].sort((a, b) => b.total - a.total)
  }, [transactions, filterCleared, filterFromDate, filterToDate, search])

  const transactionById = useMemo(
    () => Object.fromEntries(transactions.map((transaction) => [transaction.id, transaction])),
    [transactions],
  )

  const allFilteredSelected =
    filteredTransactions.length > 0 &&
    filteredTransactions.every((transaction) => selectedTransactionIds.includes(transaction.id))

  function resetForm() {
    setForm({
      ...DEFAULT_FORM,
      direction: 'outflow',
      envelopeId: envelopes[0]?.id ?? '',
      accountId: accounts[0]?.id ?? '',
    })
    setEditingId(null)
    setSplitMode(false)
    setSplitLines([])
  }

  function beginEdit(transaction: TransactionRow) {
    setEditingId(transaction.id)
    setForm({
      date: transaction.date,
      payee: transaction.payee,
      amountDollars: (Math.abs(transaction.amount_cents) / 100).toFixed(2),
      direction: transaction.amount_cents < 0 ? 'inflow' : 'outflow',
      transactionKind:
        transaction.transaction_kind === 'payment' ||
        transaction.transaction_kind === 'interest' ||
        transaction.transaction_kind === 'refund'
          ? transaction.transaction_kind
          : 'regular',
      envelopeId: transaction.envelope_id ?? envelopes[0]?.id ?? '',
      accountId: transaction.account_id ?? accounts[0]?.id ?? '',
      note: transaction.note ?? '',
      cleared: transaction.cleared,
    })
    setError(null)
    setNotice(null)
    setSplitMode(false)
    setSplitLines([])
  }

  function addSplitLine() {
    setSplitLines((prev) => [
      ...prev,
      { id: crypto.randomUUID(), envelopeId: envelopes[0]?.id ?? '', amountDollars: '' },
    ])
  }

  async function submitTransaction(event: FormEvent) {
    event.preventDefault()
    const payee = form.payee.trim()
    if (!payee) {
      setError('Payee is required.')
      return
    }
    if (!form.envelopeId) {
      if (!(splitMode && !editingId)) {
        setError('Select an envelope.')
        return
      }
    }
    if (!form.accountId) {
      setError('Select an account. Every transaction is posted to an account register.')
      return
    }

    const amountCents = manualTransactionSignedCents(form.amountDollars, {
      direction: form.direction,
      transactionKind: form.transactionKind,
    })
    if (amountCents == null) {
      setError('Amount must be a valid number greater than 0.')
      return
    }

    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      if (!editingId && splitMode) {
        if (splitLines.length < 2) {
          setError('Add at least two split lines.')
          return
        }
        const directionSign = amountCents < 0 ? -1 : 1
        let splitSum = 0
        for (const line of splitLines) {
          if (!line.envelopeId) {
            setError('Each split line needs an envelope.')
            return
          }
          const part = dollarsStringToCents(line.amountDollars)
          if (part == null || part <= 0) {
            setError('Each split amount must be greater than 0.')
            return
          }
          splitSum += part
        }
        if (splitSum !== Math.abs(amountCents)) {
          setError(
            `Split amounts must equal ${formatCurrencyFromCents(Math.abs(amountCents))}. Currently ${formatCurrencyFromCents(splitSum)}.`,
          )
          return
        }
        for (const line of splitLines) {
          const part = dollarsStringToCents(line.amountDollars)!
          const signedPart = directionSign < 0 ? -part : part
          const { error: createError } = await getSupabase().rpc('create_manual_transaction', {
            p_date: form.date,
            p_payee: payee,
            p_amount_cents: signedPart,
            p_envelope_id: line.envelopeId,
            p_note: form.note.trim() || null,
            p_cleared: form.cleared,
            p_account_id: form.accountId,
            p_transaction_kind: form.transactionKind,
          })
          if (createError) throw createError
        }
        setNotice('Split transaction created.')
        resetForm()
        await loadData()
        return
      }

      if (editingId) {
        const { error: updateError } = await getSupabase().rpc('update_manual_transaction', {
          p_transaction_id: editingId,
          p_date: form.date,
          p_payee: payee,
          p_amount_cents: amountCents,
          p_envelope_id: form.envelopeId,
          p_note: form.note.trim() || null,
          p_cleared: form.cleared,
          p_account_id: form.accountId,
          p_transaction_kind: form.transactionKind,
        })
        if (updateError) throw updateError
        setNotice('Transaction updated.')
      } else {
        const { error: createError } = await getSupabase().rpc('create_manual_transaction', {
          p_date: form.date,
          p_payee: payee,
          p_amount_cents: amountCents,
          p_envelope_id: form.envelopeId,
          p_note: form.note.trim() || null,
          p_cleared: form.cleared,
          p_account_id: form.accountId,
          p_transaction_kind: form.transactionKind,
        })
        if (createError) throw createError
        setNotice('Transaction created.')
      }

      resetForm()
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save transaction.')
    } finally {
      setSaving(false)
    }
  }

  async function archiveTransaction(id: string) {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: archiveError } = await getSupabase().rpc('archive_transaction', { p_transaction_id: id })
      if (archiveError) throw archiveError
      if (editingId === id) resetForm()
      setNotice('Transaction archived.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive transaction.')
    } finally {
      setSaving(false)
    }
  }

  async function bulkAssignEnvelope() {
    if (!bulkEnvelopeId || selectedTransactionIds.length === 0) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      for (const id of selectedTransactionIds) {
        const tx = transactionById[id]
        if (!tx) continue
        const { error: updateError } = await getSupabase().rpc('update_manual_transaction', {
          p_transaction_id: tx.id,
          p_date: tx.date,
          p_payee: tx.payee,
          p_amount_cents: tx.amount_cents,
          p_envelope_id: bulkEnvelopeId,
          p_note: tx.note,
          p_cleared: tx.cleared,
          p_import_source: tx.import_source,
          p_account_id: tx.account_id,
          p_transaction_kind: tx.transaction_kind,
        })
        if (updateError) throw updateError
      }
      setSelectedTransactionIds([])
      setBulkEnvelopeId('')
      await loadData()
      setNotice('Selected transactions were reassigned.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk assign failed.')
    } finally {
      setSaving(false)
    }
  }

  async function clearSelectedTransactions() {
    if (selectedTransactionIds.length === 0) return
    const confirmed = window.confirm(
      `Clear ${selectedTransactionIds.length} selected transaction(s)? This will archive them and restore envelope/account balances.`,
    )
    if (!confirmed) return

    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      for (const id of selectedTransactionIds) {
        const { error: archiveError } = await getSupabase().rpc('archive_transaction', {
          p_transaction_id: id,
        })
        if (archiveError) throw archiveError
      }
      const clearedCount = selectedTransactionIds.length
      setSelectedTransactionIds([])
      await loadData()
      setNotice(`Cleared ${clearedCount} transaction(s).`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear selected transactions.')
    } finally {
      setSaving(false)
    }
  }

  function exportFilteredToCsv() {
    const rows = filteredTransactions.map((transaction) => ({
      Date: transaction.date,
      Payee: transaction.payee,
      Amount: transaction.amount_cents / 100,
      Envelope: transaction.envelope?.name ?? '',
      Account: transaction.account?.name ?? '',
      Cleared: transaction.cleared ? 'Yes' : 'No',
      Source: transaction.import_source,
      Note: transaction.note ?? '',
    }))
    if (rows.length === 0) {
      setNotice('No filtered transactions to export.')
      return
    }
    const headers = Object.keys(rows[0])
    const csv = [
      headers.join(','),
      ...rows.map((row) =>
        headers
          .map((header) => {
            const cell = String((row as Record<string, string | number>)[header] ?? '')
            const escaped = cell.replaceAll('"', '""')
            return `"${escaped}"`
          })
          .join(','),
      ),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `budget-jump-transactions-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`
    link.click()
    URL.revokeObjectURL(url)
    setNotice(`Exported ${rows.length} transactions to CSV.`)
  }

  function applyDatePreset(preset: DatePreset) {
    const today = new Date()
    setDatePreset(preset)
    if (preset === 'all_time') {
      setFilterFromDate('')
      setFilterToDate('')
      return
    }
    if (preset === 'this_month') {
      setFilterFromDate(format(startOfMonth(today), 'yyyy-MM-dd'))
      setFilterToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'last_30') {
      setFilterFromDate(format(subDays(today, 29), 'yyyy-MM-dd'))
      setFilterToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'last_90') {
      setFilterFromDate(format(subDays(today, 89), 'yyyy-MM-dd'))
      setFilterToDate(format(today, 'yyyy-MM-dd'))
      return
    }
  }

  function parseCsvLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]
      if (char === '"') {
        const next = line[i + 1]
        if (inQuotes && next === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current)
        current = ''
      } else {
        current += char
      }
    }
    result.push(current)
    return result.map((cell) => cell.trim())
  }

  function normalizePayee(payee: string): string {
    return payee
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function parseChaseDate(value: string): string | null {
    const parsed = parse(value.trim(), 'M/d/yyyy', new Date())
    if (Number.isNaN(parsed.getTime())) return null
    return format(parsed, 'yyyy-MM-dd')
  }

  function parseCsvAmount(value: string): number | null {
    const normalized = value.replaceAll('$', '').replaceAll(',', '').trim()
    if (!normalized) return null
    const parsed = Number(normalized)
    if (Number.isNaN(parsed)) return null
    return Math.round(parsed * 100)
  }

  function classifyImportRows(
    rows: Array<{ rowIndex: number; date: string; description: string; amount: string }>,
  ): ImportPreviewRow[] {
    const defaultEnvelopeId = envelopes[0]?.id ?? ''
    return rows.map((row) => {
      const parsedDate = parseChaseDate(row.date)
      const amountRaw = parseCsvAmount(row.amount)
      const normalizedPayee = normalizePayee(row.description)

      if (!parsedDate || amountRaw == null || !normalizedPayee) {
        return {
          rowIndex: row.rowIndex,
          rawDate: row.date,
          rawDescription: row.description,
          rawAmount: row.amount,
          parsedDate,
          amountCents: amountRaw == null ? null : Math.abs(amountRaw),
          normalizedPayee,
          status: 'invalid',
          action: 'skip',
          reason: 'Invalid date, description, or amount.',
          targetEnvelopeId: defaultEnvelopeId,
          matchTransactionId: null,
          likelyMatches: [],
        }
      }

      if (amountRaw >= 0) {
        return {
          rowIndex: row.rowIndex,
          rawDate: row.date,
          rawDescription: row.description,
          rawAmount: row.amount,
          parsedDate,
          amountCents: amountRaw,
          normalizedPayee,
          status: 'credit',
          action: 'skip',
          reason: 'Credit/non-debit row skipped in spending import.',
          targetEnvelopeId: defaultEnvelopeId,
          matchTransactionId: null,
          likelyMatches: [],
        }
      }

      const amountCents = Math.abs(amountRaw)
      const exactMatch = transactions.find((transaction) => {
        if (importAccountId && transaction.account_id !== importAccountId) return false
        return (
          transaction.date === parsedDate &&
          transaction.amount_cents === amountCents &&
          normalizePayee(transaction.payee) === normalizedPayee
        )
      })

      if (exactMatch) {
        return {
          rowIndex: row.rowIndex,
          rawDate: row.date,
          rawDescription: row.description,
          rawAmount: row.amount,
          parsedDate,
          amountCents,
          normalizedPayee,
          status: 'duplicate',
          action: 'skip',
          reason: `Exact match with ${exactMatch.payee} (${formatCurrencyFromCents(exactMatch.amount_cents)}).`,
          targetEnvelopeId: exactMatch.envelope_id,
          matchTransactionId: exactMatch.id,
          likelyMatches: [exactMatch.id],
        }
      }

      const likelyMatches = transactions.filter((transaction) => {
        if (importAccountId && transaction.account_id !== importAccountId) return false
        const samePayee = normalizePayee(transaction.payee) === normalizedPayee
        if (!samePayee || transaction.cleared) return false
        const dayDiff = Math.abs(
          differenceInCalendarDays(new Date(parsedDate), new Date(transaction.date)),
        )
        return dayDiff <= 3
      })

      if (likelyMatches.length > 0) {
        const preferred = likelyMatches[0]
        return {
          rowIndex: row.rowIndex,
          rawDate: row.date,
          rawDescription: row.description,
          rawAmount: row.amount,
          parsedDate,
          amountCents,
          normalizedPayee,
          status: 'likely_update',
          action: likelyMatches.length === 1 ? 'update' : 'skip',
          reason:
            likelyMatches.length === 1
              ? `Likely pending->posted update for ${preferred.payee}.`
              : `Multiple likely matches found (${likelyMatches.length}). Choose one or skip.`,
          targetEnvelopeId: preferred.envelope_id,
          matchTransactionId: likelyMatches.length === 1 ? preferred.id : null,
          likelyMatches: likelyMatches.map((candidate) => candidate.id),
        }
      }

      return {
        rowIndex: row.rowIndex,
        rawDate: row.date,
        rawDescription: row.description,
        rawAmount: row.amount,
        parsedDate,
        amountCents,
        normalizedPayee,
        status: 'new',
        action: 'create',
        reason: 'No existing match found.',
        targetEnvelopeId: defaultEnvelopeId,
        matchTransactionId: null,
        likelyMatches: [],
      }
    })
  }

  async function onCsvSelected(file: File) {
    setError(null)
    setNotice(null)
    const text = await file.text()
    const lines = text
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    if (lines.length < 2) {
      setError('CSV appears empty.')
      setImportRows([])
      return
    }

    const header = parseCsvLine(lines[0]).map((column) => column.toLowerCase())
    const dateIndex = header.indexOf('date') >= 0 ? header.indexOf('date') : header.indexOf('posting date')
    const descriptionIndex = header.indexOf('description')
    const amountIndex = header.indexOf('amount')
    if (dateIndex === -1 || descriptionIndex === -1 || amountIndex === -1) {
      setError('CSV must include Posting Date (or Date), Description, and Amount columns.')
      setImportRows([])
      return
    }

    const parsedRows = lines.slice(1).map((line, idx) => {
      const values = parseCsvLine(line)
      return {
        rowIndex: idx + 2,
        date: values[dateIndex] ?? '',
        description: values[descriptionIndex] ?? '',
        amount: values[amountIndex] ?? '',
      }
    })

    const preview = classifyImportRows(parsedRows)
    setImportRows(preview)
    setImportFileName(file.name)
    setNotice(`Parsed ${preview.length} CSV rows. Review actions before apply.`)
  }

  async function applyCsvImport() {
    const actionableRows = importRows.filter((row) => row.action !== 'skip')
    if (actionableRows.length === 0) {
      setNotice('No actionable rows to import.')
      return
    }
    if (!importAccountId) {
      setError('Select the import account. Each imported row is posted to that account.')
      return
    }

    setApplyingImport(true)
    setSaving(true)
    setError(null)
    setNotice(null)
    let created = 0
    let updated = 0
    let skipped = importRows.filter((row) => row.action === 'skip').length

    try {
      for (const row of actionableRows) {
        if (!row.parsedDate || row.amountCents == null) {
          skipped += 1
          continue
        }
        if (row.action === 'create') {
          if (!row.targetEnvelopeId) {
            skipped += 1
            continue
          }
          const { error: createError } = await getSupabase().rpc('create_manual_transaction', {
            p_date: row.parsedDate,
            p_payee: row.rawDescription.trim(),
            p_amount_cents: row.amountCents,
            p_envelope_id: row.targetEnvelopeId,
            p_note: 'Imported from Chase CSV',
            p_cleared: true,
            p_import_source: 'chase_csv',
            p_account_id: importAccountId,
            p_transaction_kind: 'regular',
          })
          if (createError) throw createError
          created += 1
        } else if (row.action === 'update') {
          const matchId = row.matchTransactionId
          if (!matchId) {
            skipped += 1
            continue
          }
          const existing = transactionById[matchId]
          if (!existing) {
            skipped += 1
            continue
          }
          const { error: updateError } = await getSupabase().rpc('update_manual_transaction', {
            p_transaction_id: matchId,
            p_date: row.parsedDate,
            p_payee: row.rawDescription.trim(),
            p_amount_cents: row.amountCents,
            p_envelope_id: existing.envelope_id,
            p_note: existing.note ? `${existing.note} | CSV refresh` : 'Imported from Chase CSV',
            p_cleared: true,
            p_import_source: 'chase_csv',
            p_account_id: existing.account_id ?? importAccountId,
            p_transaction_kind: existing.transaction_kind,
          })
          if (updateError) throw updateError
          updated += 1
        }
      }

      setImportRows([])
      setImportFileName('')
      await loadData()
      setNotice(`CSV import complete: ${created} created, ${updated} updated, ${skipped} skipped.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV import failed.')
    } finally {
      setApplyingImport(false)
      setSaving(false)
    }
  }

  function clearImportPreview() {
    setImportRows([])
    setImportFileName('')
    setNotice(null)
    setError(null)
  }

  return (
    <div className="space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface p-4 sm:p-6">
        <h1 className="section-title">Transactions</h1>
        <p className="section-subtitle">
          Manual spending entry: each row updates the envelope you choose and posts to an account register. Moving money
          between accounts is done from the Accounts page, not here.
        </p>
        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">{error}</p>}
        {notice && <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">{notice}</p>}
      </section>

      <CollapsibleCard title="Chase CSV Import" storageKey="transactions-import">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Chase CSV Import</h2>
          <div className="flex items-center gap-2">
            {importFileName && <span className="text-xs text-zinc-500 dark:text-zinc-400">{importFileName}</span>}
            {(importFileName || importRows.length > 0) && (
              <button
                type="button"
                onClick={clearImportPreview}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-300 bg-white text-sm font-semibold text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                aria-label="Clear import preview"
                title="Clear import preview"
              >
                ×
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Upload Chase CSV and review reconciliation suggestions before applying.
        </p>
        <div className="mt-3">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Import account</label>
          <select
            value={importAccountId}
            onChange={(event) => setImportAccountId(event.target.value)}
            required
            disabled={accounts.length === 0}
            className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 sm:max-w-sm"
          >
            {accounts.length === 0 ? (
              <option value="">Add an account on the Accounts page first</option>
            ) : (
              accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {formatAccountDropdownLabel(account.name, account.balance_cents)}
                </option>
              ))
            )}
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="btn-secondary inline-flex cursor-pointer items-center px-3 text-sm">
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  void onCsvSelected(file)
                }
              }}
            />
            Choose CSV
          </label>
          <button
            type="button"
            onClick={() => void applyCsvImport()}
            disabled={applyingImport || importRows.length === 0 || !importAccountId || accounts.length === 0}
            className="btn-primary px-4 text-sm"
          >
            {applyingImport ? 'Applying...' : 'Apply Import'}
          </button>
        </div>

        {importRows.length > 0 && (
          <div className="mt-4 space-y-2">
            {importRows.map((row, idx) => (
              <div key={`${row.rowIndex}-${idx}`} className="rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {row.rawDescription || '(blank description)'} • {row.rawDate || '-'} • {row.rawAmount || '-'}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {row.status.replace('_', ' ')} — {row.reason}
                    </p>
                  </div>
                  <select
                    value={row.action}
                    onChange={(event) => {
                      const action = event.target.value as ImportAction
                      setImportRows((prev) =>
                        prev.map((candidate, candidateIdx) =>
                          candidateIdx === idx ? { ...candidate, action } : candidate,
                        ),
                      )
                    }}
                    className="min-h-10 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <option value="skip">Skip</option>
                    <option value="create" disabled={row.status === 'duplicate' || row.status === 'credit' || row.status === 'invalid'}>
                      Create
                    </option>
                    <option value="update" disabled={row.likelyMatches.length === 0}>
                      Update existing
                    </option>
                  </select>
                </div>

                {row.action === 'create' && (
                  <div className="mt-2">
                    <label className="text-xs text-zinc-600 dark:text-zinc-400">Target envelope</label>
                    <select
                      value={row.targetEnvelopeId ?? ''}
                      onChange={(event) =>
                        setImportRows((prev) =>
                          prev.map((candidate, candidateIdx) =>
                            candidateIdx === idx ? { ...candidate, targetEnvelopeId: event.target.value } : candidate,
                          ),
                        )
                      }
                      className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                    >
                      <option value="">Select envelope</option>
                      {envelopes.map((envelope) => (
                        <option key={envelope.id} value={envelope.id}>
                          {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {row.action === 'update' && (
                  <div className="mt-2">
                    <label className="text-xs text-zinc-600 dark:text-zinc-400">Match transaction</label>
                    <select
                      value={row.matchTransactionId ?? ''}
                      onChange={(event) =>
                        setImportRows((prev) =>
                          prev.map((candidate, candidateIdx) =>
                            candidateIdx === idx ? { ...candidate, matchTransactionId: event.target.value || null } : candidate,
                          ),
                        )
                      }
                      className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                    >
                      <option value="">Select existing transaction</option>
                      {row.likelyMatches.map((txId) => {
                        const tx = transactionById[txId]
                        if (!tx) return null
                        return (
                          <option key={tx.id} value={tx.id}>
                            {tx.payee} • {tx.date} • {formatCurrencyFromCents(tx.amount_cents)}
                          </option>
                        )
                      })}
                    </select>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard
        title={editingId ? 'Edit Transaction' : 'Add Transaction'}
        storageKey="transactions-form"
      >
        <form onSubmit={submitTransaction} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Date</span>
            <input
              type="date"
              value={form.date}
              onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
            className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              required
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Payee</span>
            <input
              type="text"
              value={form.payee}
              onChange={(event) => setForm((prev) => ({ ...prev, payee: event.target.value }))}
              placeholder="e.g. Costco"
            className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              required
            />
          </label>
          <label className="text-sm sm:col-span-2 xl:col-span-3">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Kind</span>
            <select
              value={form.transactionKind}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  transactionKind: event.target.value as TransactionForm['transactionKind'],
                }))
              }
            className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 sm:max-w-xl"
            >
              <option value="regular">Regular — everyday spending and card charges</option>
              <option value="payment">Payment — money toward a card or loan balance</option>
              <option value="interest">Interest — finance charges (APR), not purchases</option>
              <option value="refund">Refund — money back to the envelope (return or credit)</option>
            </select>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              Income and deposits that fund your budget belong in the{' '}
              <span className="font-medium text-zinc-600 dark:text-zinc-300">Paycheck Journal</span>, not here. This
              form is for spending and adjustments; only <span className="font-medium text-zinc-600 dark:text-zinc-300">Refund</span>{' '}
              credits cash back to the envelope (stored as a negative amount).
            </p>
          </label>
          {!editingId && (
            <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 sm:col-span-2 xl:col-span-3">
              <input
                type="checkbox"
                checked={splitMode}
                onChange={(event) =>
                  setSplitMode(() => {
                    const next = event.target.checked
                    if (next) {
                      setSplitLines((prev) =>
                        prev.length >= 2
                          ? prev
                          : [
                              { id: crypto.randomUUID(), envelopeId: envelopes[0]?.id ?? '', amountDollars: '' },
                              { id: crypto.randomUUID(), envelopeId: envelopes[0]?.id ?? '', amountDollars: '' },
                            ],
                      )
                    }
                    return next
                  })
                }
                className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
              Split this transaction across multiple envelopes
            </label>
          )}
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Amount ($)</span>
            <input
              type="text"
              inputMode="decimal"
              value={form.amountDollars}
              onChange={(event) => setForm((prev) => ({ ...prev, amountDollars: event.target.value }))}
              placeholder="0.00"
            className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              required
            />
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              Enter a positive dollar amount. Regular, payment, and interest pull from the envelope and account; refund
              adds back to the envelope.
            </p>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Envelope</span>
            <select
              value={form.envelopeId}
              onChange={(event) => setForm((prev) => ({ ...prev, envelopeId: event.target.value }))}
            className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              required={!splitMode || Boolean(editingId)}
              disabled={splitMode && !editingId}
            >
              <option value="">Select envelope</option>
              {envelopes.map((envelope) => (
                <option key={envelope.id} value={envelope.id}>
                  {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              Figure after the dot is the envelope balance (cash assigned to that category; can be negative if overspent).
            </p>
          </label>
          {splitMode && !editingId && (
            <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800 sm:col-span-2 xl:col-span-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">Split lines</p>
                <button type="button" onClick={addSplitLine} className="btn-secondary px-3 text-xs">
                  Add line
                </button>
              </div>
              <div className="space-y-2">
                {splitLines.map((line, idx) => (
                  <div key={line.id} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
                    <label className="text-xs text-zinc-500 dark:text-zinc-400">
                      Envelope #{idx + 1}
                      <select
                        value={line.envelopeId}
                        onChange={(event) =>
                          setSplitLines((prev) =>
                            prev.map((r) => (r.id === line.id ? { ...r, envelopeId: event.target.value } : r)),
                          )
                        }
                        className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                      >
                        <option value="">Select envelope</option>
                        {envelopes.map((envelope) => (
                          <option key={envelope.id} value={envelope.id}>
                            {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-zinc-500 dark:text-zinc-400">
                      Amount ($)
                      <input
                        type="text"
                        inputMode="decimal"
                        value={line.amountDollars}
                        onChange={(event) =>
                          setSplitLines((prev) =>
                            prev.map((r) => (r.id === line.id ? { ...r, amountDollars: event.target.value } : r)),
                          )
                        }
                        className="mt-1 min-h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                        placeholder="0.00"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setSplitLines((prev) => prev.filter((r) => r.id !== line.id))}
                      disabled={splitLines.length <= 1}
                      className="btn-danger min-h-10 px-3 text-xs disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Account</span>
            <select
              value={form.accountId}
              onChange={(event) => setForm((prev) => ({ ...prev, accountId: event.target.value }))}
              required
              disabled={accounts.length === 0}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {accounts.length === 0 ? (
                <option value="">Add an account on the Accounts page first</option>
              ) : (
                accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {formatAccountDropdownLabel(account.name, account.balance_cents)}
                  </option>
                ))
              )}
            </select>
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              Register line for this transaction (required).
            </p>
          </label>
          <label className="text-sm sm:col-span-2 xl:col-span-3">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Note (optional)</span>
            <input
              type="text"
              value={form.note}
              onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))}
              placeholder="Optional note"
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 sm:col-span-2 xl:col-span-3">
            <input
              type="checkbox"
              checked={form.cleared}
              onChange={(event) => setForm((prev) => ({ ...prev, cleared: event.target.checked }))}
              className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
            Mark as cleared
          </label>
          <div className="sm:col-span-2 xl:col-span-3 flex flex-wrap gap-2 pt-1">
            <button
              type="submit"
              disabled={saving || accounts.length === 0}
              className="min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {editingId ? 'Save Transaction' : 'Create Transaction'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="btn-secondary px-4 text-sm"
              >
                Cancel Edit
              </button>
            )}
          </div>
        </form>
      </CollapsibleCard>

      <CollapsibleCard title="Filters" storageKey="transactions-filters">
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
              onClick={() => applyDatePreset(value)}
              className={[
                'min-h-10 rounded-lg border px-3 text-xs font-medium',
                datePreset === value
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search payee or note"
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 lg:col-span-2"
          />
          <select
            value={filterEnvelopeId}
            onChange={(event) => setFilterEnvelopeId(event.target.value)}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">All envelopes</option>
            {envelopes.map((envelope) => (
              <option key={envelope.id} value={envelope.id}>
                {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
              </option>
            ))}
          </select>
          <select
            value={filterCleared}
            onChange={(event) => setFilterCleared(event.target.value as 'all' | 'cleared' | 'pending')}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="all">All statuses</option>
            <option value="cleared">Cleared only</option>
            <option value="pending">Pending only</option>
          </select>
          <input
            type="date"
            value={filterFromDate}
            onChange={(event) => {
              setDatePreset('custom')
              setFilterFromDate(event.target.value)
            }}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            type="date"
            value={filterToDate}
            onChange={(event) => {
              setDatePreset('custom')
              setFilterToDate(event.target.value)
            }}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Transactions by Category" storageKey="transactions-by-category">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Transactions by Category</h2>
          {filterEnvelopeId && (
            <button
              type="button"
              onClick={() => setFilterEnvelopeId('')}
              className="btn-secondary px-3 text-xs"
            >
              Clear Category Filter
            </button>
          )}
        </div>
        {categorySummary.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No category data for current filters.</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {categorySummary.map((category) => (
              <button
                key={category.envelopeId}
                type="button"
                onClick={() => setFilterEnvelopeId(category.envelopeId)}
                className={[
                  'rounded-xl border p-3 text-left transition',
                  filterEnvelopeId === category.envelopeId
                    ? 'border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40'
                    : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60',
                ].join(' ')}
              >
                <p className="truncate text-sm font-semibold">{category.name}</p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{category.count} transaction(s)</p>
                <p className="mt-1 text-sm font-semibold text-red-700 dark:text-red-300">
                  {formatSignedCurrency(category.total)}
                </p>
              </button>
            ))}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Recent Transactions" storageKey="transactions-list">
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={exportFilteredToCsv}
            className="btn-secondary px-3 text-xs"
          >
            Export Filtered CSV
          </button>
          <select
            value={bulkEnvelopeId}
            onChange={(event) => setBulkEnvelopeId(event.target.value)}
            className="min-h-10 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">Bulk assign envelope...</option>
            {envelopes.map((envelope) => (
              <option key={envelope.id} value={envelope.id}>
                {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void bulkAssignEnvelope()}
            disabled={!bulkEnvelopeId || selectedTransactionIds.length === 0 || saving}
            className="min-h-10 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Apply to Selected ({selectedTransactionIds.length})
          </button>
          <button
            type="button"
            onClick={() =>
              setSelectedTransactionIds((prev) =>
                prev.length === filteredTransactions.length
                  ? []
                  : filteredTransactions.map((transaction) => transaction.id),
              )
            }
            className="btn-secondary px-3 text-xs"
          >
            {allFilteredSelected ? 'Clear Selection' : 'Select Filtered'}
          </button>
          <button
            type="button"
            onClick={() => void clearSelectedTransactions()}
            disabled={selectedTransactionIds.length === 0 || saving}
            className="btn-danger px-3 text-xs"
          >
            Clear Selected
          </button>
        </div>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading transactions...</p>
        ) : filteredTransactions.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No transactions match your filters.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {filteredTransactions.map((transaction) => (
              <div
                key={transaction.id}
                className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{transaction.payee}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {format(new Date(transaction.date), 'MMM d, yyyy')} •{' '}
                    {transaction.envelope?.name ?? (transaction.envelope_id == null ? 'Account only' : 'Unknown envelope')}{' '}
                    •{' '}
                    {transaction.cleared ? 'Cleared' : 'Pending'}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Kind: {transaction.transaction_kind.replace('_', ' ')}
                  </p>
                  {transaction.account?.name && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Account: {transaction.account.name}</p>
                  )}
                  {transaction.note && (
                    <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{transaction.note}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedTransactionIds.includes(transaction.id)}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setSelectedTransactionIds((prev) =>
                          prev.includes(transaction.id) ? prev : [...prev, transaction.id],
                        )
                      } else {
                        setSelectedTransactionIds((prev) => prev.filter((id) => id !== transaction.id))
                      }
                    }}
                    className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-950"
                    aria-label={`Select ${transaction.payee}`}
                  />
                  <p
                    className={[
                      'text-sm font-semibold',
                      transaction.amount_cents < 0
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-red-700 dark:text-red-300',
                    ].join(' ')}
                  >
                    {formatSignedCurrency(transaction.amount_cents)}
                  </p>
                  <button
                    type="button"
                    onClick={() => beginEdit(transaction)}
                    className="btn-secondary px-3 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void archiveTransaction(transaction.id)}
                    className="btn-danger px-3 text-xs"
                  >
                    Archive
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>
    </div>
  )
}

/**
 * Paycheck Journal handles income; manual entry is spend by default.
 * Refund always credits the envelope (negative stored amount). Otherwise sign follows `direction` (outflow for new rows; from the row when editing).
 */
function manualTransactionSignedCents(
  amountDollars: string,
  opts: { direction: 'outflow' | 'inflow'; transactionKind: TransactionForm['transactionKind'] },
): number | null {
  const base = dollarsStringToCents(amountDollars)
  if (base == null || base <= 0) return null
  if (opts.transactionKind === 'refund') return -base
  if (opts.direction === 'inflow') return -base
  return base
}

function formatSignedCurrency(cents: number): string {
  if (cents < 0) return `+${formatCurrencyFromCents(Math.abs(cents))}`
  return `-${formatCurrencyFromCents(cents)}`
}
