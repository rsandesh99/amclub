import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import { procurementStateView } from '@/lib/agent/procurement'
import { ProcurementAssistant } from '@/components/agent/ProcurementAssistant'

/**
 * /app/assistant (S3.1) — the buyer's procurement assistant: the web mirror of the WhatsApp conversation (every turn
 * from both surfaces), proposal cards with Yes / Edit / No, and a composer that runs the same engine. The group
 * layout gates the flag + cohort (a real 404 otherwise). Built dark; enablement is the V1.5→V2 gate.
 */
export const dynamic = 'force-dynamic'

export default async function AssistantPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/assistant')
  const t = await getTranslations('assistant')
  const state = await procurementStateView(await createAdminClient(), (await createClient()) as never, user.id)
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>
      <ProcurementAssistant initial={state} />
    </div>
  )
}
