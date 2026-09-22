import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mergeQualityReport, rfqQualityDeadline, rfqQualityPrecheck, rfqQualityReportSchema, type RfqQualityLocale, type RfqQualityModelOutput, type RfqQualityReport, type RfqTemplate } from '@amclub/shared'
import { buildRfqQualityParts, rfqQualityModelOutputSchema } from '@amclub/agent-core'
import { AGENT_ENABLED } from '@/lib/flags'
import { getAgentSetting, isAgentEnabledForUser } from '@/lib/agent/settings'
import { BudgetExceededError, boundedChatJson } from '@/lib/agent/bounded'
import { todayIST } from '@/lib/agent/quote-extract'
import { releaseDeferredRfq } from '@/lib/rfq/release'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * S1.5 — RFQ Quality: pre-fan-out completeness. Deterministic gaps are shared
 * code (rfqQualityPrecheck); ONE bounded model call judges specificity and
 * writes questions in the buyer's locale; mergeQualityReport enforces the
 * union rule. The model never fans out, never edits details, never blocks:
 * any gateway error or budget breach yields a rule-only report, a complete
 * report releases immediately, and the cron guard bounds the hold.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const RFQ_QUALITY_HOLD_DEFAULT_MINUTES = 30

/** AGENT_ENABLED + agents_enabled.rfq_quality + cohort — for THIS buyer. */
export async function isRfqQualityEnabledFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!AGENT_ENABLED) return false
  return isAgentEnabledForUser(admin, 'rfq_quality', userId)
}

export async function getRfqQualityHoldMinutes(admin: SupabaseClient): Promise<number> {
  const v = await getAgentSetting(admin, 'rfq_quality_hold_minutes')
  return typeof v === 'number' && Number.isFinite(v) ? v : RFQ_QUALITY_HOLD_DEFAULT_MINUTES
}

export function toQualityLocale(v: unknown): RfqQualityLocale {
  return v === 'hi' || v === 'ta' || v === 'te' ? v : 'en'
}

export interface RfqQualityCheckOutcome {
  report: RfqQualityReport
  /** true → fanout_at stays NULL and the buyer must answer / send as is (or the cron guard releases). */
  deferred: boolean
  matched: number
  deadlineAt: string | null
  stub: boolean
  modelUsed: boolean
}

export async function runRfqQualityCheck(admin: SupabaseClient, args: { rfqId: string; userId: string; locale: RfqQualityLocale }): Promise<RfqQualityCheckOutcome> {
  const { rfqId, userId, locale } = args
  const { data: r } = await admin
    .from('rfqs')
    .select('id, title, details, category_id, msme_id, budget_min_paise, budget_max_paise, needed_by, created_at, voice_meta, category:categories(slug, rfq_template)')
    .eq('id', rfqId)
    .maybeSingle()
  const rfq = r as any
  if (!rfq) throw new Error('rfq_missing')
  const template = (rfq.category?.rfq_template ?? null) as RfqTemplate | null
  const categorySlug = String(rfq.category?.slug ?? 'unknown')

  // duplicate_recent: same buyer, same category, still open, in the last 24 h, another id.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { count: dupCount } = await admin
    .from('rfqs')
    .select('id', { count: 'exact', head: true })
    .eq('msme_id', rfq.msme_id)
    .eq('category_id', rfq.category_id)
    .in('status', ['open', 'quoted'])
    .gte('created_at', since)
    .neq('id', rfqId)

  const precheck = rfqQualityPrecheck({
    categorySlug,
    template,
    title: String(rfq.title ?? ''),
    details: (rfq.details ?? {}) as Record<string, unknown>,
    budgetMinPaise: rfq.budget_min_paise == null ? null : Number(rfq.budget_min_paise),
    budgetMaxPaise: rfq.budget_max_paise == null ? null : Number(rfq.budget_max_paise),
    neededBy: rfq.needed_by ?? null,
    recentOpenSameCategory: (dupCount ?? 0) > 0,
  })
  const rulesClean = precheck.missingRequired.length === 0 && precheck.gaps.length === 0

  const parts = buildRfqQualityParts({
    rfqId,
    today: todayIST(),
    locale,
    categorySlug,
    template,
    precheck,
    title: String(rfq.title ?? ''),
    details: (rfq.details ?? {}) as Record<string, unknown>,
    voiceTranscript: typeof rfq.voice_meta?.transcript_english === 'string' ? rfq.voice_meta.transcript_english : null,
  })

  // ONE bounded call; any failure → rule-only report (the buyer is never blocked on the model).
  let model: RfqQualityModelOutput | null = null
  let stub = false
  try {
    const res = await boundedChatJson(admin, {
      userId,
      feature: 'rfq_quality',
      taskClass: 'rfq_quality',
      promptId: 'rfq_quality',
      promptVersion: 'v1',
      schema: rfqQualityModelOutputSchema,
      parts,
      temperature: 0,
      stub: () => ({ specific_enough: rulesClean, gaps: [] }),
      meta: { rfq_id: rfqId, category: categorySlug, rule_gaps: precheck.missingRequired.length + precheck.gaps.length },
    })
    model = res.data
    stub = res.stub
  } catch (e) {
    if (e instanceof BudgetExceededError) console.warn('[rfq-quality] budget exceeded → rule-only report', rfqId)
    else console.error('[rfq-quality] gateway', rfqId, (e as Error).message)
    model = null
  }

  const report = rfqQualityReportSchema.parse(mergeQualityReport(precheck, model, { locale, template }))
  const checkedAt = new Date().toISOString()
  const { error: writeErr } = await admin.from('rfqs').update({ quality_report: report, quality_checked_at: checkedAt, updated_at: checkedAt }).eq('id', rfqId)
  if (writeErr) console.error('[rfq-quality] report write failed', rfqId, writeErr.message)

  let deferred = false
  let matched = 0
  let deadlineAt: string | null = null
  if (report.complete) {
    // Nothing to ask → fan out now; 'skipped' records that the check ran and found nothing.
    ;({ matched } = await releaseDeferredRfq(admin, rfqId, 'skipped'))
  } else {
    deferred = true
    deadlineAt = rfqQualityDeadline(String(rfq.created_at), await getRfqQualityHoldMinutes(admin))
  }

  captureServerEvent(userId, 'rfq_quality_checked', {
    rfq_id: rfqId,
    complete: report.complete,
    missing_count: report.missing.length,
    rule_count: report.missing.filter((m) => m.source === 'rule').length,
    model_count: report.missing.filter((m) => m.source === 'model').length,
    risk_flags: report.risk_flags,
    stub,
    model_used: model !== null,
    deferred,
    role: 'msme',
  })

  return { report, deferred, matched, deadlineAt, stub, modelUsed: model !== null }
}

// ── Buyer decision routes share this loader ──────────────────────────────────

export interface DeferredRfqForBuyer {
  id: string
  status: string
  fanoutAt: string | null
  details: Record<string, unknown>
  report: RfqQualityReport | null
  checkedAt: string | null
  template: RfqTemplate | null
  createdAt: string
}

export type LoadDeferredResult =
  | { ok: true; rfq: DeferredRfqForBuyer }
  | { ok: false; status: 403 | 404 | 409; error: 'Not found' | 'not_the_buyer' | 'already_sent' | 'rfq_closed' }

/** The buyer's own, still-deferred RFQ — or the exact refusal the routes return. */
export async function loadDeferredRfqForBuyer(admin: SupabaseClient, msmeId: string, rfqId: string): Promise<LoadDeferredResult> {
  const { data } = await admin
    .from('rfqs')
    .select('id, msme_id, status, fanout_at, details, quality_report, quality_checked_at, created_at, category:categories(rfq_template)')
    .eq('id', rfqId)
    .is('deleted_at', null)
    .maybeSingle()
  const r = data as any
  if (!r) return { ok: false, status: 404, error: 'Not found' }
  if (r.msme_id !== msmeId) return { ok: false, status: 403, error: 'not_the_buyer' }
  if (r.fanout_at) return { ok: false, status: 409, error: 'already_sent' }
  if (r.status !== 'open') return { ok: false, status: 409, error: 'rfq_closed' }
  const parsed = rfqQualityReportSchema.safeParse(r.quality_report)
  return {
    ok: true,
    rfq: {
      id: r.id,
      status: r.status,
      fanoutAt: r.fanout_at ?? null,
      details: (r.details ?? {}) as Record<string, unknown>,
      report: parsed.success ? parsed.data : null,
      checkedAt: r.quality_checked_at ?? null,
      template: (r.category?.rfq_template ?? null) as RfqTemplate | null,
      createdAt: r.created_at,
    },
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
