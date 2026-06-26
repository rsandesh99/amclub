import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'
import Constants from 'expo-constants'

const supabaseUrl = Constants.expoConfig?.extra?.['supabaseUrl'] as string | undefined
const supabaseAnonKey = Constants.expoConfig?.extra?.['supabaseAnonKey'] as string | undefined

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase URL or anon key not set in app.json extra. Auth and DB calls will fail.',
  )
}

/**
 * Supabase client for React Native.
 * Uses expo-secure-store for session persistence instead of localStorage.
 * Respects RLS — never use the service-role key on the client. §2.5 rule 1.
 */
export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '', {
  auth: {
    storage: {
      async getItem(key: string) {
        return SecureStore.getItemAsync(key)
      },
      async setItem(key: string, value: string) {
        await SecureStore.setItemAsync(key, value)
      },
      async removeItem(key: string) {
        await SecureStore.deleteItemAsync(key)
      },
    },
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    // PKCE so the Google OAuth deep-link returns a code we exchange for a session.
    flowType: 'pkce',
  },
})
