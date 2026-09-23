import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { reorderLibrary } from '@/lib/mart/reorder'
import { ReorderClient } from './ReorderClient'

export const dynamic = 'force-dynamic'

/**
 * E16 N44 — the reorder library: every listing the buyer has bought, what
 * they paid beside today's price for the same quantity, "Reorder" into the
 * cart, and an opt-in reminder at their usual interval. Server paise only.
 */
export default async function MartReorderPage() {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/mart/reorder')
  const [t, admin] = await Promise.all([getTranslations('mart'), createAdminClient()])
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', user.id).maybeSingle()
  const items = msme ? await reorderLibrary(admin, msme.id, user.id) : []
  return (
    <div className="mart-enter mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('reorder_title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('reorder_subtitle')}</p>
      </div>
      <ReorderClient items={items} />
    </div>
  )
}
