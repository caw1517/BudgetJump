import { NavLink, useNavigate } from 'react-router-dom'
import { mainNav } from '../../navigation'
import { getSupabase } from '../../lib/supabase'
import { isSupabaseConfigured } from '../../lib/env'

function linkClassName({ isActive }: { isActive: boolean }): string {
  return [
    'flex min-h-11 items-center rounded-xl px-3 text-sm font-medium transition-all',
    isActive
      ? 'bg-emerald-50 text-emerald-900 shadow-sm dark:bg-emerald-950/40 dark:text-emerald-100'
      : 'text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800/80 dark:hover:text-white',
  ].join(' ')
}

export function DesktopSidebar() {
  const navigate = useNavigate()

  async function signOut() {
    if (!isSupabaseConfigured()) {
      navigate('/login', { replace: true })
      return
    }
    await getSupabase().auth.signOut()
    navigate('/login', { replace: true })
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-200/80 bg-white/90 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/85 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:overflow-y-auto">
      <div className="flex h-14 items-center border-b border-zinc-200/80 px-5 dark:border-zinc-800">
        <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Budget Jump</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3.5" aria-label="Primary">
        {mainNav.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={linkClassName}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-zinc-200/80 p-3.5 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
