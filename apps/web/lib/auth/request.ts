import { headers } from 'next/headers'
import { createClient as createTokenClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * Returns a Supabase client authenticated as the requesting user, working for
 * BOTH web (cookie session) and mobile (Authorization: Bearer <access_token>).
 *
 * For Bearer requests, the token is attached as a global header so PostgREST
 * uses it as the JWT — RLS then applies as that user, exactly like the cookie
 * path. Use this in API routes that mobile also calls.
 */
export async function getAuthedSupabase(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string | null
}> {
  const h = await headers()
  const authz = h.get('authorization')

  if (authz?.startsWith('Bearer ')) {
    const token = authz.slice(7)
    const client = createTokenClient(
      process.env['NEXT_PUBLIC_SUPABASE_URL']!,
      process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    )
    const { data } = await client.auth.getUser()
    // Cast: the token client is API-compatible with the cookie client for our use.
    return { supabase: client as unknown as Awaited<ReturnType<typeof createClient>>, userId: data.user?.id ?? null }
  }

  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return { supabase, userId: data.user?.id ?? null }
}
