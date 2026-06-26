import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'

/** Auth + profile state for routing decisions. Cookie (web) OR Bearer (mobile). */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }

  // Read via admin (server-side, already authenticated) so it works for a fresh
  // user without a public.users row and for Bearer requests.
  const admin = await createAdminClient()
  const [{ data: u }, { data: msme }, { data: provider }] = await Promise.all([
    admin.from('users').select('roles').eq('id', userId).maybeSingle(),
    admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle(),
    admin.from('provider_profiles').select('id, status').eq('user_id', userId).maybeSingle(),
  ])
  const roles: string[] = u?.roles ?? ['msme']

  const primaryRole =
    roles.includes('admin') || roles.includes('ops')
      ? 'admin'
      : provider
      ? 'provider'
      : 'msme'

  return NextResponse.json({
    authenticated: true,
    id: userId,
    role: primaryRole,
    roles,
    hasMsmeProfile: !!msme,
    hasProviderProfile: !!provider,
    providerStatus: provider?.status ?? null,
  })
}
