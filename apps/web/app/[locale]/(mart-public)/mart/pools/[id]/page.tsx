import type { Metadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { indianStateOptions, poolSaving } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { getPool, poolCardText, poolProgressFor } from '@/lib/mart/pools'
import { formatINRExact } from '@/lib/format'
import { getSiteUrl } from '@/lib/site-url'
import { SheetCard, EmeraldCard, GoldNumeral } from '@/components/mart/primitives'
import { PoolProgress, istDateTime } from '@/components/mart/PoolProgress'
import { PoolShare } from '@/components/mart/PoolShare'
import { PoolJoin } from '@/components/mart/PoolJoin'
import { MART_ENABLED } from '@/lib/flags'

/**
 * Pool page — the on-site side of the WhatsApp card. ISR 60s for the
 * forwardable shell (the OG image is the card); the join island fetches
 * the live numbers and the caller's membership.
 */
export const revalidate = 60

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  if (!MART_ENABLED) return {}
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return {}
  const pool = await getPool(await createAdminClient(), id)
  if (!pool || pool.status === 'draft' || pool.status === 'cancelled') return {}
  const t = await getTranslations('mart')
  return {
    title: `${pool.title} — ${t('pools_title')}`,
    description: t('pools_subtitle'),
    alternates: { canonical: `/mart/pools/${pool.id}` },
    openGraph: { title: pool.title, description: t('pools_subtitle'), type: 'website' },
  }
}

export default async function MartPoolPage({ params }: { params: Promise<{ id: string }> }) {
  martPageGate()
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const [t, locale, admin] = await Promise.all([getTranslations('mart'), getLocale(), createAdminClient()])
  const pool = await getPool(admin, id)
  if (!pool || pool.status === 'draft' || pool.status === 'cancelled') notFound()
  const progress = poolProgressFor(pool)
  const saving = poolSaving(pool.unit_price_paise, pool.list_price_paise)
  const url = `${getSiteUrl()}/mart/pools/${pool.id}`
  const share = poolCardText(pool, (['hi', 'te'].includes(locale) ? locale : 'en') as 'en' | 'hi' | 'te', url)
  const live = pool.status === 'open'
  const statusKey = `pool_status_${pool.status}` as 'pool_status_open'

  return (
    <div className="mart-enter mx-auto max-w-3xl px-4 pb-16 pt-6">
      <nav className="flex flex-wrap items-center gap-1 text-meta text-foreground-secondary" aria-label="Breadcrumb">
        <Link href={'/mart' as '/services'} className="inline-flex min-h-11 items-center hover:underline">{t('title')}</Link>
        <span aria-hidden="true">/</span>
        <Link href={'/mart/pools' as '/services'} className="inline-flex min-h-11 items-center hover:underline">{t('pools_title')}</Link>
      </nav>

      {/* The card: emerald, photo, molten progress — one lavish element per screen. */}
      <EmeraldCard className="mt-1">
        <div className="flex gap-4">
          <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-[8px] bg-ivory/10">
            {pool.imageUrl ? <Image src={pool.imageUrl} alt={pool.title} fill sizes="112px" className="object-cover" priority /> : <div className="jaali-emerald h-full w-full" aria-hidden="true" />}
          </div>
          <div className="min-w-0 flex-1">
            <span className="inline-flex rounded-chip bg-ivory/15 px-2 py-0.5 text-xs font-semibold text-ivory">{t(statusKey)}</span>
            <h1 className="mt-1 font-display text-2xl font-bold leading-tight tracking-tight text-ivory">{pool.title}</h1>
            {pool.seller && (
              <p className="mt-1 text-meta text-ivory/80">
                {t('pool_sold_by')} <Link href={`/p/${pool.seller.slug}` as '/services'} className="font-medium text-ivory underline underline-offset-2">{pool.seller.displayName}</Link>{pool.seller.city ? ` · ${pool.seller.city}` : ''}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3">
          <GoldNumeral className="text-4xl">{formatINRExact(pool.unit_price_paise)}</GoldNumeral>
          <span className="text-meta text-ivory/80">{t('pool_per_unit', { unit: pool.unit })}</span>
          {pool.list_price_paise && saving.pct > 0 && (
            <span className="text-meta text-ivory/80"><s>{formatINRExact(pool.list_price_paise)}</s> · <span className="font-semibold text-ivory">{t('pool_save', { pct: saving.pct })}</span></span>
          )}
        </div>
        <PoolProgress className="mt-4" dark committedQty={pool.committed_qty} targetQty={pool.target_qty} unit={pool.unit} progress={progress} />
        <p className="mt-2 text-meta text-ivory/85">
          {t('pool_members', { count: pool.member_count })} · {t('pool_min', { qty: pool.min_qty, unit: pool.unit })} · {live ? t('pool_closes', { date: istDateTime(pool.closes_at) }) : t('pool_closed_on', { date: istDateTime(pool.closedAt ?? pool.closes_at) })}
        </p>
      </EmeraldCard>

      <div className="mt-4">
        <PoolJoin poolId={pool.id} states={indianStateOptions(locale)} minOrderQty={1} />
      </div>

      <PoolShare text={share} className="mt-4" />

      {pool.product_id && (
        <p className="mt-3 text-meta">
          <Link href={`/mart/p/${pool.product_id}` as '/services'} className="inline-flex min-h-11 items-center font-medium text-emerald underline underline-offset-2">{pool.productName ?? pool.title} →</Link>
        </p>
      )}

      <SheetCard className="mt-6">
        <h2 className="text-meta font-semibold text-emerald-ink">{t('pool_how_title')}</h2>
        <ol className="mt-2 space-y-2 text-body text-emerald-ink">
          {(['pool_how_1', 'pool_how_2', 'pool_how_3'] as const).map((k, i) => (
            <li key={k} className="flex gap-3"><span className="gold-numeral text-xl">{i + 1}</span><span>{t(k)}</span></li>
          ))}
        </ol>
      </SheetCard>
    </div>
  )
}
