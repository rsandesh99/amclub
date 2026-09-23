import { getTranslations } from 'next-intl/server'
import { HOME_ACTION_MAX, HOME_COMPLETENESS_THRESHOLD } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { getMyActions } from '@/lib/me/actions'
import { listBuyAgainShelf } from '@/lib/home/buy-again'
import { listSavedProviders } from '@/lib/home/queries'
import { listMyOrders } from '@/lib/orders/queries'
import { isObligationsOn, listComingDue } from '@/lib/licences'
import { createClient } from '@/lib/supabase/server'
import { formatINR } from '@/lib/format'
import { BannerSlot } from '@/components/cms/BannerSlot'
import { ActionList } from '@/components/ui-v3/ActionList'
import { GroupedSection, GroupedRow } from '@/components/ui-v3/GroupedList'
import { PickUpShelf } from './PickUpShelf'
import { BuyAgainShelf } from './BuyAgainShelf'
import { CompletenessCard } from './CompletenessCard'
import { HomeViewed } from './HomeViewed'

/**
 * PRD Experience v3 E9 — the buyer home as a tool (flag `home`):
 * "Needs your action" (≤ 5, from /me/actions — order rows are nextAction's),
 * "Pick up where you left off", "Buy again", recent orders (3) and saved
 * providers (4). The five tiles are gone (the E1 navigation holds them); the
 * completeness card stays under 80 % and can be dismissed for 7 days.
 */
export async function HomeV3({
  userId,
  firstName,
  greetingKey,
  completeness,
  supportOn,
  assistantOn,
}: {
  userId: string
  firstName: string
  greetingKey: 'greeting_morning' | 'greeting_afternoon' | 'greeting_evening'
  completeness: number
  supportOn: boolean
  assistantOn: boolean
}) {
  const [t, tHome, tOrders, tShell, tCat] = await Promise.all([
    getTranslations('home_v3'),
    getTranslations('msme_home'),
    getTranslations('orders'),
    getTranslations('shell'),
    getTranslations('catalog'),
  ])
  const [actions, buyAgain, orders, saved, obligationsOn] = await Promise.all([
    getMyActions(userId),
    listBuyAgainShelf(userId),
    listMyOrders(userId, 'msme'),
    listSavedProviders(userId, 4),
    isObligationsOn(),
  ])
  // E9b (FR-9.5, dark behind obligations_enabled): licences expiring within 60 days.
  const comingDue = obligationsOn ? await listComingDue(await createClient()) : []
  const tLic = obligationsOn ? await getTranslations('licences_v3') : null
  const items = actions.buyer?.items ?? []
  const recent = orders.slice(0, 3)

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6" data-testid="home-v3">
      <HomeViewed actions={items.length} />
      <h1 className="t-large-title">{tHome(greetingKey)}{firstName ? `, ${firstName}` : ''}</h1>

      {completeness < HOME_COMPLETENESS_THRESHOLD && <CompletenessCard completeness={completeness} />}

      <div data-testid="home-actions" data-count={items.length}>
        <ActionList items={items} max={HOME_ACTION_MAX} seeAllHref="/app/actions" trackEvent="home_action_clicked" />
      </div>

      <PickUpShelf />

      <BuyAgainShelf items={buyAgain} />

      {tLic && (
        <div data-testid="home-coming-due">
          <GroupedSection
            header={tLic('coming_due')}
            action={<Link href="/app/licences" className="t-footnote font-medium text-primary">{t('see_all')}</Link>}
          >
            {comingDue.length > 0 ? (
              comingDue.map((l) => (
                <GroupedRow
                  key={l.id}
                  href={l.renewHref}
                  title={tLic(`type_${l.licenceType}`)}
                  subtitle={l.daysLeft !== null && l.daysLeft < 0 ? tLic('expired', { days: -l.daysLeft }) : tLic('expires_in', { days: l.daysLeft ?? 0 })}
                  trailing={<span className="t-footnote shrink-0 font-medium text-primary">{tLic('renew')}</span>}
                  chevron={false}
                />
              ))
            ) : (
              <GroupedRow href="/app/obligations" title={tLic('what_do_i_need')} subtitle={tLic('home_prompt')} />
            )}
          </GroupedSection>
        </div>
      )}

      <BannerSlot slot="hero" className="space-y-3 [&_.mx-auto]:px-0 [&_.mx-auto]:py-0" />

      {recent.length > 0 ? (
        <GroupedSection
          header={t('recent_orders')}
          action={<Link href="/app/orders" className="t-footnote font-medium text-primary">{t('see_all')}</Link>}
        >
          {recent.map((o) => (
            <GroupedRow
              key={o.id as string}
              href={`/app/orders/${o.id}`}
              title={o.title as string}
              subtitle={tOrders(`status_${o.status}` as 'status_placed')}
              value={formatINR(Number(o.total_paise))}
            />
          ))}
        </GroupedSection>
      ) : (
        items.length === 0 && (
          <div className="rounded-card border border-border bg-surface p-5 shadow-card" data-testid="home-start">
            <p className="text-sm font-medium">{tHome('no_orders_title')}</p>
            <p className="mt-1 text-xs text-foreground-secondary">{tHome('no_orders_subtitle')}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/app/search" className="rounded-button bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">{tHome('explore_cta')}</Link>
              <Link href="/app/rfq/new?entry=home" className="rounded-button border border-border px-4 py-2 text-sm font-medium">{tHome('post_rfq')}</Link>
            </div>
          </div>
        )
      )}

      {saved.length > 0 && (
        <GroupedSection
          header={t('saved_providers')}
          action={<Link href="/app/saved" className="t-footnote font-medium text-primary">{t('see_all')}</Link>}
        >
          {saved.map((p) => (
            <GroupedRow
              key={p.id}
              href={`/p/${p.slug}`}
              title={p.displayName}
              subtitle={p.reviewCount > 0 ? `★ ${p.avgRating.toFixed(1)} (${p.reviewCount})` : tCat('new')}
            />
          ))}
        </GroupedSection>
      )}

      {(supportOn || assistantOn) && (
        <div className="flex flex-wrap gap-2">
          {assistantOn && <Link href="/app/assistant" className="rounded-chip border border-border px-3 py-1.5 text-sm">{tShell('assistant_entry')}</Link>}
          {supportOn && <Link href="/app/support" className="rounded-chip border border-border px-3 py-1.5 text-sm">{tShell('help_entry')}</Link>}
        </div>
      )}
    </div>
  )
}
