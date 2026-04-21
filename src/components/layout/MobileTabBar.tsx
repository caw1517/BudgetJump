import { useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { mainNav } from '../../navigation'

function tabClassName({ isActive }: { isActive: boolean }): string {
  return [
    'flex min-h-[3.25rem] flex-1 items-center justify-center rounded-xl px-2 text-[11px] font-medium leading-tight transition-all',
    isActive
      ? 'bg-emerald-50 text-emerald-800 shadow-sm dark:bg-emerald-950/50 dark:text-emerald-200 dark:shadow-none'
      : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
  ].join(' ')
}

export function MobileTabBar() {
  const [moreOpen, setMoreOpen] = useState(false)
  const { pathname } = useLocation()

  const primaryTabs = useMemo(
    () =>
      mainNav.filter(
        (item) =>
          item.to === '/' || item.to === '/envelopes' || item.to === '/transactions' || item.to === '/journal',
      ),
    [],
  )

  const moreItems = useMemo(
    () => mainNav.filter((item) => !primaryTabs.some((primaryItem) => primaryItem.to === item.to)),
    [primaryTabs],
  )

  const moreIsActive = moreItems.some((item) => pathname === item.to)

  useEffect(() => {
    setMoreOpen(false)
  }, [pathname])

  return (
    <>
      {moreOpen && (
        <button
          type="button"
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-40 bg-zinc-950/40 lg:hidden"
          aria-label="Close more menu"
        />
      )}

      {moreOpen && (
        <div
          id="mobile-more-menu"
          className="fixed inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-50 mx-3 rounded-2xl border border-zinc-200/90 bg-white/95 p-2 shadow-xl backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/95 lg:hidden"
        >
          <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">More</p>
          <div className="grid grid-cols-2 gap-1.5">
            {moreItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    'flex min-h-11 items-center justify-center rounded-lg px-2 text-xs font-medium',
                    isActive
                      ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200'
                      : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
                  ].join(' ')
                }
              >
                {shortLabel(item.label)}
              </NavLink>
            ))}
          </div>
        </div>
      )}

      <nav
        className="fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-200/80 bg-white/95 pb-[max(0.55rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/95 lg:hidden"
        aria-label="Primary"
      >
        <div className="flex gap-1.5 px-2">
          {primaryTabs.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={tabClassName}>
              <span className="text-center">{shortLabel(item.label)}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            className={[
              'flex min-h-[3.25rem] flex-1 items-center justify-center rounded-xl px-2 text-[11px] font-medium leading-tight transition-colors',
              moreOpen || moreIsActive
                ? 'bg-emerald-50 text-emerald-800 shadow-sm shadow-emerald-100/70 dark:bg-emerald-950/50 dark:text-emerald-200 dark:shadow-none'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
            ].join(' ')}
            aria-expanded={moreOpen}
            aria-controls="mobile-more-menu"
          >
            More
          </button>
        </div>
      </nav>
    </>
  )
}

function shortLabel(label: string): string {
  if (label === 'Paycheck Journal') return 'Journal'
  if (label === 'Budget vs Actual') return 'Budget'
  if (label === 'Reports') return 'Reports'
  if (label === 'Savings Goals') return 'Savings'
  if (label === 'Debt Tracker') return 'Debt'
  if (label === 'Settings') return 'Settings'
  return label
}
