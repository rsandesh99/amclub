import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isSupportEnabledFor } from '@/lib/support/settings'
import { SupportChat } from '@/components/agent/SupportChat'
import { GRIEVANCE_SLA, SUPPORT_CONTACT } from '@/lib/legal/grievance'

/**
 * /partner/support (S2.3) — the provider's help chat. The (agent-provider)
 * group layout gates AGENT_ENABLED + Munshi for its own page, so this page
 * re-checks the SUPPORT switch for this user (a provider may have one agent
 * and not the other).
 */
export const dynamic = 'force-dynamic'

export default async function ProviderSupportPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/support')
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const admin = await createAdminClient()
  if (!(await isSupportEnabledFor(admin, user.id))) notFound()
  const t = await getTranslations('support')
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle_provider')}</p>
        <p className="mt-1 text-xs text-foreground-secondary">{t('human_line', { contact: `${SUPPORT_CONTACT.email} / ${SUPPORT_CONTACT.whatsapp}`, hours: GRIEVANCE_SLA.acknowledgeHours })}</p>
      </div>
      <SupportChat role="provider" />
    </div>
  )
}
