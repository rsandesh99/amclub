import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { getRfqForProvider } from '@/lib/rfq/queries'
import { Badge } from '@/components/ui/badge'
import { QuoteComposer } from '@/components/rfq/QuoteComposer'
import { DeclineRfqButton } from '@/components/rfq/DeclineRfqButton'
import { QuoteTermsRow } from '@/components/rfq/QuoteTermsRow'
import { formatINR, formatINRExact } from '@/lib/format'
import { pickLocale } from '@amclub/shared'
import { getLocale } from 'next-intl/server'
import { GoodsSpecCard, type GoodsSpecView } from '@/components/mart/GoodsSpecCard'
import { getMartCategory } from '@/lib/mart/config'
import { listSellerListingsInCategory } from '@/lib/mart/goods-rfq'
import { createAdminClient } from '@/lib/supabase/server'
import type { QuoteComposerGoods } from '@/components/rfq/QuoteComposer'
import { isQuoteExtractEnabledFor } from '@/lib/agent/quote-extract'
import { MAX_QUOTE_REVISIONS, rfqIsActive } from '@amclub/shared'
import { ClarificationsCard } from '@/components/rfq/ClarificationsCard'
import { NudgeButton } from '@/components/orders/NudgeButton'
import { ReviseQuote } from '@/components/rfq/ReviseQuote'
import { AGENT_ENABLED } from '@/lib/flags'
import { munshiDraftForComposer } from '@/lib/agent/munshi'

export default async function ProviderRfqPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ munshi?: string }> }) {
  const { id } = await params
  const sp = await searchParams
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/partner/rfqs/${id}`)
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const t = await getTranslations('rfq')
  const rfq = await getRfqForProvider(user.id, id)
  if (!rfq) notFound()

  // AMC Mart M2 — goods RFQ: category name + the seller's own listings in that
  // category (prefill HSN/GST; the quote can link a listing to the order line).
  let goods: QuoteComposerGoods | null = null
  let goodsCatName: string | null = null
  if (rfq.kind === 'goods' && rfq.goodsSpec && rfq.martCategorySlug) {
    const admin = await createAdminClient()
    const [cat, listings, locale] = await Promise.all([
      getMartCategory(admin, rfq.martCategorySlug),
      listSellerListingsInCategory(admin, profile.id, rfq.martCategorySlug),
      getLocale(),
    ])
    goodsCatName = cat ? pickLocale(cat.name_i18n, locale) : null
    const spec = rfq.goodsSpec as unknown as GoodsSpecView
    goods = { unit: spec.unit, qty: spec.qty, listings }
  }

  // S1.1 — "Type or speak your quote": AGENT_ENABLED + agents_enabled.quote_extract + cohort, for THIS provider.
  const extractEnabled = await isQuoteExtractEnabledFor(await createAdminClient(), user.id)
  // S2.2 — ?munshi=<draftId>: the provider's own open quote draft prefills the composer; the submit carries munshi_draft_id.
  const munshi = AGENT_ENABLED && sp.munshi && /^[0-9a-f-]{36}$/i.test(sp.munshi) ? await munshiDraftForComposer(await createAdminClient(), { providerId: profile.id, draftId: sp.munshi, rfqId: id }) : null

  const details = Object.entries(rfq.details).filter(([, v]) => v != null && String(v).trim() !== '')
  // S1.3 — the thread is writable while the RFQ is active and this provider has not declined
  // (a provider who already quoted may still ask); read-only once closed.
  const active = rfqIsActive(rfq.status) && new Date(rfq.expiresAt).getTime() > Date.now()
  const canAsk = active && !rfq.declinedAt
  const canRevise = !!rfq.myQuote && rfq.myQuote.status === 'submitted' && active && rfq.myQuote.revision < MAX_QUOTE_REVISIONS

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display text-xl font-bold">{rfq.title}</h1>
          <div className="flex shrink-0 items-center gap-2">
            {rfq.kind === 'goods' && <Badge variant="success">{t('goods_badge')}</Badge>}
            <Badge variant="info">{t('quotes_n', { n: rfq.quoteCount, max: rfq.maxQuotes })}</Badge>
          </div>
        </div>
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
                <dd className="font-medium">{rfq.budgetMinPaise ? formatINR(rfq.budgetMinPaise) : '—'} – {rfq.budgetMaxPaise ? formatINR(rfq.budgetMaxPaise) : '—'}</dd>
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
        <GoodsSpecCard spec={rfq.goodsSpec as unknown as GoodsSpecView} categoryName={goodsCatName} />
      )}

      {/* S1.3 — ask before quoting + every provider's questions (mine marked); read-only once closed. */}
      <ClarificationsCard rfqId={rfq.id} role="provider" initial={rfq.clarifications} canWrite={canAsk} closed={!active} />

      {rfq.myQuote ? (
        <div className="rounded-card border border-success/40 bg-success/5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-success">{t('your_quote')}</p>
            {rfq.myQuote.revision > 1 && <Badge variant="warning">{t('revise_count', { n: rfq.myQuote.revision - 1 })}</Badge>}
          </div>
          {rfq.myQuote.goods ? (
            <p className="mt-1 text-sm tabular-nums">
              {formatINRExact(rfq.myQuote.goods.unitPricePaise)} {t('goods_per_unit', { unit: goods?.unit ?? '' })} × {rfq.myQuote.goods.qty} = {formatINRExact(rfq.myQuote.goods.taxablePaise)} · {t('goods_col_gst')} {rfq.myQuote.goods.gstRateBps / 100}% · {t('goods_col_incl')} {formatINRExact(rfq.myQuote.goods.totalInclGstPaise)} · {t('delivery_days', { days: rfq.myQuote.deliveryDays })}
            </p>
          ) : (
            <p className="mt-1 text-sm">{formatINR(rfq.myQuote.pricePaise)} · {t('delivery_days', { days: rfq.myQuote.deliveryDays })}</p>
          )}
          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground-secondary">{rfq.myQuote.scope}</p>
          <div className="mt-3"><QuoteTermsRow terms={rfq.myQuote} compact /></div>
          {/* S2.3 — remind the buyer to decide (spine; once per 24 h) while this quote is live. */}
          {rfq.myQuote.status === 'submitted' && active && !rfq.declinedAt && (
            <div className="mt-3 flex justify-end"><NudgeButton subjectKind="rfq" subjectId={rfq.id} /></div>
          )}
          {/* S1.3 — revise in place (PATCH): same composer, prefilled, no extraction box. */}
          {canRevise && (
            <ReviseQuote
              rfqId={rfq.id}
              revision={rfq.myQuote.revision}
              goods={goods ?? undefined}
              initial={{
                pricePaise: rfq.myQuote.pricePaise, deliveryDays: rfq.myQuote.deliveryDays, scope: rfq.myQuote.scope, message: rfq.myQuote.message,
                gstIncluded: rfq.myQuote.gstIncluded, transportIncluded: rfq.myQuote.transportIncluded, validUntil: rfq.myQuote.validUntil, advancePercent: rfq.myQuote.advancePercent,
                goods: rfq.myQuote.goods ? { unitPricePaise: rfq.myQuote.goods.unitPricePaise, qty: rfq.myQuote.goods.qty, gstRateBps: rfq.myQuote.goods.gstRateBps, hsnCode: rfq.myQuote.goods.hsnCode, productId: rfq.myQuote.goods.productId } : null,
              }}
            />
          )}
          {/* S1.2 — the buyer declined: reason label + the courteous message that was sent (never the buyer's note). */}
          {rfq.myQuote.status === 'declined' && (
            <div className="mt-3 rounded-button border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium">{t('quote_declined_title')}</p>
              {rfq.myQuote.declineReason && (
                <p className="mt-1 text-xs text-foreground-secondary">{t('quote_declined_reason')}: {t(`declined_reason_label_${rfq.myQuote.declineReason}` as 'declined_reason_label_other')}</p>
              )}
              {rfq.myQuote.declineMessage && (
                <p className="mt-2 whitespace-pre-wrap text-sm"><span className="text-xs text-foreground-secondary">{t('quote_declined_message_label')}: </span>{rfq.myQuote.declineMessage}</p>
              )}
            </div>
          )}
        </div>
      ) : rfq.declinedAt ? (
        <div className="rounded-card border border-border bg-muted p-4 text-center text-sm text-foreground-secondary">
          {t('you_declined')}
        </div>
      ) : rfq.canQuote ? (
        <div className="space-y-3">
          <QuoteComposer rfqId={rfq.id} goods={goods ?? undefined} extractEnabled={extractEnabled} {...(munshi ? { initial: { ...munshi.initial, message: null }, munshiDraftId: munshi.draftId } : {})} />
          {/* S0.4 quote-or-decline: an honest "no" beside "Quote". */}
          <div className="flex justify-end gap-2">
            <DeclineRfqButton rfqId={rfq.id} />
          </div>
        </div>
      ) : (
        <div className="rounded-card border border-border bg-muted p-4 text-center text-sm text-foreground-secondary">
          {t('rfq_closed')}
        </div>
      )}
    </div>
  )
}
