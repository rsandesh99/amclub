import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runDataFoundations } from '@/lib/jobs/data-foundations'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** E15 nightly — data retention (search_queries 180 days, shadow_predictions 24 months) + F4 declared vs actual. */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  try {
    return NextResponse.json(await runDataFoundations(admin))
  } catch (e) {
    console.error('[cron data-foundations]', (e as Error).message)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
