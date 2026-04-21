import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { formatCurrencyFromCents } from '../../lib/currency'

export type PieSlice = { name: string; value: number }

const COLORS = [
  '#059669',
  '#0ea5e9',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#db2777',
  '#64748b',
  '#14b8a6',
  '#78716c',
  '#4f46e5',
]

type Props = {
  title: string
  slices: PieSlice[]
  /** Cents in slice values */
  valueLabel?: string
}

export function SpendingPieChart({ title, slices, valueLabel = 'Amount' }: Props) {
  const data = slices.filter((s) => s.value > 0)
  if (data.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Nothing to chart for this range.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      <div className="mt-1 h-[240px] w-full min-w-0 print:hidden">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="48%"
              innerRadius={52}
              outerRadius={86}
              paddingAngle={1.5}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="rgba(15,23,42,0.06)" strokeWidth={1} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) => [formatCurrencyFromCents(value), valueLabel]}
              contentStyle={{
                borderRadius: 8,
                border: '1px solid #e4e4e7',
                fontSize: 12,
              }}
            />
            <Legend verticalAlign="bottom" height={28} wrapperStyle={{ fontSize: 11, color: '#3f3f46' }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-center text-[11px] text-zinc-500 dark:text-zinc-400 print:hidden">
        Based on envelope-linked outflows (positive amounts).
      </p>
    </div>
  )
}
