import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ChevronLeft } from 'lucide-react'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { PackageWizard, type PackageDraft } from '@/components/partner/PackageWizard'
import { isOnFor } from '@/lib/experiments'
import { addonsOn } from '@/lib/addons'
import { PARTNER_ADDON_COLS } from '@/lib/addons/partner'
import { AddOnsEditor, type EditorAddon } from '@/components/partner/AddOnsEditor'
import { MilestonesEditor, type EditorMilestone } from '@/components/partner/MilestonesEditor'
import { MILESTONE_COLS, bundlesOn } from '@/lib/bundles'

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
  // Experience v3 E2: the service (0051) is read only when the flag is on.
  const offerServices = isOnFor('search', user.id)
  const service = offerServices
    ? ((await supabase.from('packages').select('service_slug').eq('id', id).maybeSingle()).data?.service_slug as string | null | undefined) ?? ''
    : ''

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
    // Exact (₹4,999.50 stays 4999.5): rounding here would silently re-price the listing on save.
    priceRupees: String(Number(pk.price_paise) / 100),
    discountPct: String((pk.discount_bps ?? 0) / 100),
    memberPct: String((pk.member_extra_discount_bps ?? 0) / 100),
    deliveryDays: String(pk.delivery_days),
    revisionCount: String(pk.revision_count),
    faqs: faqs.map((f) => ({ question: f.q, answer: f.a })),
    serviceSlug: service,
  }

  // E12a / ADR 019 — add-ons, only while the switch is on and only on the
  // caller's OWN package (the read above also returns any public active one).
  const admin = await createAdminClient()
  const { data: owner } = await admin.from('packages').select('provider:provider_profiles!inner(user_id)').eq('id', pk.id).maybeSingle()
  const mine = (owner?.provider as { user_id?: string } | null)?.user_id === user.id
  const addons: EditorAddon[] | null = mine && (await addonsOn(admin))
    ? (((await admin.from('package_addons').select(PARTNER_ADDON_COLS).eq('package_id', pk.id).is('deleted_at', null).order('sort').order('created_at')).data ?? []) as EditorAddon[]).map((a) => ({ ...a, price_paise: Number(a.price_paise) }))
    : null
  // E12c / ADR 021 — the plan (milestones), only while the switch is on, own package only.
  const milestones: EditorMilestone[] | null = mine && (await bundlesOn(admin))
    ? (((await admin.from('bundle_milestones').select(MILESTONE_COLS).eq('package_id', pk.id).order('seq')).data ?? []) as EditorMilestone[])
    : null

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/partner/listings" className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-secondary hover:text-primary">
        <ChevronLeft className="h-4 w-4" /> {t('back_to_listings')}
      </Link>
      <h1 className="mb-6 font-display text-2xl font-bold">{t('edit_listing')}</h1>
      <PackageWizard mode="edit" initial={initial} allowedCategorySlugs={[]} offerServices={offerServices} />
      {addons && <AddOnsEditor packageId={pk.id} initial={addons} />}
      {milestones && <MilestonesEditor packageId={pk.id} initial={milestones} />}
    </div>
  )
}
