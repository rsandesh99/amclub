import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { recomputePublicStats } from '@/lib/trust/public-stats'
import { recheckGstins } from '@/lib/trust/gstin-recheck'

export const dynamic = 'force-dynamic'

/** Quotes a provider must have answered before a response time is shown to buyers.
 *  (Not exported — Next.js route modules may only export handlers/config.) */
const MIN_RESPONSE_SAMPLE = 3

/**
 * Nightly provider stats (Phase 1e). provider_profiles.median_response_minutes
 * is derived from REAL notified→quoted data (provider_score_inputs_v1,
 * rfq_matches.notified_at → quotes.created_at) behind a sample gate; below the
 * gate it is NULL and the UI renders nothing — never "0 min". Every provider is
 * rewritten on every run, so a seeded or stale value cannot survive a night.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()

  const { data: rows, error } = await admin
    .from('provider_score_inputs_v1')
    .select('provider_id, median_response_hours, response_sample_count')
  if (error) {
    console.error('[cron/provider-stats]', error)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }

  let computed = 0
  let nulled = 0
  let failed = 0
  for (const r of rows ?? []) {
    const eligible = Number(r.response_sample_count) >= MIN_RESPONSE_SAMPLE && r.median_response_hours != null
    const minutes = eligible ? Math.max(1, Math.round(Number(r.median_response_hours) * 60)) : null
    const { error: upErr } = await admin
      .from('provider_profiles')
      .update({ median_response_minutes: minutes })
      .eq('id', r.provider_id)
    if (upErr) {
      console.error('[cron/provider-stats] update failed for provider', r.provider_id, upErr.message)
      failed++
      continue
    }
    if (eligible) computed++
    else nulled++
  }

  // Experience v3 E3 (N9): individual measured stats for the gated buyer view.
  // Computed every night whatever the display switch says, so D1 can be turned
  // on with a history already in place. Never throws (0049 may be pending).
  const publicStats = await recomputePublicStats(admin).catch((e: unknown) => ({ providers: 0, written: 0, skipped: e instanceof Error ? e.message : 'failed' }))

  // F4 — GSTIN re-check (setting-gated, default off; flags, never suspends).
  const gstin = await recheckGstins(admin).catch(() => ({ enabled: true, checked: 0, flagged: 0, errors: 1 }))

  // Experience v3 E6 (FR-6.5, N38): median first-quote time per category × state
  // for the requirement form's promise line. Never throws (0053 may be pending).
  const quoteSla = await Promise.resolve(admin.rpc('refresh_quote_sla_stats'))
    .then(({ data, error: e }) => (e ? { cells: 0, error: e.message } : { cells: Number(data ?? 0) }))
    .catch(() => ({ cells: 0, error: 'failed' }))

  const result = { providers: rows?.length ?? 0, computed, nulled, failed, minSample: MIN_RESPONSE_SAMPLE, publicStats, gstin, quoteSla }
  await recordHeartbeat(admin, 'provider-stats', result)
  return NextResponse.json(result)
}
