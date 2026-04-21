import { useNavigate } from 'react-router-dom'
import { isSupabaseConfigured } from '../../lib/env'
import { getSupabase } from '../../lib/supabase'
import { useUiStore } from '../../stores/uiStore'

export function HeaderBar() {
  const navigate = useNavigate()
  const darkMode = useUiStore((s) => s.darkMode)
  const toggleDarkMode = useUiStore((s) => s.toggleDarkMode)

  async function signOut() {
    if (!isSupabaseConfigured()) {
      navigate('/login', { replace: true })
      return
    }
    await getSupabase().auth.signOut()
    navigate('/login', { replace: true })
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-zinc-200/80 bg-white/90 px-3 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/90 sm:px-4 lg:hidden">
      <span className="min-w-0 truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Budget Jump</span>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => toggleDarkMode()}
          className="flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          aria-pressed={darkMode}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {darkMode ? 'Light' : 'Dark'}
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex min-h-10 items-center justify-center rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Out
        </button>
      </div>
    </header>
  )
}
