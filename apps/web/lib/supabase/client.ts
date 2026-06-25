import { createBrowserClient } from '@supabase/ssr'

/**
 * Supabase browser client — use in Client Components.
 * Uses the anon key and respects RLS. §2.5 rule 1.
 */
export function createClient() {
  return createBrowserClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
  )
}
