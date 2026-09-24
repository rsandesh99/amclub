import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { RFQ_ATTACHMENT_MAX_BYTES } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { storeRfqAttachment } from '@/lib/rfq/attachments'
import { requireNotDelegated } from '@/lib/agent/scope'

/**
 * S1.8 — RFQ attachment upload (SPINE, not flag-gated). Buyer session; one
 * multipart `file` ≤ 10 MB from the bucket allow-list (images, PDF, STEP / DXF);
 * stored privately under `<msmeId>/<uuid>.<ext>`. The reply is the reference
 * the client puts into `attachments[]` on POST /api/v1/rfq; the detail loaders
 * sign it for the buyer and matched providers. Nothing here creates an RFQ.
 */

export const maxDuration = 30

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Audit M8 — no agent tool wraps this write: a delegated token is refused.
  const delegated = await requireNotDelegated('POST /rfq/attachments')
  if (delegated) return delegated
  const rl = await enforce(limiters.authed, `rfq-att:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > RFQ_ATTACHMENT_MAX_BYTES + 64 * 1024) return NextResponse.json({ error: 'file_too_large' }, { status: 413 })

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return NextResponse.json({ error: 'profile_incomplete' }, { status: 403 })

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  const stored = await storeRfqAttachment(admin, actor.msmeId, file instanceof File ? file : null)
  if (!stored.ok) {
    if (stored.error === 'upload_failed') return serverError('[rfq attachments upload]', stored.detail)
    return NextResponse.json({ error: stored.error }, { status: stored.error === 'file_too_large' ? 413 : 422 })
  }
  return NextResponse.json({ url: stored.attachment.url, name: stored.attachment.name })
}
