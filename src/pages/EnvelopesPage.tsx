import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { getSupabase } from '../lib/supabase'
import {
  dollarsStringToCents,
  formatAccountDropdownLabel,
  formatCurrencyFromCents,
  formatEnvelopeDropdownLabel,
  normalizeDollarsInput,
} from '../lib/currency'
import { addMonths, endOfMonth, format, startOfMonth, subDays, subMonths } from 'date-fns'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import {
  isBillPaidForMonth,
  monthKeyFromDate,
  normalizeBillPaidByMonth,
  setEnvelopeBillPaidForMonth,
} from '../lib/billPaidMonth'
import { daysUntilNextDue, formatDueDayPhrase, nextDueDateOnOrAfter } from '../lib/envelopeDueDates'

type EnvelopeType = 'expense' | 'savings' | 'debt'

type EnvelopeGroup = {
  id: string
  name: string
  sort_order: number
  archived: boolean
}

type EnvelopeGoalType = 'assign_monthly' | 'refill_up_to'

type Envelope = {
  id: string
  name: string
  type: EnvelopeType
  budget_target_cents: number
  goal_type: EnvelopeGoalType | null
  goal_target_cents: number | null
  balance_cents: number
  color: string
  sort_order: number
  archived: boolean
  group_id: string | null
  due_day_of_month: number | null
  bill_paid_by_month: Record<string, boolean>
  is_subscription: boolean
  subscription_amount_cents: number | null
  subscription_payee: string | null
  subscription_note: string | null
  subscription_account_id: string | null
  subscription_autopay_enabled: boolean
  subscription_last_paid_month: string | null
}

type FinancialAccount = {
  id: string
  name: string
  account_type: 'checking' | 'savings' | 'credit_card' | 'debt' | 'cash' | 'other'
  balance_cents: number
}

type EnvelopeMove = {
  id: string
  from_envelope_id: string
  to_envelope_id: string
  amount_cents: number
  reason: string | null
  created_at: string
  from_envelope: { name: string } | null
  to_envelope: { name: string } | null
}

type EnvelopeForm = {
  name: string
  type: EnvelopeType
  goalType: EnvelopeGoalType
  targetDollars: string
  color: string
  groupId: string
  /** Empty = no due day; otherwise 1–31 */
  dueDayOfMonth: string
}

type MoveForm = {
  fromEnvelopeId: string
  toEnvelopeId: string
  amountDollars: string
  reason: string
}

type SubscriptionForm = {
  envelopeId: string
  accountId: string
  payee: string
  amountDollars: string
  note: string
  autopayEnabled: boolean
}

type DatePreset = 'all_time' | 'this_month' | 'last_30' | 'last_90' | 'custom'

const DEFAULT_GROUP_LABEL = 'Ungrouped'
const ENVELOPE_COLOR_PALETTE = [
  '#10b981',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#ec4899',
  '#f43f5e',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#64748b',
]

function monthKeyToLocalDate(monthKey: string): Date {
  const [yearRaw, monthRaw] = monthKey.split('-')
  const year = Number.parseInt(yearRaw ?? '', 10)
  const month = Number.parseInt(monthRaw ?? '', 10)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return new Date()
  }
  return new Date(year, month - 1, 1)
}

const DEFAULT_FORM: EnvelopeForm = {
  name: '',
  type: 'expense',
  goalType: 'assign_monthly',
  targetDollars: '',
  color: '#10b981',
  groupId: '',
  dueDayOfMonth: '',
}

const DEFAULT_MOVE_FORM: MoveForm = {
  fromEnvelopeId: '',
  toEnvelopeId: '',
  amountDollars: '',
  reason: '',
}

const DEFAULT_SUBSCRIPTION_FORM: SubscriptionForm = {
  envelopeId: '',
  accountId: '',
  payee: '',
  amountDollars: '',
  note: '',
  autopayEnabled: true,
}

export function EnvelopesPage() {
  const [groups, setGroups] = useState<EnvelopeGroup[]>([])
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [moves, setMoves] = useState<EnvelopeMove[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [groupRename, setGroupRename] = useState<Record<string, string>>({})
  const [form, setForm] = useState<EnvelopeForm>(DEFAULT_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [reconcileEnvelopeId, setReconcileEnvelopeId] = useState('')
  const [reconcileDismissedForDeltaCents, setReconcileDismissedForDeltaCents] = useState<number | null>(null)
  const [moveForm, setMoveForm] = useState<MoveForm>(DEFAULT_MOVE_FORM)
  const [subscriptionForm, setSubscriptionForm] = useState<SubscriptionForm>(DEFAULT_SUBSCRIPTION_FORM)
  const [subscriptionEditingEnvelopeId, setSubscriptionEditingEnvelopeId] = useState<string | null>(null)
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)
  const [draggingEnvelopeId, setDraggingEnvelopeId] = useState<string | null>(null)
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)
  const [dragOverEnvelopeId, setDragOverEnvelopeId] = useState<string | null>(null)
  const [movesFromDate, setMovesFromDate] = useState('')
  const [movesToDate, setMovesToDate] = useState('')
  const [movesDatePreset, setMovesDatePreset] = useState<DatePreset>('all_time')
  const [billPaidSavingId, setBillPaidSavingId] = useState<string | null>(null)
  const [monthlyAssignedByEnvelope, setMonthlyAssignedByEnvelope] = useState<Record<string, number>>({})
  const [assignmentMatrix, setAssignmentMatrix] = useState<Record<string, number>>({})
  const [allAssignedByEnvelopeMonth, setAllAssignedByEnvelopeMonth] = useState<Record<string, number>>({})
  const [futureAssignedAfterViewByEnvelope, setFutureAssignedAfterViewByEnvelope] = useState<Record<string, number>>(
    {},
  )
  /** Outflows (positive txn amounts) per envelope in `activeEnvelopesViewMonth` calendar month. */
  const [spentByEnvelopeViewMonth, setSpentByEnvelopeViewMonth] = useState<Record<string, number>>({})
  const [assignmentWindowStart, setAssignmentWindowStart] = useState(() =>
    startOfMonth(subMonths(new Date(), 5)),
  )
  /** Month used for "assigned" progress bars under Active Envelopes. */
  const [activeEnvelopesViewMonth, setActiveEnvelopesViewMonth] = useState(() => startOfMonth(new Date()))
  const assignmentMonths = useMemo(
    () =>
      Array.from({ length: 6 }, (_, idx) =>
        format(startOfMonth(addMonths(assignmentWindowStart, idx)), 'yyyy-MM'),
      ),
    [assignmentWindowStart],
  )

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const autoResp = await supabase.rpc('run_subscription_autopay', {
        p_run_date: format(new Date(), 'yyyy-MM-dd'),
      })
      if (autoResp.error && !autoResp.error.message.toLowerCase().includes('run_subscription_autopay')) {
        throw autoResp.error
      }
      const assignStart = startOfMonth(assignmentWindowStart)
      const assignEnd = endOfMonth(addMonths(assignStart, 5))
      const viewMonthStart = format(startOfMonth(activeEnvelopesViewMonth), 'yyyy-MM-dd')
      const viewMonthEnd = format(endOfMonth(activeEnvelopesViewMonth), 'yyyy-MM-dd')
      const [groupsResp, envelopesResp, movesResp, monthAllocationsResp, accountsResp, spentTxResp] = await Promise.all([
        supabase.from('envelope_groups').select('id,name,sort_order,archived').order('sort_order', { ascending: true }),
        supabase
          .from('envelopes')
          .select(
            'id,name,type,budget_target_cents,goal_type,goal_target_cents,balance_cents,color,sort_order,archived,group_id,due_day_of_month,bill_paid_by_month,is_subscription,subscription_amount_cents,subscription_payee,subscription_note,subscription_account_id,subscription_autopay_enabled,subscription_last_paid_month',
          )
          .order('sort_order', { ascending: true }),
        supabase
          .from('envelope_moves')
          .select(
            'id,from_envelope_id,to_envelope_id,amount_cents,reason,created_at,from_envelope:from_envelope_id(name),to_envelope:to_envelope_id(name)',
          )
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('paycheck_allocations')
          .select('envelope_id,amount_cents,allocation_month')
          .order('allocation_month', { ascending: true }),
        supabase
          .from('financial_accounts')
          .select('id,name,account_type,balance_cents')
          .eq('archived', false)
          .in('account_type', ['checking', 'savings', 'cash', 'other'])
          .order('name', { ascending: true }),
        supabase
          .from('transactions')
          .select('envelope_id,amount_cents')
          .eq('archived', false)
          .gte('date', viewMonthStart)
          .lte('date', viewMonthEnd)
          .limit(20_000),
      ])
      if (groupsResp.error) throw groupsResp.error
      if (envelopesResp.error) throw envelopesResp.error
      if (movesResp.error) throw movesResp.error
      if (monthAllocationsResp.error) throw monthAllocationsResp.error
      if (accountsResp.error) throw accountsResp.error
      if (spentTxResp.error) throw spentTxResp.error

      setGroups(groupsResp.data ?? [])
      setEnvelopes(
        (envelopesResp.data ?? []).map((row) => ({
          ...row,
          bill_paid_by_month: normalizeBillPaidByMonth((row as Envelope).bill_paid_by_month),
        })) as Envelope[],
      )
      setMoves((movesResp.data ?? []) as unknown as EnvelopeMove[])
      setAccounts((accountsResp.data ?? []) as FinancialAccount[])
      const byEnvelope: Record<string, number> = {}
      const matrix: Record<string, number> = {}
      const allAssigned: Record<string, number> = {}
      const futureByEnvelope: Record<string, number> = {}
      const viewMonthKey = format(activeEnvelopesViewMonth, 'yyyy-MM')
      const assignWindowStartMonth = format(assignStart, 'yyyy-MM')
      const assignWindowEndMonth = format(assignEnd, 'yyyy-MM')
      for (const row of (monthAllocationsResp.data ?? []) as Array<{
        envelope_id: string
        amount_cents: number
        allocation_month: string
      }>) {
        const month = row.allocation_month?.slice(0, 7)
        if (!month) continue
        const allKey = `${row.envelope_id}|${month}`
        allAssigned[allKey] = (allAssigned[allKey] ?? 0) + row.amount_cents
        if (month >= assignWindowStartMonth && month <= assignWindowEndMonth) {
          const key = `${row.envelope_id}|${month}`
          matrix[key] = (matrix[key] ?? 0) + row.amount_cents
        }
        if (month === viewMonthKey) {
          byEnvelope[row.envelope_id] = (byEnvelope[row.envelope_id] ?? 0) + row.amount_cents
        }
        if (month > viewMonthKey) {
          futureByEnvelope[row.envelope_id] = (futureByEnvelope[row.envelope_id] ?? 0) + row.amount_cents
        }
      }
      setMonthlyAssignedByEnvelope(byEnvelope)
      setAssignmentMatrix(matrix)
      setAllAssignedByEnvelopeMonth(allAssigned)
      setFutureAssignedAfterViewByEnvelope(futureByEnvelope)

      const spentByEnvelope: Record<string, number> = {}
      for (const row of (spentTxResp.data ?? []) as Array<{ envelope_id: string | null; amount_cents: number }>) {
        if (!row.envelope_id) continue
        const out = row.amount_cents > 0 ? row.amount_cents : 0
        spentByEnvelope[row.envelope_id] = (spentByEnvelope[row.envelope_id] ?? 0) + out
      }
      setSpentByEnvelopeViewMonth(spentByEnvelope)

      setGroupRename(
        Object.fromEntries((groupsResp.data ?? []).map((group) => [group.id, group.name])),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load envelope data.')
    } finally {
      setLoading(false)
    }
  }, [assignmentWindowStart, activeEnvelopesViewMonth])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    if (subscriptionEditingEnvelopeId) return
    if (subscriptionForm.accountId) return
    if (accounts.length === 0) return
    setSubscriptionForm((prev) => ({ ...prev, accountId: accounts[0].id }))
  }, [accounts, subscriptionEditingEnvelopeId, subscriptionForm.accountId])

  const groupedEnvelopes = useMemo(() => {
    const activeGroups = groups
      .filter((group) => !group.archived)
      .sort((a, b) => a.sort_order - b.sort_order)
    const sortedActiveEnvelopes = envelopes
      .filter((envelope) => !envelope.archived)
      .sort((a, b) => (a.sort_order === b.sort_order ? a.name.localeCompare(b.name) : a.sort_order - b.sort_order))
    const byGroup = activeGroups.map((group) => ({
      id: group.id,
      label: group.name,
      envelopes: sortedActiveEnvelopes.filter((envelope) => envelope.group_id === group.id),
    }))
    const ungrouped = sortedActiveEnvelopes.filter((envelope) => !envelope.group_id)
    if (ungrouped.length > 0) {
      byGroup.push({ id: 'ungrouped', label: DEFAULT_GROUP_LABEL, envelopes: ungrouped })
    }
    return byGroup
  }, [groups, envelopes])

  const activeEnvelopes = useMemo(
    () =>
      envelopes
        .filter((envelope) => !envelope.archived)
        .sort((a, b) => (a.sort_order === b.sort_order ? a.name.localeCompare(b.name) : a.sort_order - b.sort_order)),
    [envelopes],
  )

  const cashAccountTotalCents = useMemo(
    () => accounts.reduce((sum, account) => sum + account.balance_cents, 0),
    [accounts],
  )
  const envelopeTotalCents = useMemo(
    () => activeEnvelopes.reduce((sum, envelope) => sum + envelope.balance_cents, 0),
    [activeEnvelopes],
  )
  const envelopeAccountDeltaCents = cashAccountTotalCents - envelopeTotalCents

  const subscriptionEnvelopes = useMemo(
    () => activeEnvelopes.filter((e) => e.is_subscription).sort((a, b) => a.name.localeCompare(b.name)),
    [activeEnvelopes],
  )

  const upcomingBills = useMemo(() => {
    const withDue = activeEnvelopes.filter((e) => e.due_day_of_month != null && e.type !== 'debt')
    const today = new Date()
    return [...withDue].sort(
      (a, b) =>
        daysUntilNextDue(a.due_day_of_month!, today) - daysUntilNextDue(b.due_day_of_month!, today),
    )
  }, [activeEnvelopes])

  useEffect(() => {
    if (loading) return
    if (activeEnvelopes.length === 0) return
    if (envelopeAccountDeltaCents === 0) {
      setReconcileOpen(false)
      setReconcileDismissedForDeltaCents(null)
      return
    }
    if (reconcileDismissedForDeltaCents === envelopeAccountDeltaCents) return
    setReconcileEnvelopeId((prev) => prev || activeEnvelopes[0]?.id || '')
    setReconcileOpen(true)
  }, [loading, activeEnvelopes, envelopeAccountDeltaCents, reconcileDismissedForDeltaCents])

  const reservedAfterMonthForEnvelope = useCallback(
    (envelopeId: string, monthKey: string): number => {
      let total = 0
      for (const [key, cents] of Object.entries(allAssignedByEnvelopeMonth)) {
        const [envId, mk] = key.split('|')
        if (envId === envelopeId && mk > monthKey) total += cents
      }
      return total
    },
    [allAssignedByEnvelopeMonth],
  )

  const filteredMoves = useMemo(
    () =>
      moves.filter((move) => {
        const moveDate = move.created_at.slice(0, 10)
        if (movesFromDate && moveDate < movesFromDate) return false
        if (movesToDate && moveDate > movesToDate) return false
        return true
      }),
    [moves, movesFromDate, movesToDate],
  )

  async function persistActiveGroupOrder(groupIds: string[]) {
    for (const [idx, id] of groupIds.entries()) {
      const { error: updateError } = await getSupabase()
        .from('envelope_groups')
        .update({ sort_order: idx })
        .eq('id', id)
      if (updateError) throw updateError
    }
  }

  async function persistActiveEnvelopeOrder(order: string[], draggedEnvelopeNewGroupId?: string | null) {
    const draggedId = draggingEnvelopeId
    for (const [idx, id] of order.entries()) {
      const update: { sort_order: number; group_id?: string | null } = { sort_order: idx }
      if (draggedId && id === draggedId && draggedEnvelopeNewGroupId !== undefined) {
        update.group_id = draggedEnvelopeNewGroupId
      }
      const { error: updateError } = await getSupabase().from('envelopes').update(update).eq('id', id)
      if (updateError) throw updateError
    }
  }

  async function dropGroupOnGroup(targetGroupId: string) {
    if (!draggingGroupId || draggingGroupId === targetGroupId) return
    setSaving(true)
    setError(null)
    try {
      const ids = groups.filter((g) => !g.archived).map((g) => g.id)
      const from = ids.indexOf(draggingGroupId)
      const to = ids.indexOf(targetGroupId)
      if (from < 0 || to < 0) return
      const next = [...ids]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      await persistActiveGroupOrder(next)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reorder groups.')
    } finally {
      setSaving(false)
      setDraggingGroupId(null)
      setDragOverGroupId(null)
    }
  }

  async function dropEnvelopeOnEnvelope(targetEnvelopeId: string, targetGroupId: string | null) {
    if (!draggingEnvelopeId || draggingEnvelopeId === targetEnvelopeId) return
    setSaving(true)
    setError(null)
    try {
      const ids = activeEnvelopes.map((e) => e.id)
      const from = ids.indexOf(draggingEnvelopeId)
      const to = ids.indexOf(targetEnvelopeId)
      if (from < 0 || to < 0) return
      const next = [...ids]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      await persistActiveEnvelopeOrder(next, targetGroupId)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reorder envelopes.')
    } finally {
      setSaving(false)
      setDraggingEnvelopeId(null)
      setDragOverEnvelopeId(null)
      setDragOverGroupId(null)
    }
  }

  async function dropEnvelopeOnGroup(targetGroupId: string | null) {
    if (!draggingEnvelopeId) return
    setSaving(true)
    setError(null)
    try {
      const ids = activeEnvelopes.map((e) => e.id).filter((id) => id !== draggingEnvelopeId)
      const byId = Object.fromEntries(activeEnvelopes.map((e) => [e.id, e]))
      let insertAt = ids.length
      for (let i = ids.length - 1; i >= 0; i -= 1) {
        const envelope = byId[ids[i]]
        const gid = envelope?.group_id ?? null
        if (gid === targetGroupId) {
          insertAt = i + 1
          break
        }
      }
      ids.splice(insertAt, 0, draggingEnvelopeId)
      await persistActiveEnvelopeOrder(ids, targetGroupId)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move envelope to this group.')
    } finally {
      setSaving(false)
      setDraggingEnvelopeId(null)
      setDragOverEnvelopeId(null)
      setDragOverGroupId(null)
    }
  }

  function resetForm() {
    setForm(DEFAULT_FORM)
    setEditingId(null)
  }

  async function createGroup() {
    const name = newGroupName.trim()
    if (!name) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const nextSort = groups.length === 0 ? 0 : Math.max(...groups.map((group) => group.sort_order)) + 1
      const { error: insertError } = await getSupabase()
        .from('envelope_groups')
        .insert({ name, sort_order: nextSort })
      if (insertError) throw insertError
      setNewGroupName('')
      setNotice('Group created.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create group.')
    } finally {
      setSaving(false)
    }
  }

  async function renameGroup(groupId: string) {
    const name = (groupRename[groupId] ?? '').trim()
    if (!name) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await getSupabase()
        .from('envelope_groups')
        .update({ name })
        .eq('id', groupId)
      if (updateError) throw updateError
      setNotice('Group updated.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update group.')
    } finally {
      setSaving(false)
    }
  }

  async function archiveGroup(groupId: string) {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await getSupabase()
        .from('envelope_groups')
        .update({ archived: true })
        .eq('id', groupId)
      if (updateError) throw updateError
      setNotice('Group archived.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive group.')
    } finally {
      setSaving(false)
    }
  }

  function beginEdit(envelope: Envelope) {
    setEditingId(envelope.id)
    const goalType: EnvelopeGoalType = envelope.goal_type === 'refill_up_to' ? 'refill_up_to' : 'assign_monthly'
    const targetCents =
      goalType === 'refill_up_to' ? (envelope.goal_target_cents ?? 0) : envelope.budget_target_cents
    setForm({
      name: envelope.name,
      type: envelope.type,
      goalType,
      targetDollars: (targetCents / 100).toFixed(2),
      color: envelope.color || '#10b981',
      groupId: envelope.group_id ?? '',
      dueDayOfMonth: envelope.due_day_of_month != null ? String(envelope.due_day_of_month) : '',
    })
    setNotice(null)
    setError(null)
  }

  async function submitEnvelope(event: FormEvent) {
    event.preventDefault()
    const name = form.name.trim()
    if (!name) {
      setError('Envelope name is required.')
      return
    }

    const targetCents = dollarsStringToCents(form.targetDollars)
    if (targetCents == null || targetCents < 0) {
      setError('Goal amount must be a valid non-negative amount.')
      return
    }
    if (form.goalType === 'refill_up_to' && targetCents === 0) {
      setError('Refill cap must be greater than zero, or switch goal type to assign monthly with $0.')
      return
    }

    let dueDayOfMonth: number | null = null
    const rawDue = form.dueDayOfMonth.trim()
    if (rawDue.length > 0) {
      const parsed = Number.parseInt(rawDue, 10)
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 31) {
        setError('Due day must be empty or a whole number from 1 to 31.')
        return
      }
      dueDayOfMonth = parsed
    }

    const balanceCents = editingId
      ? (envelopes.find((envelope) => envelope.id === editingId)?.balance_cents ?? 0)
      : 0

    setSaving(true)
    setError(null)
    setNotice(null)

    try {
      const dueClear = dueDayOfMonth == null ? ({ bill_paid_by_month: {} } as const) : ({} as const)
      const payload =
        form.goalType === 'assign_monthly'
          ? {
              name,
              type: form.type,
              budget_target_cents: targetCents,
              goal_type: 'assign_monthly' as const,
              goal_target_cents: null as number | null,
              balance_cents: balanceCents,
              color: form.color || '#10b981',
              group_id: form.groupId || null,
              due_day_of_month: dueDayOfMonth,
              ...dueClear,
            }
          : {
              name,
              type: form.type,
              budget_target_cents: 0,
              goal_type: 'refill_up_to' as const,
              goal_target_cents: targetCents,
              balance_cents: balanceCents,
              color: form.color || '#10b981',
              group_id: form.groupId || null,
              due_day_of_month: dueDayOfMonth,
              ...dueClear,
            }

      if (editingId) {
        const { error: updateError } = await getSupabase().from('envelopes').update(payload).eq('id', editingId)
        if (updateError) throw updateError
        setNotice('Envelope updated.')
      } else {
        const nextSort = envelopes.length === 0 ? 0 : Math.max(...envelopes.map((envelope) => envelope.sort_order)) + 1
        const { error: insertError } = await getSupabase().from('envelopes').insert({ ...payload, sort_order: nextSort })
        if (insertError) throw insertError
        setNotice('Envelope created.')
      }

      resetForm()
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save envelope.')
    } finally {
      setSaving(false)
    }
  }

  async function toggleBillPaidForEnvelope(envelope: Envelope, monthKey: string, paid: boolean) {
    setBillPaidSavingId(envelope.id)
    setError(null)
    setNotice(null)
    try {
      await setEnvelopeBillPaidForMonth(envelope.id, envelope.bill_paid_by_month ?? {}, monthKey, paid)
      setNotice(paid ? 'Marked paid for that bill month.' : 'Cleared paid mark.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update paid status.')
    } finally {
      setBillPaidSavingId(null)
    }
  }

  async function archiveEnvelope(id: string) {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await getSupabase().from('envelopes').update({ archived: true }).eq('id', id)
      if (updateError) throw updateError
      setNotice('Envelope archived.')
      if (editingId === id) resetForm()
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive envelope.')
    } finally {
      setSaving(false)
    }
  }

  async function submitMove(event: FormEvent) {
    event.preventDefault()

    const fromEnvelopeId = moveForm.fromEnvelopeId
    const toEnvelopeId = moveForm.toEnvelopeId
    const amountCents = dollarsStringToCents(moveForm.amountDollars)

    if (!fromEnvelopeId || !toEnvelopeId) {
      setError('Select both source and destination envelopes.')
      return
    }
    if (fromEnvelopeId === toEnvelopeId) {
      setError('Source and destination envelopes must be different.')
      return
    }
    if (amountCents == null || amountCents <= 0) {
      setError('Move amount must be a valid number greater than 0.')
      return
    }

    const fromEnvelope = activeEnvelopes.find((envelope) => envelope.id === fromEnvelopeId)
    if (!fromEnvelope) {
      setError('The source envelope no longer exists.')
      return
    }
    if (fromEnvelope.balance_cents < amountCents) {
      setError('Insufficient funds in the source envelope.')
      return
    }

    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: moveError } = await getSupabase().rpc('move_envelope_funds', {
        p_from_envelope_id: fromEnvelopeId,
        p_to_envelope_id: toEnvelopeId,
        p_amount_cents: amountCents,
        p_reason: moveForm.reason.trim() || null,
      })
      if (moveError) throw moveError

      setMoveOpen(false)
      setMoveForm(DEFAULT_MOVE_FORM)
      setNotice('Funds moved successfully.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move funds.')
    } finally {
      setSaving(false)
    }
  }

  async function applyEnvelopeTotalReconciliation() {
    if (!reconcileEnvelopeId || envelopeAccountDeltaCents === 0) return
    const envelope = activeEnvelopes.find((item) => item.id === reconcileEnvelopeId)
    if (!envelope) {
      setError('Choose an envelope to apply the reconciliation adjustment.')
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const nextBalance = envelope.balance_cents + envelopeAccountDeltaCents
      const { error: updateError } = await getSupabase()
        .from('envelopes')
        .update({ balance_cents: nextBalance })
        .eq('id', reconcileEnvelopeId)
      if (updateError) throw updateError
      setNotice(
        `Reconciled envelope totals by applying ${formatCurrencyFromCents(envelopeAccountDeltaCents)} to ${envelope.name}.`,
      )
      setReconcileOpen(false)
      setReconcileDismissedForDeltaCents(null)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reconcile envelope totals.')
    } finally {
      setSaving(false)
    }
  }

  function beginSubscriptionEdit(envelope: Envelope) {
    setSubscriptionEditingEnvelopeId(envelope.id)
    setSubscriptionForm({
      envelopeId: envelope.id,
      accountId: envelope.subscription_account_id ?? accounts[0]?.id ?? '',
      payee: envelope.subscription_payee ?? envelope.name,
      amountDollars:
        envelope.subscription_amount_cents != null
          ? (envelope.subscription_amount_cents / 100).toFixed(2)
          : (envelope.budget_target_cents / 100).toFixed(2),
      note: envelope.subscription_note ?? '',
      autopayEnabled: envelope.subscription_autopay_enabled,
    })
    setError(null)
    setNotice(null)
  }

  async function submitSubscription(event: FormEvent) {
    event.preventDefault()
    const envelopeId = subscriptionForm.envelopeId
    const accountId = subscriptionForm.accountId
    const amountCents = dollarsStringToCents(subscriptionForm.amountDollars)
    const payee = subscriptionForm.payee.trim()
    if (!envelopeId) {
      setError('Select an envelope to track as a subscription.')
      return
    }
    if (!accountId) {
      setError('Select the payment account.')
      return
    }
    if (!payee) {
      setError('Payee is required for the subscription.')
      return
    }
    if (amountCents == null || amountCents <= 0) {
      setError('Subscription amount must be greater than 0.')
      return
    }
    const env = activeEnvelopes.find((e) => e.id === envelopeId)
    if (!env) {
      setError('That envelope no longer exists.')
      return
    }
    if (env.due_day_of_month == null) {
      setError('Set a due day on the envelope first so autopay knows when to post.')
      return
    }

    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await getSupabase()
        .from('envelopes')
        .update({
          is_subscription: true,
          subscription_amount_cents: amountCents,
          subscription_payee: payee,
          subscription_note: subscriptionForm.note.trim() || null,
          subscription_account_id: accountId,
          subscription_autopay_enabled: subscriptionForm.autopayEnabled,
        })
        .eq('id', envelopeId)
      if (updateError) throw updateError
      setSubscriptionEditingEnvelopeId(null)
      setSubscriptionForm({
        ...DEFAULT_SUBSCRIPTION_FORM,
        accountId: accounts[0]?.id ?? '',
      })
      setNotice('Subscription saved.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save subscription.')
    } finally {
      setSaving(false)
    }
  }

  async function removeSubscription(envelopeId: string) {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const { error: updateError } = await getSupabase()
        .from('envelopes')
        .update({
          is_subscription: false,
          subscription_amount_cents: null,
          subscription_payee: null,
          subscription_note: null,
          subscription_account_id: null,
          subscription_autopay_enabled: true,
          subscription_last_paid_month: null,
        })
        .eq('id', envelopeId)
      if (updateError) throw updateError
      setNotice('Subscription removed.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove subscription.')
    } finally {
      setSaving(false)
    }
  }

  async function runSubscriptionAutopayNow() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const today = format(new Date(), 'yyyy-MM-dd')
      const { data, error: rpcError } = await getSupabase().rpc('run_subscription_autopay', {
        p_run_date: today,
      })
      if (rpcError) throw rpcError
      const count = typeof data === 'number' ? data : 0
      setNotice(count > 0 ? `Posted ${count} subscription payment${count === 1 ? '' : 's'}.` : 'No subscriptions were due today.')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run subscription autopay.')
    } finally {
      setSaving(false)
    }
  }

  function applyMovesDatePreset(preset: DatePreset) {
    const today = new Date()
    setMovesDatePreset(preset)
    if (preset === 'all_time') {
      setMovesFromDate('')
      setMovesToDate('')
      return
    }
    if (preset === 'this_month') {
      setMovesFromDate(format(startOfMonth(today), 'yyyy-MM-dd'))
      setMovesToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'last_30') {
      setMovesFromDate(format(subDays(today, 29), 'yyyy-MM-dd'))
      setMovesToDate(format(today, 'yyyy-MM-dd'))
      return
    }
    if (preset === 'last_90') {
      setMovesFromDate(format(subDays(today, 89), 'yyyy-MM-dd'))
      setMovesToDate(format(today, 'yyyy-MM-dd'))
      return
    }
  }

  return (
    <div className="space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface p-4 sm:p-6">
        <h1 className="section-title">Envelopes</h1>
        <p className="section-subtitle">
          Manage category groups and monthly assignment targets. Balances change from paychecks, spending, and moves—
          not from the envelope form. Set an optional due day (1–31) on bill-style categories so the dashboard can show
          what is coming up.
        </p>
        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">{error}</p>}
        {notice && <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">{notice}</p>}
      </section>

      <CollapsibleCard title="Assigned by Month" storageKey="envelopes-assigned-by-month">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Assigned by Month</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAssignmentWindowStart((prev) => startOfMonth(subMonths(prev, 1)))}
              className="btn-secondary px-3 text-xs"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setAssignmentWindowStart((prev) => startOfMonth(addMonths(prev, 1)))}
              className="btn-secondary px-3 text-xs"
            >
              Next
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Showing {format(monthKeyToLocalDate(assignmentMonths[0]), 'MMM yyyy')} through{' '}
          {format(monthKeyToLocalDate(assignmentMonths[assignmentMonths.length - 1]), 'MMM yyyy')}.
        </p>
        {activeEnvelopes.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No envelopes yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-y-1 text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  <th className="px-2 py-1">Envelope</th>
                  {assignmentMonths.map((month) => (
                    <th key={month} className="px-2 py-1">
                      {format(monthKeyToLocalDate(month), 'MMM yyyy')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeEnvelopes.map((envelope) => (
                  <tr key={envelope.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                    <td className="px-2 py-2 font-medium">{envelope.name}</td>
                    {assignmentMonths.map((month) => {
                      const cents = assignmentMatrix[`${envelope.id}|${month}`] ?? 0
                      return (
                        <td key={`${envelope.id}-${month}`} className="px-2 py-2">
                          {cents > 0 ? formatCurrencyFromCents(cents) : '—'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Envelope Groups" storageKey="envelopes-groups">
        <h2 className="text-base font-semibold">Envelope Groups</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={newGroupName}
            onChange={(event) => setNewGroupName(event.target.value)}
            placeholder="New group name (e.g. Bills)"
            className="min-h-11 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button
            type="button"
            onClick={() => void createGroup()}
            disabled={saving}
            className="btn-primary px-4 text-sm"
          >
            Add Group
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {groups.filter((group) => !group.archived).map((group) => (
            <div
              key={group.id}
              draggable
              onDragStart={() => setDraggingGroupId(group.id)}
              onDragEnd={() => {
                setDraggingGroupId(null)
                setDragOverGroupId(null)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                if (draggingGroupId) setDragOverGroupId(group.id)
              }}
              onDragLeave={() => {
                if (dragOverGroupId === group.id) setDragOverGroupId(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                void dropGroupOnGroup(group.id)
              }}
              className={[
                'flex cursor-grab flex-col gap-2 rounded-xl border p-3.5 transition-all active:cursor-grabbing dark:border-zinc-800 sm:flex-row sm:items-center',
                draggingGroupId === group.id
                  ? 'border-emerald-400 bg-emerald-50/80 opacity-75 shadow-sm dark:border-emerald-700 dark:bg-emerald-950/30'
                  : dragOverGroupId === group.id
                    ? 'border-sky-400 bg-sky-50/70 ring-2 ring-sky-300/70 dark:border-sky-700 dark:bg-sky-950/30 dark:ring-sky-800/60'
                    : 'border-zinc-200',
              ].join(' ')}
            >
              <input
                type="text"
                value={groupRename[group.id] ?? ''}
                onChange={(event) => setGroupRename((prev) => ({ ...prev, [group.id]: event.target.value }))}
                className="min-h-10 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => void renameGroup(group.id)} className="btn-secondary px-3 text-xs">
                  Rename
                </button>
                <button type="button" onClick={() => void archiveGroup(group.id)} className="btn-danger px-3 text-xs">
                  Archive
                </button>
              </div>
            </div>
          ))}
          {groups.filter((group) => !group.archived).length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No active groups yet.</p>
          )}
        </div>
      </CollapsibleCard>

      <CollapsibleCard title={editingId ? 'Edit Envelope' : 'Add Envelope'} storageKey="envelopes-form">
        <h2 className="text-base font-semibold">{editingId ? 'Edit Envelope' : 'Add Envelope'}</h2>
        <form onSubmit={submitEnvelope} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              required
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Type</span>
            <select
              value={form.type}
              onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value as EnvelopeType }))}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="expense">Expense</option>
              <option value="savings">Savings</option>
              <option value="debt">Debt</option>
            </select>
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Goal type</span>
            <select
              value={form.goalType}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, goalType: event.target.value as EnvelopeGoalType }))
              }
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="assign_monthly">Assign up to an amount each month</option>
              <option value="refill_up_to">Refill balance up to a cap</option>
            </select>
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">
              {form.goalType === 'assign_monthly' ? 'Monthly assignment target ($)' : 'Refill cap — target balance ($)'}
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={form.targetDollars}
              onChange={(event) => setForm((prev) => ({ ...prev, targetDollars: event.target.value }))}
              onBlur={(event) =>
                setForm((prev) => ({ ...prev, targetDollars: normalizeDollarsInput(event.target.value) }))
              }
              placeholder="0.00"
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {form.goalType === 'assign_monthly'
                ? 'One number for the month: progress compares paycheck allocations in the Journal to this amount. Use 0 for no monthly target.'
                : 'One number for the cap: progress compares envelope balance to this ceiling. Use the Journal to add funds until you reach it.'}
            </p>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Color</span>
            <div className="flex flex-wrap gap-2 rounded-lg border border-zinc-300 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-950">
              {ENVELOPE_COLOR_PALETTE.map((color) => {
                const isSelected = form.color.toLowerCase() === color.toLowerCase()
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, color }))}
                    className={[
                      'h-7 w-7 rounded-full border transition',
                      isSelected
                        ? 'border-zinc-900 ring-2 ring-offset-1 ring-zinc-400 dark:border-zinc-100 dark:ring-zinc-500'
                        : 'border-zinc-300 dark:border-zinc-700',
                    ].join(' ')}
                    style={{ backgroundColor: color }}
                    title={color}
                    aria-label={`Select envelope color ${color}`}
                  />
                )
              })}
            </div>
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">Selected color: {form.color}</p>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Group</span>
            <select
              value={form.groupId}
              onChange={(event) => setForm((prev) => ({ ...prev, groupId: event.target.value }))}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Ungrouped</option>
              {groups.filter((group) => !group.archived).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Bill due day (optional)</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="e.g. 15 for bills due on the 15th"
              value={form.dueDayOfMonth}
              onChange={(event) => setForm((prev) => ({ ...prev, dueDayOfMonth: event.target.value.replace(/\D/g, '') }))}
              className="min-h-11 w-full max-w-xs rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              Leave blank if this category is not a dated bill. Day 29–31 clamp to the last day in shorter months. After
              you pay, use Mark paid on the dashboard or under Upcoming bills — one flag per calendar month of that due
              date (the May bill is keyed as that May).
            </p>
          </label>
          <div className="sm:col-span-2 flex flex-wrap gap-2 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="btn-primary px-4 text-sm"
            >
              {editingId ? 'Save Envelope' : 'Create Envelope'}
            </button>
            {editingId && (
              <button type="button" onClick={resetForm} className="min-h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium dark:border-zinc-700">
                Cancel Edit
              </button>
            )}
          </div>
        </form>
      </CollapsibleCard>

      <CollapsibleCard title="Upcoming bills" storageKey="envelopes-upcoming" defaultCollapsed={upcomingBills.length === 0}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Envelopes with a due day set, sorted by how soon the next due date is from <strong>today</strong> (not the
          month picker elsewhere on this page).
        </p>
        {upcomingBills.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            No due days yet. Edit an envelope and add a bill due day (1–31), or all are debt-type (due days are hidden
            for debt envelopes here).
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {upcomingBills.map((e) => {
              const next = nextDueDateOnOrAfter(e.due_day_of_month!, new Date())
              const days = daysUntilNextDue(e.due_day_of_month!, new Date())
              const mk = monthKeyFromDate(next)
              const paid = isBillPaidForMonth(e.bill_paid_by_month, mk)
              const busy = billPaidSavingId === e.id
              const reservedAfterDueMonth = reservedAfterMonthForEnvelope(e.id, mk)
              const availableForDueMonth = e.balance_cents - reservedAfterDueMonth
              const fundingTarget =
                e.budget_target_cents > 0
                  ? e.budget_target_cents
                  : e.goal_type === 'refill_up_to' && (e.goal_target_cents ?? 0) > 0
                    ? (e.goal_target_cents ?? 0)
                    : 0
              const funded =
                paid || (fundingTarget > 0 ? availableForDueMonth >= fundingTarget : true)
              const shortfall = fundingTarget > 0 ? Math.max(fundingTarget - availableForDueMonth, 0) : 0
              const fundingPct =
                fundingTarget > 0
                  ? Math.max(0, Math.min(100, Math.round((availableForDueMonth / fundingTarget) * 100)))
                  : 0
              const fundingTone =
                fundingTarget <= 0
                  ? 'text-zinc-500 dark:text-zinc-400'
                  : funded
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : days <= 3
                      ? 'text-red-700 dark:text-red-300'
                      : days <= 7
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-yellow-700 dark:text-yellow-300'
              const fundingBar =
                fundingTarget <= 0
                  ? 'bg-zinc-400'
                  : funded
                    ? 'bg-emerald-500'
                    : days <= 3
                      ? 'bg-red-500'
                      : days <= 7
                        ? 'bg-amber-500'
                        : 'bg-yellow-500'
              return (
                <li
                  key={e.id}
                  className="flex flex-col gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{e.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Next {format(next, 'MMM d, yyyy')} ({mk})
                      {e.budget_target_cents > 0 ? ` · target ${formatCurrencyFromCents(e.budget_target_cents)}/mo` : ''}
                    </p>
                    {paid && (
                      <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">Paid for this due month</p>
                    )}
                    <div className="mt-1.5">
                      {!paid && fundingTarget > 0 ? (
                        <>
                          <p className={['text-xs font-medium', fundingTone].join(' ')}>
                            Funding for {mk}: {formatCurrencyFromCents(availableForDueMonth)} /{' '}
                            {formatCurrencyFromCents(fundingTarget)}
                            {funded ? ' (funded)' : ` (${formatCurrencyFromCents(shortfall)} short)`}
                          </p>
                          <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                            <div
                              className={['h-full rounded-full', fundingBar].join(' ')}
                              style={{ width: `${fundingPct}%` }}
                            />
                          </div>
                          {!funded && (
                            <p className={['mt-0.5 text-[11px]', fundingTone].join(' ')}>
                              {days <= 3
                                ? 'Urgent: due very soon and not fully funded.'
                                : days <= 7
                                  ? 'Due soon: still under target.'
                                  : 'Under target for this bill month.'}
                            </p>
                          )}
                        </>
                      ) : paid ? (
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          Funding complete for this due month.
                        </p>
                      ) : (
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          No monthly funding target set for this bill.
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-emerald-800 dark:text-emerald-200">
                      {days === 0 ? 'Due today' : days === 1 ? 'In 1 day' : `In ${days} days`}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleBillPaidForEnvelope(e, mk, !paid)}
                      className={[
                        'min-h-9 rounded-lg border px-3 text-xs font-medium',
                        paid
                          ? 'border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-200'
                          : 'border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-100',
                      ].join(' ')}
                    >
                      {busy ? '…' : paid ? 'Unmark paid' : 'Mark paid'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CollapsibleCard>

      <CollapsibleCard
        title="Subscription tracker"
        storageKey="envelopes-subscriptions"
        defaultCollapsed={subscriptionEnvelopes.length === 0}
        actions={
          <button
            type="button"
            onClick={() => void runSubscriptionAutopayNow()}
            disabled={saving || subscriptionEnvelopes.length === 0}
            className="btn-secondary px-3 text-xs"
          >
            Run autopay now
          </button>
        }
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Track recurring subscriptions by linking an envelope to a payment account. On/after the due day, autopay posts
          one payment per month (idempotent).
        </p>
        <form onSubmit={submitSubscription} className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Envelope</span>
            <select
              value={subscriptionForm.envelopeId}
              onChange={(event) => setSubscriptionForm((prev) => ({ ...prev, envelopeId: event.target.value }))}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Select envelope</option>
              {groupedEnvelopes.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.envelopes.map((envelope) => (
                    <option key={envelope.id} value={envelope.id}>
                      {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Payment account</span>
            <select
              value={subscriptionForm.accountId}
              onChange={(event) => setSubscriptionForm((prev) => ({ ...prev, accountId: event.target.value }))}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatAccountDropdownLabel(a.name, a.balance_cents)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Payee</span>
            <input
              type="text"
              value={subscriptionForm.payee}
              onChange={(event) => setSubscriptionForm((prev) => ({ ...prev, payee: event.target.value }))}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              placeholder="e.g. Netflix"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Amount</span>
            <input
              type="text"
              inputMode="decimal"
              value={subscriptionForm.amountDollars}
              onChange={(event) => setSubscriptionForm((prev) => ({ ...prev, amountDollars: event.target.value }))}
              onBlur={(event) =>
                setSubscriptionForm((prev) => ({
                  ...prev,
                  amountDollars: normalizeDollarsInput(event.target.value),
                }))
              }
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              placeholder="0.00"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Note (optional)</span>
            <input
              type="text"
              value={subscriptionForm.note}
              onChange={(event) => setSubscriptionForm((prev) => ({ ...prev, note: event.target.value }))}
              className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              placeholder="Optional memo on posted transaction"
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={subscriptionForm.autopayEnabled}
              onChange={(event) => setSubscriptionForm((prev) => ({ ...prev, autopayEnabled: event.target.checked }))}
              className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span>Auto-pay this subscription each month</span>
          </label>
          <div className="sm:col-span-2 flex flex-wrap gap-2">
            <button type="submit" disabled={saving} className="btn-primary px-4 text-sm">
              {subscriptionEditingEnvelopeId ? 'Save subscription' : 'Add subscription'}
            </button>
            {subscriptionEditingEnvelopeId && (
              <button
                type="button"
                onClick={() => {
                  setSubscriptionEditingEnvelopeId(null)
                  setSubscriptionForm({ ...DEFAULT_SUBSCRIPTION_FORM, accountId: accounts[0]?.id ?? '' })
                }}
                className="btn-secondary px-4 text-sm"
              >
                Cancel
              </button>
            )}
          </div>
        </form>

        {subscriptionEnvelopes.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No subscriptions configured yet.</p>
        ) : (
          <div className="mt-3 min-w-0 overflow-x-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-gradient-to-r from-cyan-50 to-white text-left text-xs font-semibold uppercase tracking-wide text-cyan-900 dark:border-zinc-800 dark:from-cyan-950/40 dark:to-zinc-950 dark:text-cyan-100">
                  <th className="w-[22%] p-2.5 align-top">Envelope</th>
                  <th className="w-[16%] p-2.5 align-top">Amount</th>
                  <th className="w-[14%] p-2.5 align-top">Due day</th>
                  <th className="w-[20%] p-2.5 align-top">Account</th>
                  <th className="w-[12%] p-2.5 align-top">Auto</th>
                  <th className="w-[16%] p-2.5 align-top">Actions</th>
                </tr>
              </thead>
              <tbody>
                {subscriptionEnvelopes.map((e) => {
                  const accountName = accounts.find((a) => a.id === e.subscription_account_id)?.name ?? '—'
                  return (
                    <tr key={e.id} className="border-b border-zinc-100 dark:border-zinc-800/80">
                      <td className="min-w-0 p-2.5 align-top font-medium break-words">{e.name}</td>
                      <td className="p-2.5 align-top whitespace-nowrap">
                        {e.subscription_amount_cents != null ? formatCurrencyFromCents(e.subscription_amount_cents) : '—'}
                      </td>
                      <td className="p-2.5 align-top whitespace-nowrap">{e.due_day_of_month ?? '—'}</td>
                      <td className="min-w-0 p-2.5 align-top break-words">{accountName}</td>
                      <td className="p-2.5 align-top whitespace-nowrap">{e.subscription_autopay_enabled ? 'On' : 'Off'}</td>
                      <td className="p-2.5 align-top">
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => beginSubscriptionEdit(e)} className="btn-secondary px-3 text-xs">
                            Edit
                          </button>
                          <button type="button" onClick={() => void removeSubscription(e.id)} className="btn-danger px-3 text-xs">
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard
        title="Active Envelopes"
        storageKey="envelopes-active"
        actions={
          <button
            type="button"
            onClick={() => {
              setError(null)
              setNotice(null)
              setMoveOpen(true)
            }}
            disabled={activeEnvelopes.length < 2}
            className="min-h-10 rounded-lg border border-emerald-300 px-3 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
          >
            Move Money
          </button>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Active Envelopes</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveEnvelopesViewMonth((prev) => startOfMonth(subMonths(prev, 1)))}
              className="btn-secondary px-3 text-xs"
            >
              Previous month
            </button>
            <span className="min-w-[8.5rem] text-center text-sm font-medium text-zinc-800 dark:text-zinc-100">
              {format(activeEnvelopesViewMonth, 'MMMM yyyy')}
            </span>
            <button
              type="button"
              onClick={() => setActiveEnvelopesViewMonth((prev) => startOfMonth(addMonths(prev, 1)))}
              className="btn-secondary px-3 text-xs"
            >
              Next month
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Monthly assignment progress uses paycheck allocations recorded in the month shown (balances stay live).
        </p>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading envelopes...</p>
        ) : groupedEnvelopes.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No active envelopes yet. Add your first one above.</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="mb-1 hidden gap-3 px-3.5 sm:grid sm:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_auto] sm:items-end">
              <span />
              <span className="text-right text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Spent ({format(activeEnvelopesViewMonth, 'MMM')})
              </span>
              <span className="text-right text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Availability
              </span>
              <span />
            </div>
            {groupedEnvelopes.map((group) => (
              <div
                key={group.id}
                onDragOver={(event) => {
                  event.preventDefault()
                  if (draggingEnvelopeId) setDragOverGroupId(group.id)
                }}
                onDragLeave={() => {
                  if (dragOverGroupId === group.id) setDragOverGroupId(null)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const targetGroupId = group.id === 'ungrouped' ? null : group.id
                  void dropEnvelopeOnGroup(targetGroupId)
                }}
                className={[
                  'rounded-xl transition-all',
                  dragOverGroupId === group.id && draggingEnvelopeId
                    ? 'bg-sky-50/60 ring-2 ring-dashed ring-sky-300/80 dark:bg-sky-950/20 dark:ring-sky-800/70'
                    : '',
                ].join(' ')}
              >
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{group.label}</h3>
                <div className="space-y-2">
                  {group.envelopes.map((envelope) => (
                    <div
                      key={envelope.id}
                      draggable
                      onDragStart={() => setDraggingEnvelopeId(envelope.id)}
                      onDragEnd={() => {
                        setDraggingEnvelopeId(null)
                        setDragOverEnvelopeId(null)
                        setDragOverGroupId(null)
                      }}
                      onDragOver={(event) => {
                        event.preventDefault()
                        if (draggingEnvelopeId) {
                          setDragOverEnvelopeId(envelope.id)
                          setDragOverGroupId(group.id)
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverEnvelopeId === envelope.id) setDragOverEnvelopeId(null)
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        const targetGroupId = group.id === 'ungrouped' ? null : group.id
                        void dropEnvelopeOnEnvelope(envelope.id, targetGroupId)
                      }}
                      className={[
                        'grid cursor-grab grid-cols-2 gap-x-3 gap-y-2 rounded-xl border p-3.5 transition-all active:cursor-grabbing sm:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_auto] sm:items-start sm:gap-3',
                        draggingEnvelopeId === envelope.id
                          ? 'border-emerald-400 bg-emerald-50/80 opacity-75 shadow-sm dark:border-emerald-700 dark:bg-emerald-950/30'
                          : dragOverEnvelopeId === envelope.id
                            ? 'border-sky-400 bg-sky-50/70 ring-2 ring-sky-300/70 dark:border-sky-700 dark:bg-sky-950/30 dark:ring-sky-800/60'
                            : 'border-zinc-200 dark:border-zinc-800',
                      ].join(' ')}
                    >
                      <div className="col-span-2 flex min-w-0 items-center gap-3 sm:col-span-1">
                        <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: envelope.color }} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{envelope.name}</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            {envelope.type.toUpperCase()}
                            {envelope.goal_type === 'refill_up_to' && (envelope.goal_target_cents ?? 0) > 0
                              ? ` • Refill up to ${formatCurrencyFromCents(envelope.goal_target_cents ?? 0)}`
                              : envelope.budget_target_cents > 0
                                ? ` • Assign monthly ${formatCurrencyFromCents(envelope.budget_target_cents)}`
                                : ''}
                            {envelope.due_day_of_month != null
                              ? ` • ${formatDueDayPhrase(envelope.due_day_of_month)}`
                              : ''}
                            {envelope.due_day_of_month != null
                              ? (() => {
                                  const next = nextDueDateOnOrAfter(envelope.due_day_of_month, new Date())
                                  const mk = monthKeyFromDate(next)
                                  return isBillPaidForMonth(envelope.bill_paid_by_month, mk)
                                    ? ' • Next bill: paid'
                                    : ' • Next bill: not marked paid'
                                })()
                              : ''}
                          </p>
                          {envelope.goal_type === 'refill_up_to' && (envelope.goal_target_cents ?? 0) > 0 ? (
                            <EnvelopeRefillProgress
                              balanceCents={envelope.balance_cents}
                              capCents={envelope.goal_target_cents ?? 0}
                            />
                          ) : (
                            envelope.budget_target_cents > 0 && (
                              <EnvelopeMonthlyTargetProgress
                                budgetTargetCents={envelope.budget_target_cents}
                                assignedThisMonthCents={monthlyAssignedByEnvelope[envelope.id] ?? 0}
                                assignedMonthLabel={format(activeEnvelopesViewMonth, 'MMMM yyyy')}
                              />
                            )
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 sm:hidden">
                          Spent ({format(activeEnvelopesViewMonth, 'MMM')})
                        </p>
                        <p className="text-sm font-semibold tabular-nums">
                          {formatCurrencyFromCents(spentByEnvelopeViewMonth[envelope.id] ?? 0)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 sm:hidden">
                          Availability
                        </p>
                        <div className="text-sm font-semibold tabular-nums">
                          {formatCurrencyFromCents(
                            envelope.balance_cents - (futureAssignedAfterViewByEnvelope[envelope.id] ?? 0),
                          )}
                        </div>
                        {(futureAssignedAfterViewByEnvelope[envelope.id] ?? 0) > 0 && (
                          <p className="mt-0.5 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
                            Excludes {formatCurrencyFromCents(futureAssignedAfterViewByEnvelope[envelope.id] ?? 0)}{' '}
                            reserved for future months
                          </p>
                        )}
                      </div>
                      <div className="col-span-2 flex justify-end gap-2 sm:col-span-1 sm:justify-start">
                        <button type="button" onClick={() => beginEdit(envelope)} className="btn-secondary px-3 text-xs">
                          Edit
                        </button>
                        <button type="button" onClick={() => void archiveEnvelope(envelope.id)} className="btn-danger px-3 text-xs">
                          Archive
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>

      {envelopeAccountDeltaCents !== 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          Envelope total ({formatCurrencyFromCents(envelopeTotalCents)}) does not match account cash total (
          {formatCurrencyFromCents(cashAccountTotalCents)}). Difference:{' '}
          <span className="font-semibold">{formatCurrencyFromCents(envelopeAccountDeltaCents)}</span>.
          <button
            type="button"
            onClick={() => setReconcileOpen(true)}
            className="ml-2 inline-flex min-h-8 items-center rounded-lg border border-amber-500 px-2.5 text-xs font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
          >
            Reconcile now
          </button>
        </section>
      )}

      <CollapsibleCard title="Recent Moves" storageKey="envelopes-recent-moves">
        <h2 className="text-base font-semibold">Recent Moves</h2>
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
              onClick={() => applyMovesDatePreset(value)}
              className={[
                'min-h-10 rounded-lg border px-3 text-xs font-medium',
                movesDatePreset === value
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:max-w-xl">
          <input
            type="date"
            value={movesFromDate}
            onChange={(event) => {
              setMovesDatePreset('custom')
              setMovesFromDate(event.target.value)
            }}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <input
            type="date"
            value={movesToDate}
            onChange={(event) => {
              setMovesDatePreset('custom')
              setMovesToDate(event.target.value)
            }}
            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        {loading ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading recent moves...</p>
        ) : filteredMoves.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No money moves recorded yet.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {filteredMoves.map((move) => (
              <div
                key={move.id}
                className="flex flex-col gap-1 rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {move.from_envelope?.name ?? 'Unknown'} {'->'} {move.to_envelope?.name ?? 'Unknown'}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {format(new Date(move.created_at), 'MMM d, yyyy h:mm a')}
                    {move.reason ? ` • ${move.reason}` : ''}
                  </p>
                </div>
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                  {formatCurrencyFromCents(move.amount_cents)}
                </p>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>

      {moveOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-zinc-950/45 p-3 sm:items-center sm:justify-center">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">Move Money Between Envelopes</h3>
              <button
                type="button"
                onClick={() => setMoveOpen(false)}
                className="min-h-10 rounded-lg px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Close
              </button>
            </div>

            <form onSubmit={submitMove} className="space-y-3">
              <label className="text-sm">
                <span className="mb-1 block text-zinc-700 dark:text-zinc-300">From Envelope</span>
                <select
                  value={moveForm.fromEnvelopeId}
                  onChange={(event) => setMoveForm((prev) => ({ ...prev, fromEnvelopeId: event.target.value }))}
                  className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                >
                  <option value="">Select source envelope</option>
                  {groupedEnvelopes.map((group) => (
                    <optgroup key={group.id} label={group.label}>
                      {group.envelopes.map((envelope) => (
                        <option key={envelope.id} value={envelope.id}>
                          {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <label className="text-sm">
                <span className="mb-1 block text-zinc-700 dark:text-zinc-300">To Envelope</span>
                <select
                  value={moveForm.toEnvelopeId}
                  onChange={(event) => setMoveForm((prev) => ({ ...prev, toEnvelopeId: event.target.value }))}
                  className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                >
                  <option value="">Select destination envelope</option>
                  {groupedEnvelopes.map((group) => (
                    <optgroup key={group.id} label={group.label}>
                      {group.envelopes.map((envelope) => (
                        <option key={envelope.id} value={envelope.id} disabled={envelope.id === moveForm.fromEnvelopeId}>
                          {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
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
                  value={moveForm.amountDollars}
                  onChange={(event) => setMoveForm((prev) => ({ ...prev, amountDollars: event.target.value }))}
                  onBlur={(event) =>
                    setMoveForm((prev) => ({
                      ...prev,
                      amountDollars: normalizeDollarsInput(event.target.value),
                    }))
                  }
                  placeholder="0.00"
                  className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              <label className="text-sm">
                <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Reason (optional)</span>
                <input
                  type="text"
                  value={moveForm.reason}
                  onChange={(event) => setMoveForm((prev) => ({ ...prev, reason: event.target.value }))}
                  placeholder="e.g. Rebalanced groceries and dining"
                  className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
                />
              </label>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? 'Moving...' : 'Move Funds'}
                </button>
                <button
                  type="button"
                  onClick={() => setMoveOpen(false)}
                  className="min-h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium dark:border-zinc-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {reconcileOpen && envelopeAccountDeltaCents !== 0 && (
        <div className="fixed inset-0 z-50 flex items-end bg-zinc-950/45 p-3 sm:items-center sm:justify-center">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">Reconcile envelope totals</h3>
              <button
                type="button"
                onClick={() => {
                  setReconcileOpen(false)
                  setReconcileDismissedForDeltaCents(envelopeAccountDeltaCents)
                }}
                className="min-h-10 rounded-lg px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Close
              </button>
            </div>
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              Accounts total: <span className="font-semibold">{formatCurrencyFromCents(cashAccountTotalCents)}</span>
              <br />
              Envelopes total: <span className="font-semibold">{formatCurrencyFromCents(envelopeTotalCents)}</span>
              <br />
              Difference to apply: <span className="font-semibold">{formatCurrencyFromCents(envelopeAccountDeltaCents)}</span>
            </p>
            <label className="mt-4 block text-sm">
              <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Apply difference to envelope</span>
              <select
                value={reconcileEnvelopeId}
                onChange={(event) => setReconcileEnvelopeId(event.target.value)}
                className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
              >
                {groupedEnvelopes.map((group) => (
                  <optgroup key={group.id} label={group.label}>
                    {group.envelopes.map((envelope) => (
                      <option key={envelope.id} value={envelope.id}>
                        {formatEnvelopeDropdownLabel(envelope.name, envelope.balance_cents)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void applyEnvelopeTotalReconciliation()}
                disabled={saving || !reconcileEnvelopeId}
                className="min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? 'Applying...' : 'Apply Reconciliation'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setReconcileOpen(false)
                  setReconcileDismissedForDeltaCents(envelopeAccountDeltaCents)
                }}
                className="min-h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium dark:border-zinc-700"
              >
                Dismiss for now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function EnvelopeMonthlyTargetProgress({
  budgetTargetCents,
  assignedThisMonthCents,
  assignedMonthLabel,
}: {
  budgetTargetCents: number
  assignedThisMonthCents: number
  assignedMonthLabel: string
}) {
  const target = budgetTargetCents
  const assigned = assignedThisMonthCents

  const remainderClause =
    target <= 0
      ? '(no monthly dollar target set)'
      : assigned < target
        ? `(${formatCurrencyFromCents(target - assigned)} to go)`
        : assigned === target
          ? '(goal met)'
          : `(${formatCurrencyFromCents(assigned - target)} over goal)`

  const caption = `Assigned in ${assignedMonthLabel}: ${formatCurrencyFromCents(assigned)} / ${formatCurrencyFromCents(target)} ${remainderClause}`

  const percent =
    target > 0 ? Math.max(0, Math.min(100, Math.round((assigned / target) * 100))) : assigned > 0 ? 100 : 0

  const barClass = assigned >= target && target > 0 ? 'bg-emerald-500' : target > 0 ? 'bg-amber-500' : 'bg-zinc-400'

  return (
    <div className="mt-1.5">
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{caption}</p>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function EnvelopeRefillProgress({ balanceCents, capCents }: { balanceCents: number; capCents: number }) {
  const target = capCents
  const filled = Math.min(Math.max(balanceCents, 0), target)
  const headroom = Math.max(target - balanceCents, 0)
  const caption = `Balance ${formatCurrencyFromCents(balanceCents)} / cap ${formatCurrencyFromCents(target)} (${formatCurrencyFromCents(headroom)} headroom)`
  const percent = target > 0 ? Math.max(0, Math.min(100, Math.round((filled / target) * 100))) : 0

  return (
    <div className="mt-1.5">
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{caption}</p>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div className="h-full rounded-full bg-sky-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
