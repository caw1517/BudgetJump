import { useEffect } from 'react'
import { getSupabase } from '../lib/supabase'
import { isSupabaseConfigured } from '../lib/env'
import { useAuthStore } from '../stores/authStore'

export function AuthBootstrap() {
  useEffect(() => {
    if (!isSupabaseConfigured()) {
      useAuthStore.getState().setInitialized(true)
      return
    }

    const supabase = getSupabase()

    void supabase.auth.getSession().then(({ data: { session } }) => {
      useAuthStore.getState().setSession(session)
      useAuthStore.getState().setInitialized(true)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      useAuthStore.getState().setSession(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  return null
}
