import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  quoteExtractRequestSchema,
  quoteExtractResponseSchema,
  quoteExtractionSchema,
  type QuoteExtractKind,
} from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { RFQ_GOODS_COLS, isGoodsRow } from '@/lib/mart/staged-columns'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { BudgetExceededError, boundedChatJson } from '@/lib/agent/bounded'
import { buildQuoteExtractParts, clampQuoteExtraction, emptyExtraction, isQuoteExtractEnabledFor, todayIST } from '@/lib/agent/quote-extract'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * POST /api/v1/rfq/[id]/quote/extract (S1.1 §5) — free text → quote-form
 * prefill. A bounded single-shot call (run_id null); NOTHING is submitted here.
 * Order of checks is the contract: flag gate (404) → session (401) → provider
 * (403) → agent enabled for this user (404, same body as the gate) → matched
 * and not declined (403/409, as the submit route) → rate limits → body →
 * model → server clamp → quote_extractions row.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: rfqId } = await params

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'not_a_provider' }, { status: 403 })
  if (!(await isQuoteExtractEnabledFor(admin, userId))) return NOT_FOUND()

  const { data: match } = await admin.from('rfq_matches').select('rfq_id, declined_at').eq('rfq_id', rfqId).eq('provider_id', actor.providerId).maybeSingle()
  if (!match) return NextResponse.json({ error: 'Not matched to this request' }, { status: 403 })
  if (match.declined_at) return NextResponse.json({ error: 'declined', declined_at: match.declined_at }, { status: 409 })

  const [rl1, rl2] = await Promise.all([
    enforce(limiters.quoteExtract, `quote-extract:${actor.providerId}`),
    enforce(limiters.quoteExtractHourly, `quote-extract-h:${actor.providerId}`),
  ])
  if (!rl1.ok) return tooManyRequests(rl1.retryAfter)
  if (!rl2.ok) return tooManyRequests(rl2.retryAfter)

  const parsed = quoteExtractRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { text, source } = parsed.data

  // Goods columns ONLY through the staged fragment; isGoodsRow decides the kind.
  const { data: rfqData } = await admin.from('rfqs').select('id, title, category_id' + RFQ_GOODS_COLS).eq('id', rfqId).maybeSingle()
  const rfqRow = rfqData as unknown as { id: string; kind?: string; goods_spec?: any; mart_category_slug?: string | null } | null
  if (!rfqRow) return NOT_FOUND()
  const kind: QuoteExtractKind = isGoodsRow(rfqRow) ? 'goods' : 'services'
  const { data: u } = await admin.from('users').select('preferred_locale').eq('id', userId).maybeSingle()
  const today = todayIST()
  const parts = buildQuoteExtractParts({
    text,
    rfqId,
    today,
    kind,
    unit: kind === 'goods' ? (rfqRow.goods_spec?.unit ?? null) : null,
    qty: kind === 'goods' ? (rfqRow.goods_spec?.qty ?? null) : null,
    locale: (u as any)?.preferred_locale ?? 'en',
  })
  const envelopeText = parts.untrusted?.[0]?.text ?? text

  let result
  try {
    result = await boundedChatJson(admin, {
      userId,
      feature: 'quote_extraction',
      taskClass: 'quote_extract',
      promptId: 'quote_extract',
      promptVersion: 'v1',
      schema: quoteExtractionSchema,
      parts,
      temperature: 0,
      stub: () => emptyExtraction(envelopeText),
      meta: { rfq_id: rfqId, kind, source },
    })
  } catch (e) {
    if (e instanceof BudgetExceededError) return NextResponse.json({ error: 'budget_exceeded', breach: e.breach }, { status: 429 })
    console.error('[quote/extract] gateway', (e as Error).message)
    return NextResponse.json({ error: 'extract_unavailable' }, { status: 502 })
  }

  // Server clamp after the model — rules a model output can never override.
  const fields = clampQuoteExtraction(result.data, { kind, today })

  const { data: row, error } = await admin
    .from('quote_extractions')
    .insert({
      rfq_id: rfqId,
      provider_id: actor.providerId,
      user_id: userId,
      source,
      input_text: envelopeText,
      proposed: fields,
      uncertain_fields: fields.uncertain_fields,
      model: result.model,
      stub: result.stub,
      cost_est_paise: result.costPaise,
    })
    .select('id')
    .single()
  if (error || !row) return NextResponse.json({ error: error?.message ?? 'insert_failed' }, { status: 500 })

  captureServerEvent(userId, 'agent_quote_extract_requested', { rfq_id: rfqId, kind, source, stub: result.stub, uncertain_count: fields.uncertain_fields.length, role: 'provider' })

  const body = quoteExtractResponseSchema.parse({ extraction_id: (row as { id: string }).id, fields, stub: result.stub })
  return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
