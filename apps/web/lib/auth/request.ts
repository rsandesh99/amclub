import { headers } from 'next/headers'
import { createClient as createTokenClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { touchLastSeen } from '@/lib/trust/last-seen'
import type { SessionUser } from './session'

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
    if (data.user?.id) touchLastSeen(data.user.id)
    // Cast: the token client is API-compatible with the cookie client for our use.
    return { supabase: client as unknown as Awaited<ReturnType<typeof createClient>>, userId: data.user?.id ?? null }
  }

  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  if (data.user?.id) touchLastSeen(data.user.id)
  return { supabase, userId: data.user?.id ?? null }
}

/**
 * getSessionUser() for routes the mobile app also calls (E13 native provider
 * onboarding): the same SessionUser shape and the same "no users row yet"
 * fallback, authenticated by the web cookie OR a mobile Bearer token.
 */
export async function getRequestUser(): Promise<SessionUser | null> {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return null
  const { data } = await supabase.from('users').select('id, phone, email, full_name, roles, preferred_locale').eq('id', userId).maybeSingle()
  if (!data) {
    const { data: auth } = await supabase.auth.getUser()
    const u = auth.user
    return {
      id: userId,
      phone: u?.phone ?? null,
      email: u?.email ?? null,
      fullName: (u?.user_metadata?.['full_name'] as string | undefined) ?? null,
      roles: ['msme'],
      preferredLocale: 'en',
    }
  }
  return {
    id: data.id as string,
    phone: (data.phone as string | null) ?? null,
    email: (data.email as string | null) ?? null,
    fullName: (data.full_name as string | null) ?? null,
    roles: (data.roles as string[] | null) ?? ['msme'],
    preferredLocale: (data.preferred_locale as string | null) ?? 'en',
  }
}
