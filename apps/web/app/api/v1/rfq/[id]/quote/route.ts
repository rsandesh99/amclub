import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { MAX_QUOTE_REVISIONS, editedExtractFields, quoteRevisionSchema, quoteSchema, type QuoteExtraction } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { delegatedRunId, requireToolScope } from '@/lib/agent/scope'
import { createSupabaseLedger } from '@amclub/agent-core'
import { QUOTE_GOODS_COLS } from '@/lib/mart/staged-columns'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { createNotification } from '@/lib/notifications/create'
import { addQuoteEvent } from '@/lib/rfq/events'
import { loadRfqRowForQuote, quoteRowColumns, quoteTermsSnapshot, resolveQuoteTerms } from '@/lib/rfq/quote-terms'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { recordAiDecision } from '@/lib/mart/events'
import { recordPriceBookEntry } from '@/lib/agent/price-book'
import { captureServerEvent } from '@/lib/analytics/server'
import { AGENT_ENABLED } from '@/lib/flags'
import { notifyText, sameText } from '@/lib/i18n/notify'

const bodySchema = quoteSchema.omit({ rfq_id: true })

/** Provider submits ONE quote on a matched, active RFQ. The N-quote cap (7) is
 *  enforced atomically via claim_quote_slot — the 8th quote is rejected (409).
 *  S1.1: an optional `extraction_id` links the provider's one-tap confirmation
 *  of a model prefill — recorded in ai_decisions (feature quote_extraction) and
 *  on the quote; the provider's Submit is still the ONLY quote write.
 *  S1.3: goods validation + price computation live in lib/rfq/quote-terms.ts,
 *  shared with PATCH (revision) — one price path, never a fork. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('submit_quote')
  if (scope) return scope
  const { id: rfqId } = await params

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })

  const rl = await enforce(limiters.quoteSubmit, `quote:${actor.providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  // S1.1 — a claimed extraction must be this provider's, for this RFQ, and not
  // yet confirmed. Checked BEFORE the slot claim so a bad id never burns a slot.
  let extraction: { id: string; proposed: QuoteExtraction } | null = null
  if (d.extraction_id) {
    const { data: ex } = await admin.from('quote_extractions').select('id, rfq_id, provider_id, decision_id, proposed').eq('id', d.extraction_id).maybeSingle()
    const row = ex as { id: string; rfq_id: string; provider_id: string; decision_id: string | null; proposed: QuoteExtraction } | null
    if (!row || row.rfq_id !== rfqId || row.provider_id !== actor.providerId) {
      return NextResponse.json({ error: 'extraction_mismatch' }, { status: 422 })
    }
    if (row.decision_id) {
      // Own extraction, already confirmed: a re-submit is the one-quote-per-provider
      // case (409 already_quoted), never a fresh quote on a used extraction.
      const { data: dup } = await admin.from('quotes').select('id').eq('rfq_id', rfqId).eq('provider_id', actor.providerId).maybeSingle()
      return NextResponse.json({ error: dup ? 'already_quoted' : 'extraction_mismatch' }, { status: dup ? 409 : 422 })
    }
    extraction = { id: row.id, proposed: row.proposed }
  }

  // S2.2 — a Munshi draft must be this provider's, for this RFQ, and still open. Checked BEFORE the slot claim.
  let munshi: { id: string; runId: string | null } | null = null
  if (d.munshi_draft_id) {
    const { data: md } = await admin.from('munshi_drafts').select('id, rfq_id, provider_id, status, run_id').eq('id', d.munshi_draft_id).maybeSingle()
    const row = md as { id: string; rfq_id: string | null; provider_id: string; status: string; run_id: string | null } | null
    if (!row || row.rfq_id !== rfqId || row.provider_id !== actor.providerId || (row.status !== 'proposed' && row.status !== 'edited')) {
      return NextResponse.json({ error: 'munshi_draft_mismatch' }, { status: 422 })
    }
    munshi = { id: row.id, runId: row.run_id }
  }

  // AMC Mart M2 — a goods RFQ needs goods terms; the total is qty × unit price,
  // computed in the shared helper (the client's price_paise is ignored for goods).
  const rfqRow = await loadRfqRowForQuote(admin, rfqId)
  const resolved = await resolveQuoteTerms(admin, { rfqRow: rfqRow ?? { id: rfqId }, providerId: actor.providerId, body: d })
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  const { pricePaise, isGoods, goods } = resolved.value

  // Provider must be matched to this RFQ (fan-out wrote the row).
  const { data: match } = await admin
    .from('rfq_matches')
    .select('rfq_id, declined_at')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  if (!match) return NextResponse.json({ error: 'Not matched to this request' }, { status: 403 })
  // S0.4 quote-or-decline is exclusive: a declined match (provider decline or
  // window lapse) can no longer quote — enforced here, not only in the UI, so
  // mobile/direct callers cannot bypass it and the score never double-counts.
  if (match.declined_at) return NextResponse.json({ error: 'declined', declined_at: match.declined_at }, { status: 409 })

  // One quote per provider per RFQ.
  const { data: existing } = await admin
    .from('quotes')
    .select('id')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  if (existing) return NextResponse.json({ error: 'already_quoted' }, { status: 409 })

  // Atomically claim a slot (enforces cap + active + not expired; flips open→quoted).
  const { data: newCount, error: claimErr } = await admin.rpc('claim_quote_slot', { p_rfq_id: rfqId })
  if (claimErr) return serverError('[quote claim]', claimErr)
  if (newCount === null || newCount === undefined) {
    return NextResponse.json({ error: 'rfq_closed' }, { status: 409 }) // cap reached / closed / expired
  }

  const { data: quote, error: insErr } = await admin
    .from('quotes')
    .insert({
      rfq_id: rfqId,
      provider_id: actor.providerId,
      // Price, terms (absent → NULL "not stated") and goods columns from the ONE resolution.
      ...quoteRowColumns(resolved.value, d),
      status: 'submitted',
    })
    .select('id')
    .single()
  if (insErr || !quote) {
    // Lost a race (e.g. unique violation) — give the slot back so the count is honest.
    await admin.rpc('release_quote_slot', { p_rfq_id: rfqId })
    if ((insErr as { code?: string })?.code === '23505') {
      return NextResponse.json({ error: 'already_quoted' }, { status: 409 })
    }
    return serverError('[quote insert]', insErr)
  }

  // S1.1 — the provider's one-tap confirmation of a model prefill: link the
  // extraction to the quote, diff proposed vs final, record ONE ai_decisions
  // row (best-effort telemetry; the quote is already the provider's).
  let editedFields: string[] | null = null
  if (extraction) {
    const finalTerms = {
      price_paise: pricePaise,
      delivery_days: d.delivery_days,
      ...resolved.value.terms,
      goods: goods ? { unit_price_paise: goods.unit_price_paise, gst_rate_bps: goods.gst_rate_bps, hsn_code: goods.hsn_code } : null,
    }
    editedFields = editedExtractFields(extraction.proposed, finalTerms, isGoods ? 'goods' : 'services')
    const now = new Date().toISOString()
    const { error: linkErr } = await admin.from('quotes').update({ extraction_id: extraction.id, extraction_confirmed_at: now, updated_at: now }).eq('id', quote.id)
    if (linkErr) console.error('[quote submit] extraction link failed', linkErr.message)
    const decisionId = await recordAiDecision(
      admin,
      actor.userId,
      {
        feature: 'quote_extraction',
        input_refs: { extraction_id: extraction.id, rfq_id: rfqId, quote_id: quote.id },
        proposed: extraction.proposed as unknown as Record<string, unknown>,
        final: finalTerms as unknown as Record<string, unknown>,
      },
      { runId: null, tool: 'extract_quote' },
    )
    if (decisionId) {
      const { error: decErr } = await admin.from('quote_extractions').update({ decision_id: decisionId }).eq('id', extraction.id)
      if (decErr) console.error('[quote submit] extraction decision link failed', decErr.message)
    } else {
      console.error('[quote submit] ai_decisions row not recorded for extraction', extraction.id)
    }
  }

  // S2.2 — link the Munshi draft: the delegated run's submit (Bearer bound to the draft's run) is the provider's
  // approval; a submit from the composer is an edit, and the parked run is declined (reason 'edited') — never resumed.
  if (munshi) {
    // The run's own submit: the bearer is bound to the draft's run (the delegated token, prod) — or the same fact
    // read from the ledger: the run was resumed (running) on an approved submit_quote decision. The composer path
    // has neither (the run is still parked, no decision), so it is an edit.
    const runId = await delegatedRunId()
    const ledger = createSupabaseLedger(admin)
    const run = munshi.runId ? await ledger.getRun(munshi.runId) : null
    const approved = munshi.runId ? await ledger.hasApprovedDecision({ runId: munshi.runId, tool: 'submit_quote' }) : false
    const viaRun = (!!runId && runId === munshi.runId) || (run?.status === 'running' && approved)
    const now = new Date().toISOString()
    const { error: mErr } = await admin.from('quotes').update({ munshi_draft_id: munshi.id, updated_at: now }).eq('id', quote.id)
    if (mErr) console.error('[quote submit] munshi link failed', mErr.message)
    const { error: dErr } = await admin
      .from('munshi_drafts')
      .update({ status: viaRun ? 'approved' : 'edited', result_ref: { quote_id: quote.id, via: viaRun ? 'run' : 'composer' }, updated_at: now })
      .eq('id', munshi.id)
      .in('status', ['proposed', 'edited'])
    if (dErr) console.error('[quote submit] munshi draft status failed', dErr.message)
    if (!viaRun && munshi.runId) {
      try {
        if (run?.status === 'awaiting_confirmation') {
          await ledger.appendEvent({ runId: munshi.runId, kind: 'declined', tool: 'submit_quote', actor: 'user', payload: { reason: 'edited', quote_id: quote.id } })
          await ledger.transitionRun(munshi.runId, 'awaiting_confirmation', 'cancelled')
        }
      } catch (e) {
        console.warn('[quote submit] munshi run decline', (e as Error).message)
      }
    }
    captureServerEvent(actor.userId, 'munshi_draft_decided', { via: viaRun ? 'run' : 'composer', outcome: viaRun ? 'approved' : 'edited', kind: 'quote' })
  }

  await addQuoteEvent(admin, {
    quoteId: quote.id,
    eventType: 'submitted',
    actor: actor.userId,
    // History captures what was STATED at submission, including "not stated".
    payload: {
      rfq_id: rfqId,
      ...quoteTermsSnapshot(resolved.value, d),
      ...(extraction ? { extraction_id: extraction.id, edited_fields: editedFields ?? [] } : {}),
    },
  })

  // S1.1 — price-book intake for EVERY submitted quote while the agent flag is
  // on (flag-off stays byte-identical). Data, not money; failures only logged.
  if (AGENT_ENABLED) await recordPriceBookEntry(admin, { quoteId: quote.id })

  // Notify the buyer of the new quote.
  const rfq = await loadRfqForNotify(admin, rfqId)
  if (rfq?.buyerUserId) {
    await createNotification(admin, {
      userId: rfq.buyerUserId,
      kind: 'rfq_new_quote',
      titleI18n: notifyText('new_quote.title'),
      bodyI18n: sameText(rfq.title),
      link: `/app/rfq/${rfqId}`,
      channels: ['sms'],
    })
  }

  return NextResponse.json({ quoteId: quote.id, quoteCount: newCount, ...(extraction ? { extraction_id: extraction.id, edited_fields: editedFields ?? [] } : {}) })
}

/**
 * S1.3 — provider REVISES their own submitted quote in place. Not a status
 * change (`quotes.status` stays `submitted`; QUOTE_TRANSITIONS is untouched):
 * every field is restated, `revision` increments under an optimistic lock, the
 * before/after lands in quote_events ('revised'), the price book tracks the
 * latest stated price, and the buyer is told. Same terms/price path as POST.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('revise_quote')
  if (scope) return scope
  const { id: rfqId } = await params

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })

  const rl = await enforce(limiters.quoteSubmit, `quote:${actor.providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = quoteRevisionSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  // Own quote on this RFQ, still submitted.
  const { data: mine } = await admin
    .from('quotes')
    .select('id, status, revision, price_paise, delivery_days, scope, message, gst_included, transport_included, valid_until, advance_percent' + QUOTE_GOODS_COLS)
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = mine as any
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (!q) return NextResponse.json({ error: 'quote_not_found' }, { status: 404 })
  if (q.status !== 'submitted') return NextResponse.json({ error: 'quote_not_revisable', status: q.status }, { status: 409 })

  // RFQ still active and inside its window (the 72-hour clock never pauses).
  const { data: rfqState } = await admin.from('rfqs').select('id, status, expires_at').eq('id', rfqId).maybeSingle()
  const active = !!rfqState && (rfqState.status === 'open' || rfqState.status === 'quoted') && new Date(rfqState.expires_at).getTime() > Date.now()
  if (!active) return NextResponse.json({ error: 'rfq_closed' }, { status: 409 })

  const currentRevision = Number(q.revision ?? 1)
  if (currentRevision >= MAX_QUOTE_REVISIONS) return NextResponse.json({ error: 'revision_cap', revision: currentRevision, max: MAX_QUOTE_REVISIONS }, { status: 409 })

  // ONE terms/price path with POST (goods validation + qty × unit price).
  const rfqRow = await loadRfqRowForQuote(admin, rfqId)
  const resolved = await resolveQuoteTerms(admin, { rfqRow: rfqRow ?? { id: rfqId }, providerId: actor.providerId, body: d })
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  const before = {
    price_paise: Number(q.price_paise),
    delivery_days: q.delivery_days,
    gst_included: q.gst_included ?? null,
    transport_included: q.transport_included ?? null,
    valid_until: q.valid_until ?? null,
    advance_percent: q.advance_percent ?? null,
    ...(q.unit_price_paise != null ? { goods: { unit_price_paise: Number(q.unit_price_paise), qty: q.qty, gst_rate_bps: q.gst_rate_bps, hsn_code: q.hsn_code, product_id: q.product_id ?? null } } : {}),
  }
  const after = quoteTermsSnapshot(resolved.value, d)
  const nextRevision = currentRevision + 1
  const now = new Date().toISOString()

  // Optimistic lock: only the row we read (status + revision) moves; zero rows = a concurrent revision or a status change.
  const { data: moved, error: updErr } = await admin
    .from('quotes')
    .update({ ...quoteRowColumns(resolved.value, d), revision: nextRevision, revised_at: now, updated_at: now })
    .eq('id', q.id)
    .eq('status', 'submitted')
    .eq('revision', currentRevision)
    .select('id')
  if (updErr) return serverError('[quote revise]', updErr)
  if (!moved || moved.length === 0) return NextResponse.json({ error: 'revision_conflict' }, { status: 409 })

  await addQuoteEvent(admin, {
    quoteId: q.id,
    eventType: 'revised',
    actor: actor.userId,
    payload: { rfq_id: rfqId, revision: nextRevision, before, after },
  })

  // S1.1 price book: upsert on source_quote_id now UPDATES, so the book tracks the latest stated price.
  if (AGENT_ENABLED) await recordPriceBookEntry(admin, { quoteId: q.id })

  const rfq = await loadRfqForNotify(admin, rfqId)
  if (rfq?.buyerUserId) {
    await createNotification(admin, {
      userId: rfq.buyerUserId,
      kind: 'quote_revised',
      titleI18n: notifyText('quote_revised.title'),
      bodyI18n: sameText(rfq.title),
      link: `/app/rfq/${rfqId}`,
      channels: ['sms'],
    })
  }

  const delta = resolved.value.pricePaise - before.price_paise
  captureServerEvent(actor.userId, 'quote_revised', { rfq_id: rfqId, quote_id: q.id, revision: nextRevision, price_delta_sign: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same', role: 'provider' })

  return NextResponse.json({ quoteId: q.id, revision: nextRevision })
}

async function loadRfqForNotify(admin: Awaited<ReturnType<typeof createAdminClient>>, rfqId: string): Promise<{ title: string; buyerUserId: string | null } | null> {
  const { data } = await admin.from('rfqs').select('title, msme:msme_profiles!inner(user_id)').eq('id', rfqId).maybeSingle()
  if (!data) return null
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const r = data as any
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { title: r.title as string, buyerUserId: (r.msme?.user_id as string | undefined) ?? null }
}
