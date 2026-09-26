import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { dpdpActionSchema } from '@amclub/shared'
import { adminMutation, isUuid, NO_STORE } from '@/lib/privacy/route-guard'
import { actOnDpdpRequest } from '@/lib/privacy/requests'
import { serverError } from '@/lib/api/errors'

/**
 * PATCH /api/v1/admin/privacy/requests/[id] { action: in_progress | done | rejected, resolution? } (ADR-030 §6).
 * done / rejected need a resolution the user reads. Done on an erasure runs the WhatsApp erasure first (messages
 * redacted, media deleted, conversations unbound, WhatsApp grants revoked; consent events and legally required business
 * records kept, which the answer says). Errors: 404 · 409 illegal_transition / changed / not_ready / no_account ·
 * 500 erasure_incomplete (nothing marked done; safe to retry). Audit-logged.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminMutation('PATCH /admin/privacy/requests/[id]')
  if (g.error) return g.error
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = dpdpActionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  try {
    const r = await actOnDpdpRequest(g.admin, request, { id, actorId: g.userId, ...parsed.data })
    if (!r.ok) {
      const status = r.error === 'not_found' ? 404 : r.error === 'erasure_incomplete' ? 500 : 409
      return NextResponse.json({ error: r.error, ...(r.erasure ? { erasure: r.erasure } : {}) }, { status, headers: NO_STORE })
    }
    return NextResponse.json({ request: r.request, erasure: r.erasure }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/privacy/requests/id]', e)
  }
}
