import { NextResponse } from 'next/server'
import type { ProfileMeResponse } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { getProviderReadiness } from '@/lib/payments/readiness-server'
import { MART_ENABLED } from '@/lib/flags'
import { isQuoteExtractEnabledFor } from '@/lib/agent/quote-extract'
import { isComparePointersEnabledFor } from '@/lib/rfq/compare'
import { isOnboardingEnabledFor } from '@/lib/agent/onboarding'
import { isMunshiEnabledFor } from '@/lib/agent/munshi'
import { isSupportEnabledFor } from '@/lib/support/settings'
import { isProcurementEnabledFor } from '@/lib/agent/procurement'
import { isOnFor } from '@/lib/experiments'
import { providerProfileGaps } from '@amclub/shared'

/** S2.4 — the slugs of the categories the provider lists (their own rows). */
async function providerCategorySlugs(admin: Awaited<ReturnType<typeof createAdminClient>>, providerId: string): Promise<string[]> {
  const { data } = await admin.from('provider_categories').select('category:categories!inner(slug)').eq('provider_id', providerId)
  return ((data ?? []) as unknown as { category: { slug: string } | null }[]).map((r) => r.category?.slug).filter((s): s is string => !!s)
}

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
  const [{ data: u }, { data: msmeRow }, { data: provider }] = await Promise.all([
    admin.from('users').select('roles, full_name').eq('id', userId).maybeSingle(),
    admin.from('msme_profiles').select('id, deleted_at').eq('user_id', userId).maybeSingle(),
    admin.from('provider_profiles').select('id, status, about, logo_url, city, state, languages, years_experience').eq('user_id', userId).maybeSingle(),
  ])
  const roles: string[] = u?.roles ?? ['msme']
  // P0-8 — a suspended buyer profile is not an active buyer identity.
  const msmeSuspended = Boolean(msmeRow?.deleted_at)
  const msme = msmeRow && !msmeRow.deleted_at ? msmeRow : null

  // Phase 3b (ii): mobile shows the same payout-hold banner as web.
  const payoutReadiness = provider ? (await getProviderReadiness(admin, provider.id)).readiness : null
  // S1.1 — quote extraction for THIS user (flag + agent switch + cohort); providers only.
  const quoteExtractEnabled = provider ? await isQuoteExtractEnabledFor(admin, userId) : false
  // S1.2 — compare pointers for buyers only (flags themselves need no flag).
  const comparePointersEnabled = msme ? await isComparePointersEnabledFor(admin, userId) : false
  // S1.6 — "Finish on WhatsApp" for users who can still run the provider wizard (no profile, or rejected / pending_kyc).
  const canOnboard = !provider || provider.status === 'rejected' || provider.status === 'pending_kyc'
  const onboardingWhatsAppEnabled = canOnboard ? await isOnboardingEnabledFor(admin, userId) : false
  // S2.2 — the Munshi partner tab for active providers (flag + agent switch + cohort).
  const munshiEnabled = provider ? await isMunshiEnabledFor(admin, userId) : false
  // S2.3 — the Support chat for anyone with a profile (flag + agent switch + cohort).
  const supportEnabled = msme || provider ? await isSupportEnabledFor(admin, userId) : false
  // S3.1 — the procurement assistant for active buyers (flag + agent switch + cohort); a suspended buyer never
  const procurementEnabled = msme ? await isProcurementEnabledFor(admin, userId) : false

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
    msmeSuspended,
    hasProviderProfile: !!provider,
    providerStatus: provider?.status ?? null,
    payoutReadiness,
    // S2.3 — server-authoritative Mart flag delivery (mobile cannot dark-toggle
    // a build-time env; it reads this field). No client branches on it yet.
    martEnabled: MART_ENABLED,
    quoteExtractEnabled,
    comparePointersEnabled,
    onboardingWhatsAppEnabled,
    munshiEnabled,
    supportEnabled,
    procurementEnabled,
    homeV3Enabled: isOnFor('home', userId),
    // E7 — compare v3 for THIS user; the mobile compare cards carry the web's groups.
    compareV3Enabled: isOnFor('compare', userId),
    // S2.4 — the caller's own listing facts (Munshi's weekly growth nudge reads them under the provider's token)
    providerProfileGaps: provider ? providerProfileGaps(provider as Parameters<typeof providerProfileGaps>[0]) : null,
    providerState: provider ? ((provider as { state?: string | null }).state ?? null) : null,
    providerCategorySlugs: provider ? await providerCategorySlugs(admin, provider.id) : null,
  }
  return NextResponse.json(
    body,
    // Role/profile state drives routing — a heuristically-cached stale answer
    // right after becoming a provider (or signing out) misroutes the client.
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
