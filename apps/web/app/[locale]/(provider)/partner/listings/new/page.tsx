import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ChevronLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { onboardingDraftSchema } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { AGENT_ENABLED } from '@/lib/flags'
import { PackageWizard, type PackageDraft } from '@/components/partner/PackageWizard'
import { isOnFor } from '@/lib/experiments'

export default async function NewListingPage({ searchParams }: { searchParams: Promise<{ onboarding_session?: string; pkg?: string }> }) {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/listings/new')
  const sp = await searchParams

  const t = await getTranslations('listings')
  const supabase = await createClient()

  const { data: provider } = await supabase
    .from('provider_profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!provider) redirect('/partner/onboarding')

  const { data: cats } = await supabase
    .from('provider_categories')
    .select('category:categories(slug)')
    .eq('provider_id', provider.id)

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const allowed = (cats ?? []).map((c: any) => c.category?.slug).filter(Boolean) as string[]
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // S1.6 — prefill from ONE package of the provider's CONFIRMED WhatsApp interview draft
  // (ownership in the WHERE; price / delivery blank when the provider stated none).
  let initial: Partial<PackageDraft> | undefined
  if (AGENT_ENABLED && sp.onboarding_session && /^[0-9a-f-]{36}$/i.test(sp.onboarding_session)) {
    const admin = await createAdminClient()
    const { data: s } = await admin.from('onboarding_sessions').select('draft, draft_decision_id').eq('id', sp.onboarding_session).eq('user_id', user.id).maybeSingle()
    const parsed = s?.draft_decision_id ? onboardingDraftSchema.safeParse(s.draft) : null
    const pkg = parsed?.success ? parsed.data.packages[Number(sp.pkg ?? 0)] : undefined
    if (pkg) {
      initial = {
        categorySlug: pkg.category_slug,
        title: pkg.title,
        scopeIncluded: pkg.scope_included,
        deliverables: pkg.deliverables,
        priceRupees: pkg.price_paise === null ? '' : String(pkg.price_paise / 100),
        deliveryDays: pkg.delivery_days === null ? '' : String(pkg.delivery_days),
      }
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/partner/listings" className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-secondary hover:text-primary">
        <ChevronLeft className="h-4 w-4" /> {t('back_to_listings')}
      </Link>
      <h1 className="mb-6 font-display text-2xl font-bold">{t('new_listing')}</h1>
      {initial && <p className="mb-4 rounded-button bg-success/10 px-3 py-2 text-xs text-success">{t('from_interview_hint')}</p>}
      <PackageWizard mode="create" allowedCategorySlugs={allowed} offerServices={isOnFor('search', user.id)} {...(initial ? { initial } : {})} />
    </div>
  )
}
