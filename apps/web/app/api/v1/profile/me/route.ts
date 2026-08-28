import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { getProviderReadiness } from '@/lib/payments/readiness-server'

/** Auth + profile state for routing decisions. Cookie (web) OR Bearer (mobile). */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) {
    return NextResponse.json(
      { authenticated: false },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }

  // Read via admin (server-side, already authenticated) so it works for a fresh
  // user without a public.users row and for Bearer requests.
  const admin = await createAdminClient()
  const [{ data: u }, { data: msme }, { data: provider }] = await Promise.all([
    admin.from('users').select('roles, full_name').eq('id', userId).maybeSingle(),
    admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle(),
    admin.from('provider_profiles').select('id, status').eq('user_id', userId).maybeSingle(),
  ])
  const roles: string[] = u?.roles ?? ['msme']

  // Phase 3b (ii): mobile shows the same payout-hold banner as web.
  const payoutReadiness = provider ? (await getProviderReadiness(admin, provider.id)).readiness : null

  const primaryRole =
    roles.includes('admin') || roles.includes('ops')
      ? 'admin'
      : provider
      ? 'provider'
      : 'msme'

  return NextResponse.json(
    {
      authenticated: true,
      id: userId,
      fullName: u?.full_name ?? null,
      role: primaryRole,
      roles,
      hasMsmeProfile: !!msme,
      hasProviderProfile: !!provider,
      providerStatus: provider?.status ?? null,
      payoutReadiness,
    },
    // Role/profile state drives routing — a heuristically-cached stale answer
    // right after becoming a provider (or signing out) misroutes the client.
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
