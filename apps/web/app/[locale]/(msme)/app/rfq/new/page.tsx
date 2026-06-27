import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ClipboardList } from 'lucide-react'
import type { RfqTemplate } from '@amclub/shared'
import { getSessionUser } from '@/lib/auth/session'
import { createClient, createPublicClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { RfqForm, type RfqCategoryOption } from '@/components/rfq/RfqForm'

export default async function NewRfqPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/rfq/new')
  const t = await getTranslations('rfq')
  const locale = await getLocale()

  // §1.5 M5 / §3.3 — RFQ matching needs state + sector.
  const supabase = await createClient()
  const { data: profile } = await supabase
    .from('msme_profiles')
    .select('state, sector')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!profile?.state || !profile?.sector) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warning/10">
          <ClipboardList className="h-7 w-7 text-warning" />
        </span>
        <h1 className="mt-4 text-xl font-semibold">{t('profile_incomplete_title')}</h1>
        <p className="mt-2 text-sm text-foreground-secondary">{t('profile_incomplete_body')}</p>
        <Link href="/app/profile">
          <Button className="mt-6">{t('complete_profile_cta')}</Button>
        </Link>
      </div>
    )
  }

  // Public read — categories + their seeded RFQ templates.
  const pub = createPublicClient()
  const { data: cats } = await pub
    .from('categories')
    .select('slug, name_i18n, rfq_template, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  const categories: RfqCategoryOption[] = (cats ?? []).map((c) => {
    const tpl = (c.rfq_template ?? { fields: [] }) as RfqTemplate
    const name = (c.name_i18n as { en: string; hi?: string })
    return {
      slug: c.slug as string,
      name: (locale === 'hi' && name.hi) ? name.hi : name.en,
      fields: tpl.fields ?? [],
    }
  })

  return (
    <div className="mx-auto max-w-lg px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('new_title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('new_subtitle')}</p>
      </div>
      <RfqForm categories={categories} />
    </div>
  )
}
