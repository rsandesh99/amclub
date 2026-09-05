import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Plus, PackageOpen } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { getGoodsActivation } from '@/lib/mart/activation'
import { listSellerProducts } from '@/lib/mart/queries'
import { publicAssetUrl } from '@/lib/mart/assets'
import { formatINR } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { ActivationBanner } from '@/components/mart/ActivationBanner'
import { GoodsListingActions } from '@/components/mart/GoodsListingActions'

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'default' | 'info'> = {
  active: 'success', pending_approval: 'info', draft: 'default', suspended: 'warning',
}

/** Seller catalogue (FRONTEND.md §7 catalog manager): activation gate banner + listings + status actions. */
export default async function PartnerGoodsPage() {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/goods')
  const t = await getTranslations('mart')
  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, user.id)
  if (!seller) redirect('/partner/onboarding')
  const [activation, products] = await Promise.all([getGoodsActivation(admin, seller.id), listSellerProducts(admin, seller.id)])

  return (
    <div className="mart-enter mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('seller_title')}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">{t('seller_subtitle')}</p>
        </div>
        <Link href={'/partner/goods/new' as '/partner'} className="inline-flex shrink-0 items-center gap-2 rounded-button bg-emerald px-4 py-2.5 text-sm font-semibold text-ivory hover:bg-emerald-ink">
          <Plus className="h-4 w-4" /> {t('new_listing')}
        </Link>
      </div>

      {activation && <ActivationBanner state={activation.state} />}

      {products.length === 0 ? (
        <div className="jaali-ivory flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-brass/60 px-6 py-16 text-center">
          <PackageOpen className="h-10 w-10 text-brass" />
          <h2 className="text-md font-semibold text-emerald-ink">{t('empty_title')}</h2>
          <p className="max-w-sm text-sm text-foreground-secondary">{t('empty_body')}</p>
          <Link href={'/partner/goods/new' as '/partner'} className="mt-2 inline-flex items-center gap-2 rounded-button bg-emerald px-4 py-2.5 text-sm font-semibold text-ivory hover:bg-emerald-ink">
            <Plus className="h-4 w-4" /> {t('create_first')}
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {products.map((p) => (
            <li key={p.id} className={`${p.status === 'active' ? 'gold-edge-card' : 'sheet-card'} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between`}>
              <div className="flex min-w-0 items-center gap-3">
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded-[8px] bg-emerald-ink/5">
                  {p.images[0] && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={publicAssetUrl(p.images[0])} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-medium text-emerald-ink">{p.name}</h2>
                    <Badge variant={STATUS_VARIANT[p.status] ?? 'default'}>{t(`status_${p.status}` as 'status_draft')}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-foreground-secondary">
                    {t('hsn')} {p.hsnCode} · {t('gst_rate', { rate: p.gstRateBps / 100 })}
                    {p.list ? ` · ${formatINR(p.list.unit_price_paise)} ${t('per_unit', { unit: p.unit })}` : ''}
                  </p>
                </div>
              </div>
              <GoodsListingActions productId={p.id} status={p.status} sellsGoods={seller.sellsGoods} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
