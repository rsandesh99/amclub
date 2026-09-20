import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { dossierDetail, getDossier } from '@/lib/agent/dossiers'

/**
 * GET /api/v1/agent/admin/dossiers/[id] (S1.4 §4d) — one dossier with the live
 * release gate and its photos (fresh 15-min signed URLs) + findings. Agent
 * surface: agentApiGate FIRST, then admin/ops.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error

  const { id } = await params
  const admin = await createAdminClient()
  const dossier = await getDossier(admin, id)
  if (!dossier) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const detail = await dossierDetail(admin, dossier)
  return NextResponse.json(detail, { headers: NO_STORE })
}
