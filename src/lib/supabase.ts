import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | undefined

export function getSupabase(): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      'Supabase env missing. Create a .env file from .env.example and set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    )
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  }
  return client
}
