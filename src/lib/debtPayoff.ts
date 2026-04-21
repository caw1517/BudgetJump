/**
 * Monthly amortization: interest accrues on the balance, then the full payment is applied.
 * APR is stored like the rest of the app: annual percent as (apr_bps / 1_000_000) (e.g. 24.99% → 0.2499).
 */
export type DebtPayoffSimulation = {
  months: number | null
  totalInterestCents: number
  neverReason?: string
}

/** Largest of minimum, planned (if any), and recent average — used as a monthly floor in projections. */
export function modelMonthlyPaymentCents(params: {
  minimumCents: number
  plannedCents: number | null
  avgPaymentCents: number
}): number {
  const min = Math.max(0, params.minimumCents)
  const planned = params.plannedCents != null ? Math.max(0, params.plannedCents) : 0
  const avg = Math.max(0, params.avgPaymentCents)
  return Math.max(min, planned, avg)
}

export function simulateDebtPayoff(params: {
  balanceCents: number
  aprBps: number | null
  monthlyPaymentCents: number
  maxMonths?: number
}): DebtPayoffSimulation {
  const maxMonths = params.maxMonths ?? 600
  let balance = Math.round(Math.abs(params.balanceCents))
  if (balance < 1) {
    return { months: 0, totalInterestCents: 0 }
  }

  const payment = Math.round(params.monthlyPaymentCents)
  if (payment < 1) {
    return { months: null, totalInterestCents: 0, neverReason: 'Enter a monthly payment greater than zero.' }
  }

  const annualFraction = params.aprBps != null && params.aprBps > 0 ? params.aprBps / 1_000_000 : 0
  const monthlyRate = annualFraction / 12

  let totalInterestCents = 0
  let months = 0

  while (balance > 0 && months < maxMonths) {
    months += 1
    const interestCents = Math.round(balance * monthlyRate)
    totalInterestCents += interestCents
    const principalPortion = payment - interestCents
    if (principalPortion <= 0) {
      return {
        months: null,
        totalInterestCents: totalInterestCents,
        neverReason:
          'Monthly payment does not cover interest at this APR—balance would grow. Raise payment, lower APR, or check balance sign.',
      }
    }
    balance = balance + interestCents - payment
    if (balance < 0) balance = 0
  }

  if (balance > 0) {
    return {
      months: null,
      totalInterestCents: totalInterestCents,
      neverReason: `Still not paid off after ${maxMonths} months (try raising payment or check data).`,
    }
  }

  return { months, totalInterestCents: totalInterestCents }
}

/** One line in a multi-debt combined payoff run. */
export type CombinedDebtLine = {
  id: string
  balanceCents: number
  aprBps: number | null
  /** Paid to this debt each month while it still has a balance (e.g. max(min, planned, avg)). */
  monthlyFloorCents: number
}

export type CombinedDebtPayoffSimulation = {
  months: number | null
  totalInterestCents: number
  /** Month index (1-based) when each debt first hits zero; omitted keys = never in horizon */
  payoffMonthById: Record<string, number>
  neverReason?: string
}

function monthlyRateFromAprBps(aprBps: number | null): number {
  const annualFraction = aprBps != null && aprBps > 0 ? aprBps / 1_000_000 : 0
  return annualFraction / 12
}

/**
 * Constant total cash flow to debt each month: sum(initial floors) + pooledExtra.
 * While a debt is open it receives its floor first; any remainder is allocated by strategy
 * (avalanche: highest APR first; snowball: smallest balance first). When a debt is paid off,
 * its floor drops out so the same total payment accelerates the rest (rolled snowball effect).
 */
export function simulateCombinedDebtPayoff(params: {
  debts: CombinedDebtLine[]
  strategy: 'avalanche' | 'snowball'
  pooledExtraCentsPerMonth: number
  maxMonths?: number
}): CombinedDebtPayoffSimulation {
  const maxMonths = params.maxMonths ?? 600
  const n = params.debts.length
  if (n === 0) {
    return { months: 0, totalInterestCents: 0, payoffMonthById: {} }
  }

  const floors = params.debts.map((d) => Math.max(0, Math.round(d.monthlyFloorCents)))
  const owed = params.debts.map((d) => Math.round(Math.abs(d.balanceCents)))
  const monthlyRates = params.debts.map((d) => monthlyRateFromAprBps(d.aprBps))
  const ids = params.debts.map((d) => d.id)

  if (owed.every((b) => b < 1)) {
    return { months: 0, totalInterestCents: 0, payoffMonthById: {} }
  }

  const pooled = Math.max(0, Math.round(params.pooledExtraCentsPerMonth))
  const totalMonthly = floors.reduce((a, b) => a + b, 0) + pooled
  if (totalMonthly < 1) {
    return {
      months: null,
      totalInterestCents: 0,
      payoffMonthById: {},
      neverReason: 'Enter a positive total monthly payment (sum of floors plus pooled extra).',
    }
  }

  const payoffMonthById: Record<string, number> = {}
  let totalInterestCents = 0
  let months = 0

  // Work on copies
  const O = [...owed]
  const F = [...floors]

  while (months < maxMonths) {
    if (O.every((b) => b < 1)) {
      return { months, totalInterestCents, payoffMonthById }
    }

    months += 1
    const owedBeforeInterest = [...O]
    const interest: number[] = new Array(n).fill(0)

    for (let i = 0; i < n; i++) {
      if (O[i] < 1) continue
      interest[i] = Math.round(O[i] * monthlyRates[i])
      O[i] += interest[i]
      totalInterestCents += interest[i]
    }

    let remaining = totalMonthly
    const payTo: number[] = new Array(n).fill(0)

    // Pass 1: floors (stable account order)
    for (let i = 0; i < n; i++) {
      if (O[i] < 1) continue
      const floor = F[i]
      const pay = Math.min(floor, O[i], remaining)
      O[i] -= pay
      remaining -= pay
      payTo[i] += pay
    }

    // Pass 2: pooled extra by strategy on debts still owing
    const openIdx: number[] = []
    for (let i = 0; i < n; i++) {
      if (O[i] >= 1) openIdx.push(i)
    }

    const strategy = params.strategy
    openIdx.sort((a, b) => {
      if (strategy === 'avalanche') {
        const aprA = params.debts[a]!.aprBps ?? 0
        const aprB = params.debts[b]!.aprBps ?? 0
        if (aprB !== aprA) return aprB - aprA
        if (O[b] !== O[a]) return O[b] - O[a]
        return ids[a]!.localeCompare(ids[b]!)
      }
      // snowball: smallest balance first
      if (O[a] !== O[b]) return O[a] - O[b]
      const aprA = params.debts[a]!.aprBps ?? 0
      const aprB = params.debts[b]!.aprBps ?? 0
      if (aprA !== aprB) return aprA - aprB
      return ids[a]!.localeCompare(ids[b]!)
    })

    for (const i of openIdx) {
      if (remaining < 1) break
      if (O[i] < 1) continue
      const pay = Math.min(O[i], remaining)
      O[i] -= pay
      remaining -= pay
      payTo[i] += pay
    }

    for (let i = 0; i < n; i++) {
      if (O[i] < 1 && !Object.prototype.hasOwnProperty.call(payoffMonthById, ids[i]!)) {
        payoffMonthById[ids[i]!] = months
      }
      if (owedBeforeInterest[i] >= 1 && payTo[i] < interest[i]) {
        return {
          months: null,
          totalInterestCents,
          payoffMonthById,
          neverReason:
            'Total monthly payment does not cover interest on at least one debt—balances would grow. Raise pooled extra or per-debt floors (minimum / planned / payments).',
        }
      }
    }

    for (let i = 0; i < n; i++) {
      if (O[i] < 1) O[i] = 0
    }
  }

  return {
    months: null,
    totalInterestCents,
    payoffMonthById,
    neverReason: `Still not all paid off after ${maxMonths} months (try raising pooled extra or check balances).`,
  }
}
