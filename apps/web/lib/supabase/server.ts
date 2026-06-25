import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Supabase server client — use in Server Components, Server Actions, Route Handlers.
 * Uses the anon key and respects RLS. §2.5 rule 1.
 * For admin operations that bypass RLS, use createAdminClient (never in user-reachable paths).
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Silently ignore in Server Components (cookies are read-only there)
          }
        },
      },
    },
  )
}

/**
 * Admin client that bypasses RLS. §2.5 rule 1:
 * ONLY use in server-side admin route handlers with an explicit authz check.
 * Never expose to client-reachable paths.
 */
export async function createAdminClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['SUPABASE_SERVICE_ROLE_KEY']!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {}
        },
      },
    },
  )
}
