import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ChevronLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { PackageWizard } from '@/components/partner/PackageWizard'

export default async function NewListingPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/listings/new')

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

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/partner/listings" className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-secondary hover:text-primary">
        <ChevronLeft className="h-4 w-4" /> {t('back_to_listings')}
      </Link>
      <h1 className="mb-6 font-display text-2xl font-bold">{t('new_listing')}</h1>
      <PackageWizard mode="create" allowedCategorySlugs={allowed} />
    </div>
  )
}
