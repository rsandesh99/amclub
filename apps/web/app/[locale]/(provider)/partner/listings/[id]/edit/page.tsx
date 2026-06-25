import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ChevronLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { PackageWizard, type PackageDraft } from '@/components/partner/PackageWizard'

interface RequirementField {
  label_en?: string
}

export default async function EditListingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/listings')
  const { id } = await params

  const t = await getTranslations('listings')
  const supabase = await createClient()

  // RLS owner-all → returns the row only if it belongs to this provider.
  const { data: pk } = await supabase
    .from('packages')
    .select(
      'id, title_i18n, scope_included, scope_excluded, deliverables, requirements_template, price_paise, discount_bps, member_extra_discount_bps, delivery_days, revision_count, faqs, category:categories(slug)',
    )
    .eq('id', id)
    .maybeSingle()

  if (!pk) notFound()

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const cat = pk.category as any
  const reqFields: RequirementField[] = (pk.requirements_template as any)?.fields ?? []
  const faqs = (pk.faqs as { q: string; a: string }[] | null) ?? []
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const initial: Partial<PackageDraft> = {
    id: pk.id,
    categorySlug: cat?.slug ?? '',
    title: (pk.title_i18n as { en?: string })?.en ?? '',
    scopeIncluded: (pk.scope_included as string[]) ?? [],
    scopeExcluded: (pk.scope_excluded as string[]) ?? [],
    deliverables: (pk.deliverables as string[]) ?? [],
    requirements: reqFields.map((f) => f.label_en ?? '').filter(Boolean),
    priceRupees: String(Math.round(Number(pk.price_paise) / 100)),
    discountPct: String((pk.discount_bps ?? 0) / 100),
    memberPct: String((pk.member_extra_discount_bps ?? 0) / 100),
    deliveryDays: String(pk.delivery_days),
    revisionCount: String(pk.revision_count),
    faqs: faqs.map((f) => ({ question: f.q, answer: f.a })),
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/partner/listings" className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-secondary hover:text-primary">
        <ChevronLeft className="h-4 w-4" /> {t('back_to_listings')}
      </Link>
      <h1 className="mb-6 font-display text-2xl font-bold">{t('edit_listing')}</h1>
      <PackageWizard mode="edit" initial={initial} allowedCategorySlugs={[]} />
    </div>
  )
}
