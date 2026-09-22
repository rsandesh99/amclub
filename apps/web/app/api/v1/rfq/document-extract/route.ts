import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { RFQ_ATTACHMENT_MAX_BYTES } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { agentApiGate } from '@/lib/agent/gate'
import { isAgentEnabledForUser } from '@/lib/agent/settings'
import { runDocumentIntake } from '@/lib/agent/intake'
import { storeRfqAttachment } from '@/lib/rfq/attachments'
import { captureServerEvent } from '@/lib/analytics/server'
import { MART_ENABLED } from '@/lib/flags'

/**
 * S1.8 — document / drawing intake → prefill. 404 unless AGENT_ENABLED and the
 * buyer is cohorted for `document_intake` (agentApiGate first, then the
 * per-user switch — the dark surface is indistinguishable from a missing
 * route). One multipart `file` (≤ 10 MB; the attachment allow-list) + `mode`
 * ('service' | 'goods'; goods only while MART_ENABLED). The file is stored as an
 * RFQ attachment in the same call (the client never uploads twice); then by
 * type: image → one frontier vision call; text PDF → the text layer through the
 * same prompt (a scanned PDF is 422 `pdf_no_text`, the attachment stays);
 * STEP / DXF → the deterministic summary (no model). Every result is prefill;
 * only the Create tap on POST /api/v1/rfq confirms it.
 */

export const maxDuration = 60

export async function POST(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  if (!(await isAgentEnabledForUser(admin, 'document_intake', userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Paid-API guard (images / PDFs are frontier-tier calls): burst + hourly.
  const burst = await enforce(limiters.documentExtract, `de:${userId}`)
  if (!burst.ok) return tooManyRequests(burst.retryAfter)
  const hourly = await enforce(limiters.documentExtractHourly, `deh:${userId}`)
  if (!hourly.ok) return tooManyRequests(hourly.retryAfter)

  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return NextResponse.json({ error: 'profile_incomplete' }, { status: 403 })

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > RFQ_ATTACHMENT_MAX_BYTES + 64 * 1024) return NextResponse.json({ error: 'file_too_large' }, { status: 413 })

  const form = await request.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'file_required' }, { status: 422 })
  const mode = form.get('mode') === 'goods' ? 'goods' : 'service'
  if (mode === 'goods' && !MART_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const file = form.get('file')

  const stored = await storeRfqAttachment(admin, actor.msmeId, file instanceof File ? file : null)
  if (!stored.ok) {
    if (stored.error === 'upload_failed') return serverError('[document-extract upload]', stored.detail)
    return NextResponse.json({ error: stored.error }, { status: stored.error === 'file_too_large' ? 413 : 422 })
  }

  const out = await runDocumentIntake(admin, { userId, attachment: stored.attachment, mode })
  const attachment = { url: stored.attachment.url, name: stored.attachment.name }
  if (!out.ok) {
    captureServerEvent(userId, 'rfq_intake_document_failed', { reason: out.error, kind: stored.attachment.kind, mode })
    const status = out.error === 'budget_exceeded' ? 429 : out.error === 'extract_failed' ? 502 : 422
    // The attachment is stored either way — the buyer can still attach it to the request.
    return NextResponse.json({ error: out.error, attachment }, { status })
  }
  captureServerEvent(userId, 'rfq_intake_document', { kind: out.row.kind, doc_type: out.row.docType, mode, stub: out.row.stub, facts: out.row.facts })
  return NextResponse.json(out.result)
}
