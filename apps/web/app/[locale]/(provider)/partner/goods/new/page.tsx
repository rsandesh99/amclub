import { redirect } from 'next/navigation'
import { getLocale } from 'next-intl/server'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { listMartCategories } from '@/lib/mart/config'
import { CatalogWizard } from '@/components/mart/CatalogWizard'

export default async function NewGoodsListingPage() {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/goods/new')
  const [categories, locale] = await Promise.all([listMartCategories(), getLocale()])
  return <CatalogWizard mode="create" categories={categories.map((c) => ({ slug: c.slug, nameI18n: c.name_i18n, bisBlocked: c.bis_blocked }))} locale={locale} />
}
