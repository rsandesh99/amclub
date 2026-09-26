import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { extractRuntimeCredential, verifyRuntimeCredential } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { createNotification } from '@/lib/notifications/create'
import { env } from '@/lib/env'

/**
 * POST /api/v1/agent/munshi/reminders (S2.2) — the runtime's follow-up asks
 * the web for ONE in-app reminder (kind munshi_window_warning) that a matched
 * request's quote-or-decline window lapses within `hours_left`. Runtime
 * credential REQUIRED; the runtime keeps the once-per-match guard
 * (munshi_provider_state.munshi_reminders). The RFQ title is read under the
 * service role only to render the copy (the runtime never reads rfqs).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({ rfq_id: z.string().uuid(), hours_left: z.number().int().min(1).max(168) }).strict()

export async function POST(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const secret = env.AGENT_RUNTIME_SECRET
  if (!secret) return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })
  const cred = extractRuntimeCredential(request.headers.get('authorization'))
  const claims = cred ? verifyRuntimeCredential(secret, cred) : null
  if (!claims || claims.persona !== 'provider') return NextResponse.json({ error: 'invalid_runtime_credential' }, { status: 401 })
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const { data: rfq } = await admin.from('rfqs').select('id, title').eq('id', parsed.data.rfq_id).maybeSingle()
  if (!rfq) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const title = String((rfq as { title: string }).title).slice(0, 80)
  const h = parsed.data.hours_left
  await createNotification(admin, {
    userId: claims.userId,
    kind: 'munshi_window_warning',
    titleI18n: { en: 'A request is about to lapse', hi: 'एक माँग की अवधि समाप्त होने वाली है', te: 'ఒక అభ్యర్థన గడువు ముగియబోతోంది' },
    bodyI18n: {
      en: `"${title}" needs your quote or decline within ${h} hours.`,
      hi: `"${title}" पर ${h} घंटे में कोटेशन दें या अस्वीकार करें।`,
      te: `"${title}" కు ${h} గంటల్లో కొటేషన్ ఇవ్వండి లేదా తిరస్కరించండి.`,
    },
    // In-app only (registry): Munshi's WhatsApp comes from the agent runtime itself.
    link: `/partner/rfqs/${parsed.data.rfq_id}`,
  })
  return NextResponse.json({ ok: true })
}
