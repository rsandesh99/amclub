import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { isOnFor } from '@/lib/experiments'
import { getMyActions } from '@/lib/me/actions'
import { ActionList } from '@/components/ui-v3/ActionList'

/** E9 FR-9.1 — "See all" from the home's "Needs your action" (flag `home`; the home otherwise). */
export default async function BuyerActionsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/actions')
  if (!isOnFor('home', user.id)) redirect('/app')
  const t = await getTranslations('next_action')
  const items = (await getMyActions(user.id)).buyer?.items ?? []
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6" data-testid="actions-all">
      <h1 className="t-large-title">{t('needs_your_action')}</h1>
      {items.length === 0 ? (
        <p className="text-sm text-foreground-secondary">{t('none')}</p>
      ) : (
        <ActionList items={items} max={items.length} trackEvent="home_action_clicked" />
      )}
    </div>
  )
}
