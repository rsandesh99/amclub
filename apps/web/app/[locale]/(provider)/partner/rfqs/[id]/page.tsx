import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { getRfqForProvider } from '@/lib/rfq/queries'
import { Badge } from '@/components/ui/badge'
import { QuoteComposer } from '@/components/rfq/QuoteComposer'
import { QuoteTermsRow } from '@/components/rfq/QuoteTermsRow'
import { formatINR, formatINRExact } from '@/lib/format'
import { pickLocale } from '@amclub/shared'
import { getLocale } from 'next-intl/server'
import { GoodsSpecCard, type GoodsSpecView } from '@/components/mart/GoodsSpecCard'
import { getMartCategory } from '@/lib/mart/config'
import { createAdminClient } from '@/lib/supabase/server'
import type { QuoteComposerGoods } from '@/components/rfq/QuoteComposer'

export default async function ProviderRfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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
    const [cat, { data: listings }, locale] = await Promise.all([
      getMartCategory(admin, rfq.martCategorySlug),
      admin.from('products').select('id, name, hsn_code, gst_rate_bps').eq('seller_id', profile.id).eq('category_slug', rfq.martCategorySlug).eq('status', 'active').is('deleted_at', null).order('name').limit(50),
      getLocale(),
    ])
    goodsCatName = cat ? pickLocale(cat.name_i18n, locale) : null
    const spec = rfq.goodsSpec as unknown as GoodsSpecView
    goods = { unit: spec.unit, qty: spec.qty, listings: (listings ?? []).map((l) => ({ id: l.id as string, name: l.name as string, hsnCode: l.hsn_code as string, gstRateBps: Number(l.gst_rate_bps) })) }
  }

  const details = Object.entries(rfq.details).filter(([, v]) => v != null && String(v).trim() !== '')

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
      </div>

      {rfq.kind === 'goods' && rfq.goodsSpec && (
        <GoodsSpecCard spec={rfq.goodsSpec as unknown as GoodsSpecView} categoryName={goodsCatName} />
      )}

      {rfq.myQuote ? (
        <div className="rounded-card border border-success/40 bg-success/5 p-5">
          <p className="text-sm font-semibold text-success">{t('your_quote')}</p>
          {rfq.myQuote.goods ? (
            <p className="mt-1 text-sm tabular-nums">
              {formatINRExact(rfq.myQuote.goods.unitPricePaise)} {t('goods_per_unit', { unit: goods?.unit ?? '' })} × {rfq.myQuote.goods.qty} = {formatINRExact(rfq.myQuote.goods.taxablePaise)} · {t('goods_col_gst')} {rfq.myQuote.goods.gstRateBps / 100}% · {t('goods_col_incl')} {formatINRExact(rfq.myQuote.goods.totalInclGstPaise)} · {t('delivery_days', { days: rfq.myQuote.deliveryDays })}
            </p>
          ) : (
            <p className="mt-1 text-sm">{formatINR(rfq.myQuote.pricePaise)} · {t('delivery_days', { days: rfq.myQuote.deliveryDays })}</p>
          )}
          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground-secondary">{rfq.myQuote.scope}</p>
          <div className="mt-3"><QuoteTermsRow terms={rfq.myQuote} compact /></div>
        </div>
      ) : rfq.canQuote ? (
        <QuoteComposer rfqId={rfq.id} goods={goods ?? undefined} />
      ) : (
        <div className="rounded-card border border-border bg-muted p-4 text-center text-sm text-foreground-secondary">
          {t('rfq_closed')}
        </div>
      )}
    </div>
  )
}
