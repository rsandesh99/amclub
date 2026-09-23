import { notFound, redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { ChevronLeft } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { isOnFor } from '@/lib/experiments'
import { pickI18n } from '@/lib/format'
import { loadTierEditor } from '@/lib/catalog/package-group-admin'
import { TierGroupEditor, type EditorGroupView, type EditorPackageView } from '@/components/packages-v3/TierGroupEditor'
import { CATEGORY_LIST } from '@amclub/shared'

/** Experience v3 E4 (FR-4.1) — "Offer tiers?" (flag `packages`). */
export default async function TiersPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/listings/tiers')
  if (!isOnFor('packages', user.id)) notFound()

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, user.id)
  if (!actor.providerId) redirect('/partner/onboarding')

  const t = await getTranslations('tier_editor')
  const locale = await getLocale()
  const { packages, groups } = await loadTierEditor(admin, actor.providerId).catch(() => ({ packages: [], groups: [] }))

  const categoryName = (slug: string) => {
    const c = CATEGORY_LIST.find((x) => x.slug === slug)
    return c ? pickI18n(c.name_i18n, locale) : slug
  }
  const pkgViews: EditorPackageView[] = packages.map((p) => ({
    id: p.id,
    title: pickI18n(p.titleI18n, locale),
    categoryId: p.categoryId,
    categoryName: categoryName(p.categorySlug),
    deliveryDays: p.deliveryDays,
    display: p.display,
    groupId: p.groupId,
    tier: p.tier,
    idealFor: p.idealForI18n?.en ?? '',
    compareValues: p.compareValues,
  }))
  const groupViews: EditorGroupView[] = groups.map((g) => ({
    id: g.id,
    titleEn: g.titleI18n.en,
    titleHi: g.titleI18n.hi ?? '',
    compareRows: g.compareRows.map((r) => ({ key: r.key, labelEn: r.labelI18n.en, labelHi: r.labelI18n.hi ?? '' })),
    packageIds: g.packageIds,
  }))

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/partner/listings" className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-secondary hover:text-primary">
        <ChevronLeft className="h-4 w-4" /> {t('back')}
      </Link>
      <h1 className="t-title-1">{t('title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      <div className="mt-6">
        <TierGroupEditor packages={pkgViews} groups={groupViews} />
      </div>
    </div>
  )
}
