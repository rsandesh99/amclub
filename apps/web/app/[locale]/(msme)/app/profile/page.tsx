import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { MsmeProfileForm, type MsmeProfileInitial } from '@/components/profile/MsmeProfileForm'

export default async function MsmeProfilePage() {
  const t = await getTranslations('profile')

  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/profile')

  // Owner reads their own row via RLS. Includes udyam/gstin so the form prefills.
  const supabase = await createClient()
  const { data: profile } = await supabase
    .from('msme_profiles')
    .select('business_name, sector, state, city, udyam_number, gstin')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!profile) redirect('/signup?complete=1')

  const initial: MsmeProfileInitial = {
    fullName: user.fullName ?? '',
    businessName: profile.business_name ?? '',
    sector: profile.sector ?? '',
    stateCode: profile.state ?? '',
    city: profile.city ?? '',
    udyamNumber: profile.udyam_number ?? '',
    gstin: profile.gstin ?? '',
    preferredLocale: user.preferredLocale ?? 'en',
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('my_profile')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('edit_profile')}</p>
      </div>

      {/* Account (read-only identity) */}
      <section className="rounded-card border border-border bg-muted p-4 text-sm">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
          {t('account_section')}
        </h2>
        <dl className="space-y-1">
          <div className="flex justify-between gap-4">
            <dt className="text-foreground-secondary">{t('email_label')}</dt>
            <dd className="truncate font-medium">{user.email ?? t('not_set')}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-foreground-secondary">{t('phone_label')}</dt>
            <dd className="font-medium">{user.phone ?? t('not_set')}</dd>
          </div>
        </dl>
      </section>

      <MsmeProfileForm initial={initial} />
    </div>
  )
}
