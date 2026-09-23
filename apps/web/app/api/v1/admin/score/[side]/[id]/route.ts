import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { adminScoreBlock } from '@/lib/score/card'

/**
 * GET /api/v1/admin/score/{provider|buyer}/[id] (S2.4) — the admin score block for a provider or an MSME: snapshot,
 * components with raw counts, 30-day trend, the last 10 score events. Admin / ops only; buyer scores are never shown
 * anywhere else in v1 (ADR-010 §6).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ side: string; id: string }> }) {
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const { side, id } = await params
  if ((side !== 'provider' && side !== 'buyer') || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const admin = await createAdminClient()
  return NextResponse.json(await adminScoreBlock(admin, side, id), { headers: { 'Cache-Control': 'private, no-store' } })
}
