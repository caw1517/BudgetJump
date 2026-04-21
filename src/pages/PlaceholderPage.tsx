import { useLocation } from 'react-router-dom'
import { pageTitleByPath } from '../navigation'

export function PlaceholderPage() {
  const { pathname } = useLocation()
  const title = pageTitleByPath[pathname] ?? 'Budget Jump'

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
      <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-xl">{title}</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">This section is not built yet. It is next on the roadmap.</p>
    </section>
  )
}
