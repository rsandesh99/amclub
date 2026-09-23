import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { listTranslatable } from '@/lib/translations/content'
import { ContentTranslationsClient } from '@/components/partner/ContentTranslationsClient'

export const dynamic = 'force-dynamic'

/**
 * E14 FR-14.3 (N32b, dark) — "Translate your listings": each package title,
 * "Choose this if…" line and the About, English beside the draft, one language
 * at a time. A draft is only a suggestion; Approve writes it (edited or not).
 */
export default async function TranslationsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/translations')
  const admin = await createAdminClient()
  const { data: p } = await admin.from('provider_profiles').select('id').eq('user_id', user.id).maybeSingle()
  if (!p) redirect('/partner/onboarding')
  const t = await getTranslations('content_translate')
  const initial = await listTranslatable(admin, p.id as string)
  return (
    <div className="mx-auto max-w-3xl px-4 py-8" data-testid="translations-page">
      <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      <ContentTranslationsClient initial={initial} />
    </div>
  )
}
