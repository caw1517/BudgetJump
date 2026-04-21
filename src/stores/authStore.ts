import type { Session } from '@supabase/supabase-js'
import { create } from 'zustand'

type AuthState = {
  session: Session | null
  initialized: boolean
  setSession: (session: Session | null) => void
  setInitialized: (value: boolean) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  initialized: false,
  setSession: (session) => set({ session }),
  setInitialized: (initialized) => set({ initialized }),
}))
