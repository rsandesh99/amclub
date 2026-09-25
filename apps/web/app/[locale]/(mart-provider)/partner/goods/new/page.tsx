import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { listMartCategories } from '@/lib/mart/config'
import { CatalogWizard } from '@/components/mart/CatalogWizard'

export default async function NewGoodsListingPage() {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/goods/new')
  // QA F20 — the create route refuses a provider that is not approved yet; /partner/goods explains why.
  const seller = await getSellerCtx(await createAdminClient(), user.id)
  if (!seller) redirect('/partner/onboarding')
  if (seller.status !== 'active') redirect('/partner/goods')
  const [categories, locale] = await Promise.all([listMartCategories(), getLocale()])
  return <CatalogWizard mode="create" categories={categories.map((c) => ({ slug: c.slug, nameI18n: c.name_i18n, bisBlocked: c.bis_blocked }))} locale={locale} />
}
