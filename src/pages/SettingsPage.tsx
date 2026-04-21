import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CollapsibleCard } from '../components/ui/CollapsibleCard'
import { isSupabaseConfigured } from '../lib/env'
import { getSupabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { useUiStore } from '../stores/uiStore'

type TotpFactor = {
  id: string
  friendly_name?: string
  status?: string
}

export function SettingsPage() {
  const navigate = useNavigate()
  const session = useAuthStore((s) => s.session)
  const darkMode = useUiStore((s) => s.darkMode)
  const toggleDarkMode = useUiStore((s) => s.toggleDarkMode)
  const configured = isSupabaseConfigured()
  const email = session?.user?.email ?? null
  const [mfaLoading, setMfaLoading] = useState(false)
  const [mfaError, setMfaError] = useState<string | null>(null)
  const [mfaNotice, setMfaNotice] = useState<string | null>(null)
  const [totpFactors, setTotpFactors] = useState<TotpFactor[]>([])
  const [enrollFactorId, setEnrollFactorId] = useState<string | null>(null)
  const [enrollQrSvg, setEnrollQrSvg] = useState<string | null>(null)
  const [enrollChallengeId, setEnrollChallengeId] = useState<string | null>(null)
  const [enrollCode, setEnrollCode] = useState('')
  const [friendlyName, setFriendlyName] = useState('Budget Jump')

  const mfaEnabled = totpFactors.some((f) => f.status === 'verified')

  const canVerifyEnroll = useMemo(
    () => Boolean(enrollFactorId && enrollChallengeId && enrollCode.trim().length >= 6),
    [enrollChallengeId, enrollCode, enrollFactorId],
  )

  const loadMfaState = useCallback(async () => {
    if (!configured) return
    setMfaLoading(true)
    setMfaError(null)
    try {
      const supabase = getSupabase()
      const { data, error } = await supabase.auth.mfa.listFactors()
      if (error) throw error
      const factors = ((data?.totp ?? []) as TotpFactor[]).sort((a, b) => a.id.localeCompare(b.id))
      setTotpFactors(factors)
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Could not load MFA status.')
    } finally {
      setMfaLoading(false)
    }
  }, [configured])

  useEffect(() => {
    void loadMfaState()
  }, [loadMfaState])

  async function signOut() {
    if (!configured) {
      navigate('/login', { replace: true })
      return
    }
    await getSupabase().auth.signOut()
    navigate('/login', { replace: true })
  }

  async function startTotpEnroll() {
    setMfaError(null)
    setMfaNotice(null)
    setMfaLoading(true)
    setEnrollFactorId(null)
    setEnrollChallengeId(null)
    setEnrollQrSvg(null)
    setEnrollCode('')
    try {
      const supabase = getSupabase()
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: friendlyName.trim() || 'Budget Jump',
      })
      if (error) throw error
      setEnrollFactorId(data.id)
      setEnrollQrSvg(data.totp.qr_code)
      const challengeResp = await supabase.auth.mfa.challenge({ factorId: data.id })
      if (challengeResp.error) throw challengeResp.error
      setEnrollChallengeId(challengeResp.data.id)
      setMfaNotice('Scan the QR in your authenticator app, then enter the 6-digit code to finish setup.')
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Could not start MFA enrollment.')
    } finally {
      setMfaLoading(false)
    }
  }

  async function verifyTotpEnroll() {
    if (!canVerifyEnroll || !enrollFactorId || !enrollChallengeId) return
    setMfaError(null)
    setMfaNotice(null)
    setMfaLoading(true)
    try {
      const supabase = getSupabase()
      const { error } = await supabase.auth.mfa.verify({
        factorId: enrollFactorId,
        challengeId: enrollChallengeId,
        code: enrollCode.trim(),
      })
      if (error) throw error
      setEnrollFactorId(null)
      setEnrollChallengeId(null)
      setEnrollQrSvg(null)
      setEnrollCode('')
      setMfaNotice('MFA is enabled for your account.')
      await loadMfaState()
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Could not verify MFA code.')
    } finally {
      setMfaLoading(false)
    }
  }

  async function removeTotpFactor(factorId: string) {
    setMfaError(null)
    setMfaNotice(null)
    setMfaLoading(true)
    try {
      const supabase = getSupabase()
      const { error } = await supabase.auth.mfa.unenroll({ factorId })
      if (error) throw error
      setMfaNotice('MFA factor removed.')
      await loadMfaState()
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : 'Could not disable MFA.')
    } finally {
      setMfaLoading(false)
    }
  }

  return (
    <div className="min-w-0 space-y-6 sm:space-y-7 xl:space-y-8">
      <section className="card-surface min-w-0 overflow-x-hidden p-4 sm:p-6">
        <h1 className="section-title">Settings</h1>
        <p className="section-subtitle max-w-2xl">
          Control how the app looks on this device and manage your session. Preferences here are stored in your browser
          unless noted otherwise.
        </p>
      </section>

      <CollapsibleCard title="Appearance" storageKey="settings-appearance" defaultCollapsed={false}>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
          <input
            type="checkbox"
            checked={darkMode}
            onChange={() => toggleDarkMode()}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-emerald-600 dark:border-zinc-600"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-50">Dark mode</span>
            <span className="mt-1 block text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
              Uses the same theme as the Light / Dark control in the header on phones and below the top bar on desktop.
              Your choice is remembered on this browser.
            </span>
          </span>
        </label>
      </CollapsibleCard>

      <CollapsibleCard title="Account" storageKey="settings-account" defaultCollapsed={false}>
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Signed in as</p>
            <p className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">{email ?? 'Unknown user'}</p>
          </div>
          {!configured && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
              Supabase is not configured in this build. Sign out will still return you to the login screen.
            </p>
          )}
          <button
            type="button"
            onClick={() => void signOut()}
            className="btn-secondary px-4 text-sm"
          >
            Sign out
          </button>
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Security (MFA)" storageKey="settings-mfa" defaultCollapsed={false}>
        {!configured ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Supabase is not configured in this build.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Add an authenticator app (TOTP) as a second factor for sign-in.
            </p>
            <p className="text-sm">
              <span className="font-medium text-zinc-800 dark:text-zinc-200">MFA status: </span>
              <span className={mfaEnabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-600 dark:text-zinc-400'}>
                {mfaEnabled ? 'Enabled' : mfaLoading ? 'Loading...' : 'Not enabled'}
              </span>
            </p>
            {mfaError && (
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-100">
                {mfaError}
              </p>
            )}
            {mfaNotice && (
              <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
                {mfaNotice}
              </p>
            )}

            {!enrollFactorId && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end">
                <label className="text-sm">
                  <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Device label (optional)</span>
                  <input
                    type="text"
                    value={friendlyName}
                    onChange={(event) => setFriendlyName(event.target.value)}
                    className="min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                    placeholder="Budget Jump"
                  />
                </label>
                <button type="button" onClick={() => void startTotpEnroll()} disabled={mfaLoading} className="btn-primary px-4 text-sm">
                  Set up authenticator
                </button>
              </div>
            )}

            {enrollFactorId && (
              <div className="space-y-3 rounded-xl border border-zinc-200 p-3.5 dark:border-zinc-800">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Step 1: Scan QR code</p>
                {enrollQrSvg ? (
                  <div
                    className="inline-block rounded-lg bg-white p-2"
                    dangerouslySetInnerHTML={{ __html: enrollQrSvg }}
                  />
                ) : (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">QR code unavailable. Retry setup.</p>
                )}
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Step 2: Enter 6-digit code</p>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-zinc-700 dark:text-zinc-300">Authenticator code</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={enrollCode}
                      onChange={(event) => setEnrollCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="min-h-11 w-40 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                      placeholder="123456"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void verifyTotpEnroll()}
                    disabled={mfaLoading || !canVerifyEnroll}
                    className="btn-primary px-4 text-sm"
                  >
                    Verify & enable
                  </button>
                </div>
              </div>
            )}

            {totpFactors.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Configured factors</p>
                {totpFactors.map((factor) => (
                  <div
                    key={factor.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {factor.friendly_name || 'Authenticator app'}
                      </p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {factor.status === 'verified' ? 'Verified' : factor.status ?? 'Unknown'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeTotpFactor(factor.id)}
                      disabled={mfaLoading}
                      className="btn-danger px-3 text-xs"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CollapsibleCard>

      <CollapsibleCard title="Data & connection" storageKey="settings-data" defaultCollapsed>
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Budget Jump reads and writes your envelopes, transactions, and accounts in your own{' '}
          <strong>Supabase</strong> project. Nothing in this screen changes server-side rules; manage roles and backups in
          the Supabase dashboard.
        </p>
        <p className="mt-3 text-sm">
          <span className="font-medium text-zinc-800 dark:text-zinc-200">API status: </span>
          {configured ? (
            <span className="text-emerald-700 dark:text-emerald-300">URL and anon key are present in this app build.</span>
          ) : (
            <span className="text-amber-800 dark:text-amber-200">Not configured (missing env vars).</span>
          )}
        </p>
      </CollapsibleCard>

      <CollapsibleCard title="About" storageKey="settings-about" defaultCollapsed>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">Budget Jump</span> — household budgeting with
          envelopes, paycheck journal, and reports. Running in <span className="font-mono text-xs">{import.meta.env.MODE}</span>{' '}
          mode in this browser.
        </p>
      </CollapsibleCard>
    </div>
  )
}
