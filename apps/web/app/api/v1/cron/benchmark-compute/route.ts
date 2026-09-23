import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { computeBenchmarks } from '@/lib/benchmarks/compute'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Nightly fair price ranges (S3.2) — 04:15 UTC, after score-compute. No model: paid services orders → the pure formula
 * in @amclub/shared → price_benchmarks in one transaction (a key that fell below a gate disappears the same night).
 * Writes nothing unless `benchmark_compute_enabled`; the heartbeat still records the no-op so /admin sees the cron alive.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  try {
    const result = await computeBenchmarks(admin)
    await recordHeartbeat(admin, 'benchmark-compute', { ...result })
    return NextResponse.json(result)
  } catch (e) {
    console.error('[cron/benchmark-compute]', (e as Error).message)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
