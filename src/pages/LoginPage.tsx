import { FormEvent, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import { getSupabase } from '../lib/supabase'
import { isSupabaseConfigured } from '../lib/env'
import { useAuthStore } from '../stores/authStore'

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const session = useAuthStore((s) => s.session)
  const initialized = useAuthStore((s) => s.initialized)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (initialized && session) {
    return <Navigate to={from} replace />
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to a .env file (see .env.example).')
      return
    }

    setSubmitting(true)
    try {
      const { error: signError } = await getSupabase().auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (signError) {
        setError(signError.message)
        return
      }
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 px-4 py-6 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50 sm:py-10">
      <div className="mx-auto w-full max-w-sm flex-1">
        <div className="mb-8 text-center sm:mb-10">
          <h1 className="text-2xl font-semibold tracking-tight">Budget Jump</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Sign in with your household Supabase account.
          </p>
        </div>

        <CollapsibleCard title="Sign In" storageKey="login-form">
          <form onSubmit={onSubmit}>
          {!isSupabaseConfigured() && (
            <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              Copy <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">.env.example</code> to{' '}
              <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">.env</code> and paste your Supabase URL
              and anon key, then restart <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">npm run dev</code>.
            </p>
          )}

          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              className="mt-1.5 block min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>

          <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              className="mt-1.5 block min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base outline-none ring-emerald-500/40 focus:border-emerald-500 focus:ring-4 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>

          {error && (
            <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 flex min-h-11 w-full items-center justify-center rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
          </form>
        </CollapsibleCard>

        <p className="mt-8 text-center text-xs text-zinc-500 dark:text-zinc-500">
          Create the household user in the Supabase dashboard (Authentication → Users) with email and password.
        </p>
      </div>
    </div>
  )
}
