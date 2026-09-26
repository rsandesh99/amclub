import { getTranslations } from 'next-intl/server'
import { MessageCircle, Sparkles } from 'lucide-react'
import { COMING_DUE_DAYS, HOME_ACTION_MAX, HOME_COMPLETENESS_THRESHOLD } from '@amclub/shared'
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
import { WhatsAppOptInCard } from '@/components/settings/WhatsAppOptInCard'
import { HomeViewed } from './HomeViewed'
import { HomeSnapshot } from './HomeSnapshot'
import { WhyAmclub } from '@/components/usp/WhyAmclub'
import { listMyRfqs } from '@/lib/rfq/queries'
import { isOnFor } from '@/lib/experiments'
import { MART_ENABLED } from '@/lib/flags'

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
  // E18 (flag `guide`): the right rail — the buyer's numbers and "Why AMClub".
  const guide = isOnFor('guide', userId)
  const [actions, buyAgain, orders, saved, obligationsOn, rfqs] = await Promise.all([
    getMyActions(userId),
    listBuyAgainShelf(userId),
    listMyOrders(userId, 'msme'),
    listSavedProviders(userId, 4),
    isObligationsOn(),
    guide ? listMyRfqs(userId) : Promise.resolve([]),
  ])
  // E9b (FR-9.5, dark behind obligations_enabled): licences expiring within 60 days.
  const comingDue = obligationsOn ? await listComingDue(await createClient()) : []
  const tLic = obligationsOn ? await getTranslations('licences_v3') : null
  const items = actions.buyer?.items ?? []
  const recent = orders.slice(0, 3)

  return (
    <div
      className={guide ? 'mx-auto max-w-6xl px-4 py-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-8' : 'mx-auto max-w-2xl px-4 py-6'}
      data-testid="home-v3"
    >
      <div className="min-w-0 space-y-6">
        <HomeViewed actions={items.length} />
        <h1 className="t-large-title">{tHome(greetingKey)}{firstName ? `, ${firstName}` : ''}</h1>

        {completeness < HOME_COMPLETENESS_THRESHOLD && <CompletenessCard completeness={completeness} />}

        {/* PRD_WHATSAPP W1 — one-time "Get order updates on WhatsApp" for accounts that never chose. */}
        <WhatsAppOptInCard persona="buyer" />

        <div data-testid="home-actions" data-count={items.length}>
          <ActionList items={items} max={HOME_ACTION_MAX} seeAllHref="/app/actions" trackEvent="home_action_clicked" />
        </div>

        <PickUpShelf />

        <BuyAgainShelf items={buyAgain} />

        {tLic && (
          <div data-testid="home-coming-due">
            <GroupedSection
              header={tLic('coming_due')}
              // Named for where it goes: the buyer's licence list (not a longer "coming due" list).
              action={<Link href="/app/licences" className="t-footnote font-medium text-primary">{tLic('title')}</Link>}
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
                <>
                  {/* Empty: say so under the header, then the checklist prompt. */}
                  <GroupedRow title={<span className="text-foreground-secondary">{tLic('coming_due_none', { days: COMING_DUE_DAYS })}</span>} />
                  <GroupedRow href="/app/obligations" title={tLic('what_do_i_need')} subtitle={tLic('home_prompt')} />
                </>
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

        {/* Help and the buying assistant as one grouped section like the rest of the home (a lone pill floated on its own). */}
        {(supportOn || assistantOn) && (
          <GroupedSection header={t('get_help')}>
            {assistantOn && <GroupedRow href="/app/assistant" leading={<Sparkles className="h-4 w-4" aria-hidden />} title={tShell('assistant_entry')} />}
            {supportOn && <GroupedRow href="/app/support" leading={<MessageCircle className="h-4 w-4" aria-hidden />} title={tShell('help_entry')} subtitle={t('help_sub')} />}
          </GroupedSection>
        )}
      </div>

      {guide && (
        <aside className="mt-8 space-y-4 lg:sticky lg:top-20 lg:mt-0" aria-label={t('rail_label')} data-testid="home-rail">
          <HomeSnapshot orders={orders as { status: string; total_paise: number | null }[]} rfqs={rfqs} />
          <WhyAmclub surface="home" martEnabled={MART_ENABLED} />
        </aside>
      )}
    </div>
  )
}
