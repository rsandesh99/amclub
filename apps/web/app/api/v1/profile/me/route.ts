import { NextResponse } from 'next/server'
import type { ProfileMeResponse } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { getProviderReadiness } from '@/lib/payments/readiness-server'
import { MART_ENABLED } from '@/lib/flags'
import { isQuoteExtractEnabledFor } from '@/lib/agent/quote-extract'

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
  // S1.1 — quote extraction for THIS user (flag + agent switch + cohort); providers only.
  const quoteExtractEnabled = provider ? await isQuoteExtractEnabledFor(admin, userId) : false

  const primaryRole =
    roles.includes('admin') || roles.includes('ops')
      ? 'admin'
      : provider
      ? 'provider'
      : 'msme'

  const body: ProfileMeResponse = {
    authenticated: true,
    id: userId,
    fullName: u?.full_name ?? null,
    role: primaryRole,
    roles,
    hasMsmeProfile: !!msme,
    hasProviderProfile: !!provider,
    providerStatus: provider?.status ?? null,
    payoutReadiness,
    // S2.3 — server-authoritative Mart flag delivery (mobile cannot dark-toggle
    // a build-time env; it reads this field). No client branches on it yet.
    martEnabled: MART_ENABLED,
    quoteExtractEnabled,
  }
  return NextResponse.json(
    body,
    // Role/profile state drives routing — a heuristically-cached stale answer
    // right after becoming a provider (or signing out) misroutes the client.
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
