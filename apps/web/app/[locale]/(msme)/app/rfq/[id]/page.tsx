import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { getRfqForBuyer } from '@/lib/rfq/queries'
import { Badge } from '@/components/ui/badge'
import { QuoteCompare } from '@/components/rfq/QuoteCompare'
import { formatINR } from '@/lib/format'
import { pickLocale } from '@amclub/shared'
import { getLocale } from 'next-intl/server'
import { GoodsSpecCard, type GoodsSpecView } from '@/components/mart/GoodsSpecCard'
import { getMartCategory } from '@/lib/mart/config'
import { createAdminClient } from '@/lib/supabase/server'
import { computeChoices, computeCompare, getComparePointers, isComparePointersEnabledFor, toPointerLocale } from '@/lib/rfq/compare'
import { isInClarification, rfqIsActive } from '@amclub/shared'
import { ClarificationsCard } from '@/components/rfq/ClarificationsCard'
import { QualityQuestionsCard, QualitySummary } from '@/components/rfq/QualityQuestionsCard'
import { NudgeButton } from '@/components/orders/NudgeButton'
import { compareOrderingFor } from '@/lib/score/ordering'
import { verifyChooseDecision } from '@/lib/agent/procurement'
import { AGENT_ENABLED } from '@/lib/flags'
import { getBenchmarkFor } from '@/lib/benchmarks/view'
import { isOnFor } from '@/lib/experiments'

const VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  open: 'info', quoted: 'warning', accepted: 'success', expired: 'default', cancelled: 'default',
}

export default async function BuyerRfqPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ pay?: string; d?: string }> }) {
  const { id } = await params
  const { pay, d } = await searchParams
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/app/rfq/${id}`)
  const t = await getTranslations('rfq')
  const rfq = await getRfqForBuyer(user.id, id)
  if (!rfq) notFound()
  // AMC Mart M2 — goods RFQ: category name for the spec card (row exists only when the flag is on).
  const admin = await createAdminClient()
  // S3.1 — the procurement agent's "go with B" link (?pay=<quote>&d=<decision>): the page opens its OWN confirm sheet for that
  // quote only when the decision is this buyer's approved choose_quote for this RFQ + quote. The checkout call is the
  // page's existing one, on the buyer's own tap. Anything else (a stale or forged link) is ignored.
  const payQuoteId = pay && d && AGENT_ENABLED && (await verifyChooseDecision(admin, { userId: user.id, rfqId: rfq.id, quoteId: pay, decisionId: d })) ? pay : null
  const goodsCat = rfq.kind === 'goods' && rfq.martCategorySlug ? await getMartCategory(admin, rfq.martCategorySlug) : null
  const locale = await getLocale()
  // S1.2 — deterministic flags + normalised totals (never a model); pointers only from the
  // cache here (the client loads fresh ones after mount when enabled, so the table never waits).
  const compare = computeCompare(rfq.kind, rfq.quotes)
  // E12b — Economy · Standard · Express per quote (null = no options anywhere: the screen as before).
  const choices = computeChoices(rfq.kind, rfq.quotes)
  // S2.4 — the server's order (price, or reliability-adjusted above the threshold); never a score
  const ordering = await compareOrderingFor(admin, { kind: rfq.kind, quotes: rfq.quotes, results: compare, userId: user.id, rfqId: rfq.id })
  const pointersEnabled = await isComparePointersEnabledFor(admin, user.id)
  // S3.2 — the fair price range (services; benchmark_display_enabled; null renders nothing)
  const benchmark = await getBenchmarkFor(admin, { rfqId: rfq.id, kind: rfq.kind, categorySlug: rfq.categorySlug, viewerUserId: user.id, locale })
  const pointerOutcome = pointersEnabled
    ? await getComparePointers(admin, { rfqId: rfq.id, kind: rfq.kind, quotes: rfq.quotes, results: compare, userId: user.id, locale: toPointerLocale(locale), allowModel: false })
    : null

  // E7 — compare v3 (grouped table, scope on desktop); the page widens so the table has room.
  const compareV3 = isOnFor('compare', user.id)

  const details = Object.entries(rfq.details).filter(([, v]) => v != null && String(v).trim() !== '')
  // S1.3 — derived, never a status: active RFQ with an unanswered provider question.
  const active = rfqIsActive(rfq.status) && new Date(rfq.expiresAt).getTime() > Date.now()
  const inClarification = isInClarification(rfq.status, rfq.clarifications) && active
  // S1.5 — how many quality questions the buyer answered (their answers live in details under the field key).
  const answeredCount = (rfq.quality.report?.missing ?? []).filter((m) => { const v = rfq.details[m.field]; return typeof v === 'string' && v.trim().length > 0 }).length

  return (
    <div className={`mx-auto ${compareV3 ? 'max-w-5xl' : 'max-w-2xl'} px-4 py-6 space-y-6`}>
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display text-xl font-bold">{rfq.title}</h1>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {rfq.kind === 'goods' && <Badge variant="info">{t('goods_badge')}</Badge>}
            {/* S1.3 — derived "in clarification": a chip beside the status, never a status text change. */}
            {inClarification && <Badge variant="warning">{t('clarify_awaiting_chip')}</Badge>}
            {/* S1.5 — derived "deferred": open + fanout_at NULL; a chip, never a status text change. */}
            {rfq.quality.deferred && <Badge variant="warning">{t('quality_chip_deferred')}</Badge>}
            <Badge variant={VARIANT[rfq.status] ?? 'default'}>{t(`status_${rfq.status}` as 'status_open')}</Badge>
          </div>
        </div>

        {/* RFQ pending state copy (§3.8) */}
        {(rfq.status === 'open' || rfq.status === 'quoted') && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-foreground-secondary">{t('sent_to_providers', { n: rfq.quoteCount > 0 ? rfq.quoteCount : '—' })}</p>
            {/* S2.3 — remind the matched providers (spine; once per 24 h). Held RFQs have nobody matched yet. */}
            {active && !rfq.quality.deferred && <NudgeButton subjectKind="rfq" subjectId={rfq.id} />}
          </div>
        )}

        {details.length > 0 && (
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 text-sm">
            {details.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs capitalize text-foreground-secondary">{k.replace(/_/g, ' ')}</dt>
                <dd className="font-medium">{String(v)}</dd>
              </div>
            ))}
            {(rfq.budgetMinPaise || rfq.budgetMaxPaise) && (
              <div>
                <dt className="text-xs text-foreground-secondary">{t('budget')}</dt>
                <dd className="font-medium">
                  {rfq.budgetMinPaise ? formatINR(rfq.budgetMinPaise) : '—'} – {rfq.budgetMaxPaise ? formatINR(rfq.budgetMaxPaise) : '—'}
                </dd>
              </div>
            )}
            {rfq.neededBy && (
              <div>
                <dt className="text-xs text-foreground-secondary">{t('needed_by')}</dt>
                <dd className="font-medium">{rfq.neededBy}</dd>
              </div>
            )}
          </dl>
        )}
        {/* S1.8 — attachments (signed URLs from the loader; the buyer's uploads, photos / PDFs / drawings). */}
        {rfq.attachments.length > 0 && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-xs text-foreground-secondary">{t('attachments_title')}</p>
            <ul className="mt-1 flex flex-wrap gap-2">
              {rfq.attachments.map((a) => (
                <li key={a.url}>
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center rounded-chip border border-border px-3 text-[13px] font-medium text-primary underline underline-offset-2">{a.name}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {rfq.kind === 'goods' && rfq.goodsSpec && (
        <GoodsSpecCard spec={rfq.goodsSpec as unknown as GoodsSpecView} categoryName={goodsCat ? pickLocale(goodsCat.name_i18n, locale) : null} showPhone />
      )}

      {/* S1.5 — held for the buyer's answers: the questions card instead of the compare table (nobody is matched yet). */}
      {rfq.quality.deferred && rfq.quality.report ? (
        <QualityQuestionsCard rfqId={rfq.id} report={rfq.quality.report} deadlineAt={rfq.quality.deadlineAt} />
      ) : (
        <>
          {/* After release the report stays visible, collapsed, for the buyer only. */}
          {rfq.quality.decision && <QualitySummary report={rfq.quality.report} decision={rfq.quality.decision} answeredCount={answeredCount} />}

          {/* S1.3 — questions from providers, above the compare table; answers are visible to every matched provider. */}
          <ClarificationsCard rfqId={rfq.id} role="buyer" initial={rfq.clarifications} canWrite={active} closed={!active} />

          <QuoteCompare rfq={rfq} compare={compare} pointers={pointerOutcome?.pointers ?? null} pointersEnabled={pointersEnabled} ordering={ordering} payQuoteId={payQuoteId} benchmark={benchmark} v3={compareV3} choices={choices} />
        </>
      )}
    </div>
  )
}
