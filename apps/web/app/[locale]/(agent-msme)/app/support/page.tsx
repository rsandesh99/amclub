import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { SupportChat } from '@/components/agent/SupportChat'
import { GRIEVANCE_SLA, SUPPORT_CONTACT } from '@/lib/legal/grievance'

/** /app/support (S2.3) — the buyer's help chat. The group layout gates the flag + cohort (a real 404 otherwise). */
export const dynamic = 'force-dynamic'

export default async function BuyerSupportPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/support')
  const t = await getTranslations('support')
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
        <p className="mt-1 text-xs text-foreground-secondary">{t('human_line', { contact: `${SUPPORT_CONTACT.email} / ${SUPPORT_CONTACT.whatsapp}`, hours: GRIEVANCE_SLA.acknowledgeHours })}</p>
      </div>
      <SupportChat role="buyer" />
    </div>
  )
}
