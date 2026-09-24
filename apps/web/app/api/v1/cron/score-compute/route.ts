import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { computeScores } from '@/lib/score/compute'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Nightly AMC Score v1 (S2.4, ADR-010) — 15 minutes after provider-stats. No model: windowed SQL counts → the pure
 * formula in @amclub/shared → snapshots (only when changed), today's history row, score_events on a move of ≥ 1.
 * Writes nothing unless `score_compute_enabled`; the heartbeat still records the no-op so /admin sees the cron alive.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'score-compute', () => computeScores(admin))
}
