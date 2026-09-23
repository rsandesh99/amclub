import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'

/**
 * POST /api/v1/admin/verifications/[id]/legal-name (PRD Experience v3 E10,
 * FR-10.3) — the legal name is locked to the GST record in the v3 wizard; an
 * admin may override it here (e.g. the registry holds an old name). Pending
 * applications only; audit-logged with before / after.
 */
const bodySchema = z.object({ legalName: z.string().trim().min(2).max(200), reason: z.string().trim().min(3).max(500) })

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const { data: p } = await admin.from('provider_profiles').select('id, legal_name, status').eq('id', id).maybeSingle()
  if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (p.status !== 'under_review' && p.status !== 'pending_kyc') return NextResponse.json({ error: 'not_pending', code: 'not_pending' }, { status: 409 })
  const { error } = await admin.from('provider_profiles').update({ legal_name: parsed.data.legalName }).eq('id', id)
  if (error) return NextResponse.json({ error: 'update_failed' }, { status: 500 })
  await writeAudit(admin, request, { actorId: gate.userId, action: 'provider_legal_name_overridden', entity: 'provider_profiles', entityId: id, before: { legal_name: p.legal_name }, after: { legal_name: parsed.data.legalName, reason: parsed.data.reason } })
  return NextResponse.json({ ok: true })
}
