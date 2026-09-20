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
import { computeCompare, getComparePointers, isComparePointersEnabledFor, toPointerLocale } from '@/lib/rfq/compare'
import { isInClarification, rfqIsActive } from '@amclub/shared'
import { ClarificationsCard } from '@/components/rfq/ClarificationsCard'

const VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  open: 'info', quoted: 'warning', accepted: 'success', expired: 'default', cancelled: 'default',
}

export default async function BuyerRfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/app/rfq/${id}`)
  const t = await getTranslations('rfq')
  const rfq = await getRfqForBuyer(user.id, id)
  if (!rfq) notFound()
  // AMC Mart M2 — goods RFQ: category name for the spec card (row exists only when the flag is on).
  const admin = await createAdminClient()
  const goodsCat = rfq.kind === 'goods' && rfq.martCategorySlug ? await getMartCategory(admin, rfq.martCategorySlug) : null
  const locale = await getLocale()
  // S1.2 — deterministic flags + normalised totals (never a model); pointers only from the
  // cache here (the client loads fresh ones after mount when enabled, so the table never waits).
  const compare = computeCompare(rfq.kind, rfq.quotes)
  const pointersEnabled = await isComparePointersEnabledFor(admin, user.id)
  const pointerOutcome = pointersEnabled
    ? await getComparePointers(admin, { rfqId: rfq.id, kind: rfq.kind, quotes: rfq.quotes, results: compare, userId: user.id, locale: toPointerLocale(locale), allowModel: false })
    : null

  const details = Object.entries(rfq.details).filter(([, v]) => v != null && String(v).trim() !== '')
  // S1.3 — derived, never a status: active RFQ with an unanswered provider question.
  const active = rfqIsActive(rfq.status) && new Date(rfq.expiresAt).getTime() > Date.now()
  const inClarification = isInClarification(rfq.status, rfq.clarifications) && active

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display text-xl font-bold">{rfq.title}</h1>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {rfq.kind === 'goods' && <Badge variant="info">{t('goods_badge')}</Badge>}
            {/* S1.3 — derived "in clarification": a chip beside the status, never a status text change. */}
            {inClarification && <Badge variant="warning">{t('clarify_awaiting_chip')}</Badge>}
            <Badge variant={VARIANT[rfq.status] ?? 'default'}>{t(`status_${rfq.status}` as 'status_open')}</Badge>
          </div>
        </div>

        {/* RFQ pending state copy (§3.8) */}
        {(rfq.status === 'open' || rfq.status === 'quoted') && (
          <p className="mt-2 text-xs text-foreground-secondary">{t('sent_to_providers', { n: rfq.quoteCount > 0 ? rfq.quoteCount : '—' })}</p>
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
      </div>

      {rfq.kind === 'goods' && rfq.goodsSpec && (
        <GoodsSpecCard spec={rfq.goodsSpec as unknown as GoodsSpecView} categoryName={goodsCat ? pickLocale(goodsCat.name_i18n, locale) : null} showPhone />
      )}

      {/* S1.3 — questions from providers, above the compare table; answers are visible to every matched provider. */}
      <ClarificationsCard rfqId={rfq.id} role="buyer" initial={rfq.clarifications} canWrite={active} closed={!active} />

      <QuoteCompare rfq={rfq} compare={compare} pointers={pointerOutcome?.pointers ?? null} pointersEnabled={pointersEnabled} />
    </div>
  )
}
