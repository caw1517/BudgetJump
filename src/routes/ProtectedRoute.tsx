import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

export function ProtectedRoute() {
  const location = useLocation()
  const session = useAuthStore((s) => s.session)
  const initialized = useAuthStore((s) => s.initialized)

  if (!initialized) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-50 text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
        <div className="flex flex-col items-center gap-3">
          <div
            className="h-9 w-9 animate-spin rounded-full border-2 border-zinc-300 border-t-emerald-600 dark:border-zinc-700 dark:border-t-emerald-400"
            aria-hidden
          />
          <p className="text-sm">Loading session…</p>
        </div>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}
