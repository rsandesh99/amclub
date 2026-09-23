import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { isOnFor } from '@/lib/experiments'
import { getMyActions } from '@/lib/me/actions'
import { ActionList } from '@/components/ui-v3/ActionList'

/** E11 FR-11.1 — "See all" from Today's "Needs your action" (flag `partner`; Today otherwise). */
export default async function PartnerActionsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/actions')
  if (!isOnFor('partner', user.id)) redirect('/partner')
  const t = await getTranslations('next_action')
  const items = (await getMyActions(user.id)).provider?.items ?? []
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6" data-testid="partner-actions-all">
      <h1 className="t-large-title">{t('needs_your_action')}</h1>
      {items.length === 0 ? <p className="text-sm text-foreground-secondary">{t('none')}</p> : <ActionList items={items} max={items.length} trackEvent="partner_action_clicked" />}
    </div>
  )
}
