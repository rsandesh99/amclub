import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { agentPageGate } from '@/lib/agent/gate'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isMunshiEnabledFor } from '@/lib/agent/munshi'
import { MunshiPanel } from '@/components/agent/MunshiPanel'

/**
 * /partner/munshi (S2.2) — the provider's clerk: Enable / Pause / Disable
 * (the consent screen), drafts awaiting a decision (Approve / Edit / Skip),
 * this week's counts, and the price book. A hard 404 unless AGENT_ENABLED and
 * the agent is on for THIS user (agents_enabled.munshi + cohort) — invisible
 * to everyone else; the dashboard tile is filtered the same way.
 */
export const dynamic = 'force-dynamic'

export default async function PartnerMunshiPage() {
  agentPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/munshi')
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const admin = await createAdminClient()
  if (!(await isMunshiEnabledFor(admin, user.id))) notFound()
  const t = await getTranslations('partner_munshi')
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>
      <MunshiPanel whatsappNumber={process.env['NEXT_PUBLIC_WHATSAPP_NUMBER'] ?? null} />
    </div>
  )
}
