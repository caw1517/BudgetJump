import { PropsWithChildren, ReactNode, useEffect, useState } from 'react'

type CollapsibleCardProps = PropsWithChildren<{
  title: string
  subtitle?: string
  storageKey: string
  actions?: ReactNode
  defaultCollapsed?: boolean
  className?: string
}>

export function CollapsibleCard({
  title,
  subtitle,
  storageKey,
  actions,
  defaultCollapsed = false,
  className,
  children,
}: CollapsibleCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`budgetjump:card:${storageKey}`)
      if (raw != null) setCollapsed(raw === '1')
    } catch {
      // Ignore storage access errors and keep default behavior.
    }
  }, [storageKey])

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(`budgetjump:card:${storageKey}`, next ? '1' : '0')
      } catch {
        // Ignore storage write errors.
      }
      return next
    })
  }

  return (
    <section
      className={[
        'card-surface min-w-0 p-4 sm:p-6',
        className ?? '',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{title}</h2>
          {subtitle && <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={toggleCollapsed}
            className="btn-secondary min-h-9 px-3 text-xs"
            aria-expanded={!collapsed}
          >
            {collapsed ? 'Expand' : 'Minimize'}
          </button>
        </div>
      </div>
      {!collapsed && <div className="mt-4 min-w-0">{children}</div>}
    </section>
  )
}
