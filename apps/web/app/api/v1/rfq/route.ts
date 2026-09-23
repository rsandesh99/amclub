import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { rfqSchema, effectiveQuoteCap } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { delegatedRunId, requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { fanoutRfq } from '@/lib/rfq/fanout'
import { isEmptyMustHaves, rfqDocumentsExpectedSchema } from '@amclub/shared'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { getAgentSetting } from '@/lib/agent/settings'
import { MART_ENABLED } from '@/lib/flags'
import { checkIntakeExtractions, linkIntakeExtractions, type IntakeRow } from '@/lib/agent/intake'
import { getMartCategory } from '@/lib/mart/config'
import { isRfqQualityEnabledFor, runRfqQualityCheck, toQualityLocale } from '@/lib/agent/rfq-quality'

const RFQ_TTL_MS = 72 * 60 * 60 * 1000

/** Create an RFQ (status 'open', 72h expiry, 7-quote cap) and fan out to matched
 *  providers. Requires a complete MSME profile (state + sector — §1.5 M5/§3.3).
 *  S1.5: with AGENT_ENABLED + agents_enabled.rfq_quality + cohort (services only)
 *  the create is TWO-PHASE — the RFQ is inserted with fanout_at NULL, checked,
 *  and either released at once (nothing to ask) or held for the buyer's answers
 *  (fanout_at stays NULL; the cron guard bounds the hold). Otherwise this route
 *  is byte-identical to before apart from fanout_at = now() on the insert. */
export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Delegated-token scope gate (no-op for ordinary sessions; ADR-009 §6).
  const scope = await requireToolScope('create_rfq')
  if (scope) return scope

  const rl = await enforce(limiters.rfqCreate, `rfq:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = rfqSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data
  // Experience v3 E6 (FR-6.3): the documents the buyer expects to share ride in
  // details; anything but a short list of keys is dropped, never stored.
  if (d.details && 'documents_expected' in d.details && !rfqDocumentsExpectedSchema.safeParse(d.details['documents_expected']).success) {
    delete d.details['documents_expected']
  }

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) {
    return NextResponse.json({ error: 'profile_incomplete' }, { status: 403 })
  }

  // S1.8 — intake rows the buyer confirms with this Create: theirs, unlinked, ≤ 4. Checked BEFORE
  // the insert (the S1.1 lesson); linked after it. Absent (every existing client) → nothing runs.
  const intakeIds = d.intake_extraction_ids ?? []
  let intakeRows: IntakeRow[] = []
  if (intakeIds.length > 0) {
    const chk = await checkIntakeExtractions(admin, userId, intakeIds)
    if (!chk.ok) return NextResponse.json({ error: chk.error }, { status: 422 })
    intakeRows = chk.rows
  }

  // §1.5 M5 / §3.3 — RFQ matching needs state + sector. Gate on them.
  const { data: profile } = await admin
    .from('msme_profiles')
    .select('state, sector')
    .eq('id', actor.msmeId)
    .maybeSingle()
  if (!profile?.state || !profile?.sector) {
    return NextResponse.json({ error: 'profile_incomplete' }, { status: 403 })
  }

  // AMC Mart M2 — goods RFQ: a Mart category + goods spec instead of a services
  // template. Does not exist while the flag is off (same hard-404 as every
  // Mart surface); the services branch below is byte-identical to before.
  let categoryId: string | null = null
  let martCategorySlug: string | null = null
  if (d.kind === 'goods') {
    if (!MART_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const cat = await getMartCategory(admin, d.mart_category_slug!)
    if (!cat || !cat.is_active || cat.bis_blocked) return NextResponse.json({ error: 'Invalid category' }, { status: 422 })
    martCategorySlug = cat.slug
  } else {
    const { data: category } = await admin
      .from('categories')
      .select('id')
      .eq('slug', d.category_slug!)
      .maybeSingle()
    if (!category) return NextResponse.json({ error: 'Invalid category' }, { status: 422 })
    categoryId = category.id
  }

  // S1.5 — two-phase only for services RFQs of an enabled, cohorted buyer. Decided
  // before the insert so the single-phase path writes fanout_at = now() in the same
  // statement (the one added column value); with the flag off no setting is read.
  const twoPhase = d.kind !== 'goods' && (await isRfqQualityEnabledFor(admin, userId))
  const nowIso = new Date().toISOString()

  const maxQuotes = effectiveQuoteCap(await getAgentSetting(admin, 'rfq_max_quotes'))
  const { data: rfq, error } = await admin
    .from('rfqs')
    .insert({
      msme_id: actor.msmeId,
      category_id: categoryId,
      ...(d.kind === 'goods' ? { kind: 'goods', mart_category_slug: martCategorySlug, goods_spec: d.goods_spec } : {}),
      title: d.title,
      details: d.details,
      attachments: d.attachments ?? [],
      budget_min_paise: d.budget_min_paise ?? null,
      budget_max_paise: d.budget_max_paise ?? null,
      needed_by: d.needed_by ?? null,
      // Phase 8b — transcript + parse when the RFQ began as voice (quality
      // review + training signal). Pure storage; matching is unaffected.
      voice_meta: d.voice_meta ?? null,
      // Experience v3 E6 (0053): written only when sent and non-empty, so a
      // database without the column is never asked to store it.
      ...(d.must_haves && !isEmptyMustHaves(d.must_haves) ? { must_haves: d.must_haves } : {}),
      status: 'open',
      // S0.4: quote cap is config (agent_settings.rfq_max_quotes, 3..7); unset => legacy 7.
      max_quotes: maxQuotes,
      quote_count: 0,
      expires_at: new Date(Date.now() + RFQ_TTL_MS).toISOString(),
      // S1.5: deferred = fanout_at NULL (never a status). Single phase stamps it now.
      fanout_at: twoPhase ? null : nowIso,
    })
    .select('id')
    .single()
  if (error || !rfq) return serverError('[rfq POST]', error)

  // S1.8 — the Create tap is the confirmation: ONE ai_decisions row (feature rfq_intake), rows linked. S3.1 — when the
  // create is the resume of a procurement run, the buyer's tap already wrote that ONE row (feature procurement_step,
  // tool create_rfq): the rows link to it instead of a second row.
  if (intakeRows.length > 0) {
    const runId = await delegatedRunId()
    const prior = runId ? ((await admin.from('ai_decisions').select('id').eq('run_id', runId).eq('tool', 'create_rfq').eq('decided_by', userId).limit(1).maybeSingle()).data as { id: string } | null) : null
    await linkIntakeExtractions(admin, {
      userId,
      rfqId: rfq.id,
      rows: intakeRows,
      existingDecisionId: prior?.id ?? null,
      final: { title: d.title, detail_keys: Object.keys(d.details ?? {}), attachments: (d.attachments ?? []).length, ...(d.voice_meta?.clarify ? { clarify: d.voice_meta.clarify } : {}) },
    }).catch((e) => console.error('[rfq intake link]', (e as Error).message))
  }

  if (!twoPhase) {
    // Fan-out (match + notify). Best-effort — the RFQ exists regardless.
    let matched = 0
    try {
      ;({ matched } = await fanoutRfq(admin, rfq.id))
    } catch (e) {
      console.error('[rfq fanout]', e)
    }
    return NextResponse.json({ rfqId: rfq.id, matched })
  }

  // Two-phase: precheck + one bounded model call → release now (nothing to ask) or hold.
  // Any failure here still releases: the buyer is never held hostage to the check.
  const { data: u } = await admin.from('users').select('preferred_locale').eq('id', userId).maybeSingle()
  try {
    const outcome = await runRfqQualityCheck(admin, { rfqId: rfq.id, userId, locale: toQualityLocale((u as { preferred_locale?: string | null } | null)?.preferred_locale) })
    return NextResponse.json({
      rfqId: rfq.id,
      matched: outcome.matched,
      quality: outcome.report,
      // model_used=false → rule-only questions (gateway error / budget breach / no key): the UI says so.
      quality_meta: { stub: outcome.stub, model_used: outcome.modelUsed },
      ...(outcome.deferred ? { deferred: true, deadline_at: outcome.deadlineAt } : {}),
    })
  } catch (e) {
    console.error('[rfq quality] check failed → releasing inline', rfq.id, e)
    const { releaseDeferredRfq } = await import('@/lib/rfq/release')
    const { matched } = await releaseDeferredRfq(admin, rfq.id, 'skipped')
    return NextResponse.json({ rfqId: rfq.id, matched })
  }
}
