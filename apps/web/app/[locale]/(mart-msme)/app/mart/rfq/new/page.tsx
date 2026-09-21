import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { ClipboardList } from 'lucide-react'
import { pickLocale } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { listMartCategories } from '@/lib/mart/config'
import { deliveryDefaults } from '@/lib/mart/delivery-defaults'
import { getPublicProduct } from '@/lib/mart/queries'
import { INDIAN_STATES } from '@/lib/constants/india'
import { Button } from '@/components/ui/button'
import { GoodsRfqForm, type GoodsRfqPrefill } from '@/components/mart/GoodsRfqForm'
import { AGENT_ENABLED } from '@/lib/flags'
import { isAgentEnabledForUser } from '@/lib/agent/settings'

export const dynamic = 'force-dynamic'

/**
 * AMC Mart M2 — "Ask for a bulk quote". Same profile gate as the services RFQ
 * (fan-out needs the buyer's state); delivery prefilled from the last goods
 * order or the profile; `?product_id=` prefills item/unit/category from a listing.
 */
export default async function NewGoodsRfqPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/mart/rfq/new')
  const sp = await searchParams
  const [t, locale, admin] = await Promise.all([getTranslations('rfq'), getLocale(), createAdminClient()])

  const { data: profile } = await admin.from('msme_profiles').select('state, sector').eq('user_id', user.id).maybeSingle()
  if (!profile?.state || !profile?.sector) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warning/10">
          <ClipboardList className="h-7 w-7 text-warning" />
        </span>
        <h1 className="mt-4 text-xl font-semibold">{t('profile_incomplete_title')}</h1>
        <p className="mt-2 text-sm text-foreground-secondary">{t('profile_incomplete_body')}</p>
        <Link href="/app/profile"><Button className="mt-6">{t('complete_profile_cta')}</Button></Link>
      </div>
    )
  }

  const productId = sp['product_id'] && /^[0-9a-f-]{36}$/i.test(sp['product_id']) ? sp['product_id'] : null
  const [cats, defaults, product] = await Promise.all([
    listMartCategories(),
    deliveryDefaults(admin, user.id),
    productId ? getPublicProduct(productId) : Promise.resolve(null),
  ])
  const categories = cats.filter((c) => !c.bis_blocked).map((c) => ({ slug: c.slug, name: pickLocale(c.name_i18n, locale) }))
  const prefill: GoodsRfqPrefill | null = product
    ? { productId: product.id, item: product.name, unit: product.unit, categorySlug: product.categorySlug, productName: product.name }
    : sp['item']
      ? { productId: null, item: sp['item'].slice(0, 140), unit: 'pcs', categorySlug: sp['category'] ?? '', productName: null }
      : null

  return (
    <div className="mart-enter mx-auto max-w-lg space-y-5 px-4 py-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('goods_new_title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('goods_new_subtitle')}</p>
      </div>
      <GoodsRfqForm categories={categories} states={INDIAN_STATES} defaults={defaults} prefill={prefill} documentIntakeEnabled={AGENT_ENABLED ? await isAgentEnabledForUser(admin, 'document_intake', user.id) : false} />
    </div>
  )
}
