import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { extractRuntimeCredential, verifyRuntimeCredential } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { createNotification } from '@/lib/notifications/create'
import { env } from '@/lib/env'

/**
 * POST /api/v1/agent/munshi/drafts/[id]/notify (S2.2) — the runtime calls this
 * after a draft is proposed: ONE in-app notification (kind munshi_draft_ready)
 * to the provider, linking to /partner/munshi. Runtime credential REQUIRED
 * (bound to the draft's run); idempotent through the draft's `delivered`
 * marker (guarded update). Never sends WhatsApp itself — the runtime does that
 * with buttons; the in-app row is the web / mobile surface's signal.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const secret = env.AGENT_RUNTIME_SECRET
  if (!secret) return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })
  const cred = extractRuntimeCredential(request.headers.get('authorization'))
  const claims = cred ? verifyRuntimeCredential(secret, cred) : null
  if (!claims) return NextResponse.json({ error: 'invalid_runtime_credential' }, { status: 401 })

  const { id } = await params
  const admin = await createAdminClient()
  // The draft's own columns first (the static Mart check reads a joined select textually), then the RFQ title.
  const { data } = await admin.from('munshi_drafts').select('id, user_id, run_id, kind, status, delivered, rfq_id').eq('id', id).is('deleted_at', null).maybeSingle()
  const row = data as { id: string; user_id: string; run_id: string | null; kind: string; status: string; delivered: Record<string, unknown> | null; rfq_id: string | null } | null
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data: rfqRow } = row.rfq_id ? await admin.from('rfqs').select('title').eq('id', row.rfq_id).maybeSingle() : { data: null }
  const d = { ...row, rfq: (rfqRow as { title: string } | null) ?? null }
  if (d.run_id && claims.runId !== d.run_id) return NextResponse.json({ error: 'run_mismatch' }, { status: 403 })
  if (claims.userId !== d.user_id) return NextResponse.json({ error: 'user_mismatch' }, { status: 403 })
  if (d.delivered?.['notification'] === true) return NextResponse.json({ ok: true, notified: false, reason: 'already_notified' })

  const title = (d.rfq?.title ?? '').slice(0, 80)
  const kind = d.kind === 'reply' ? 'reply' : d.kind === 'ask' ? 'question' : 'quote'
  await createNotification(admin, {
    userId: d.user_id,
    kind: 'munshi_draft_ready',
    titleI18n: { en: 'Munshi drafted something for you', hi: 'मुंशी ने आपके लिए एक ड्राफ्ट तैयार किया', te: 'మున్షీ మీ కోసం ఒక డ్రాఫ్ట్ సిద్ధం చేసింది' },
    bodyI18n: {
      en: `A ${kind} draft for "${title}" is waiting for your approval.`,
      hi: `"${title}" के लिए ${kind === 'quote' ? 'कोटेशन' : kind === 'question' ? 'सवाल' : 'जवाब'} का ड्राफ्ट आपकी मंज़ूरी का इंतज़ार कर रहा है।`,
      te: `"${title}" కోసం ${kind === 'quote' ? 'కొటేషన్' : kind === 'question' ? 'ప్రశ్న' : 'జవాబు'} డ్రాఫ్ట్ మీ ఆమోదం కోసం వేచి ఉంది.`,
    },
    link: '/partner/munshi',
    channels: [],
  })
  await admin.from('munshi_drafts').update({ delivered: { ...(d.delivered ?? {}), notification: true }, updated_at: new Date().toISOString() }).eq('id', d.id)
  return NextResponse.json({ ok: true, notified: true })
}
