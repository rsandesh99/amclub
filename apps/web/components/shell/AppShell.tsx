import { Link } from '@/i18n/navigation'
import { resolveDensity } from '@amclub/shared'
import { LanguageSwitcher } from '@/components/catalog/LanguageSwitcher'
import { JurisdictionSelector } from '@/components/catalog/JurisdictionSelector'
import { NotificationBell } from './NotificationBell'
import { AccountMenu, type ShellContext } from './AccountMenu'
import { LegalGate } from '@/components/legal/LegalGate'
import { isOnFor } from '@/lib/experiments'
import { getUiDensity } from '@/lib/auth/session'
import { AGENT_ENABLED, MART_ENABLED } from '@/lib/flags'
import { ActionsProvider } from '@/components/shell-v3/ActionsProvider'
import { ShellTopBar } from '@/components/shell-v3/ShellTopBar'
import { SideRail, TabBar } from '@/components/shell-v3/NavBars'
import { AssistantLauncher } from '@/components/assistant/AssistantLauncher'

/**
 * Shared chrome for every logged-in surface (MSME / provider / admin). One
 * header, one account menu (profile, role switch, help, sign out) — no more
 * per-page headers or dead-end inner pages.
 *
 * Experience v3 (PRD E1, flag `shell`): a translucent top bar with universal
 * search (⌘K), a left rail on desktop and a tab bar on phones with N2 badges,
 * the v3 tokens (data-ui) and the viewer's density (data-density).
 */
export async function AppShell({
  context,
  name,
  email = null,
  phone = null,
  roles,
  userId,
  hasMsmeProfile,
  hasProviderProfile,
  focused = false,
  children,
}: {
  context: ShellContext
  name: string | null
  /** The account menu says who is signed in (and the avatar letter) when there is no name. */
  email?: string | null
  phone?: string | null
  roles: string[]
  /** Needed for the v3 flag bucket and the density preference. */
  userId?: string
  /** PROFILE existence (not roles) — every provider signup also carries the
   *  'msme' role, so role flags overstate what surfaces actually exist. */
  hasMsmeProfile?: boolean
  hasProviderProfile?: boolean
  /** A focused task (checkout): the v3 top bar only — no rail, no tab bar. */
  focused?: boolean
  children: React.ReactNode
}) {
  const hasMsme = hasMsmeProfile ?? roles.includes('msme')
  const hasProvider = hasProviderProfile ?? roles.includes('provider')
  const isAdmin = roles.includes('admin') || roles.includes('ops')

  const homeHref = context === 'provider' ? '/partner' : context === 'admin' ? '/admin/verifications' : '/app'
  const suffix = context === 'provider' ? ' Partner' : context === 'admin' ? ' Admin' : ''
  const notificationsHref = context === 'provider' ? '/partner/notifications' : '/app/notifications'

  const v3 = isOnFor('shell', userId)
  if (v3 && userId) {
    const surface = context === 'provider' ? 'provider' : context === 'admin' ? 'admin' : 'buyer'
    const density = resolveDensity(await getUiDensity(userId), surface)
    // Rail + tab bar only where the role's surfaces exist (a buyer mid-onboarding
    // in the provider group sees the plain shell).
    const role = focused ? null : context === 'msme' ? 'buyer' : context === 'provider' && hasProvider ? 'provider' : null
    return (
      // --tabbar-h: sticky action bars (requirement form, …) sit above the phone tab bar.
      <div data-ui="v3" data-density={density} className={role ? 'flex min-h-screen flex-col bg-background text-foreground [--tabbar-h:3.5rem] lg:[--tabbar-h:0px]' : 'flex min-h-screen flex-col bg-background text-foreground'}>
        <ActionsProvider>
          <ShellTopBar
            // A buyer's full results page; provider / admin shells use the public catalog.
            fullResultsPath={context === 'msme' ? '/app/search' : '/services'}
            brand={
              // Phones: the wordmark alone, a little smaller (the " Partner" / " Admin" suffix
              // joins from sm up; the tab bar already says which surface this is).
              <Link href={homeHref as '/app'} prefetch={false} className="shrink-0 text-[20px] font-bold leading-none tracking-tight text-primary sm:text-[22px]">
                AMClub<span className="hidden font-medium text-foreground-secondary sm:inline">{suffix}</span>
              </Link>
            }
            trailing={
              <>
                {context === 'msme' && <JurisdictionSelector className="hidden xl:inline-flex" />}
                <LanguageSwitcher />
                {context !== 'admin' && <NotificationBell href={notificationsHref} />}
                <AccountMenu
                  name={name}
                  email={email}
                  phone={phone}
                  context={context}
                  hasMsme={hasMsme}
                  hasProvider={hasProvider}
                  isAdmin={isAdmin}
                  density={density}
                  assistantHref={AGENT_ENABLED ? (context === 'msme' ? '/app/ai' : context === 'provider' && hasProvider ? '/partner/ai' : null) : null}
                />
              </>
            }
          />
          <div className="mx-auto flex w-full max-w-[1280px] flex-1 lg:px-6">
            {role && <SideRail role={role} martEnabled={MART_ENABLED} agentEnabled={AGENT_ENABLED} guide={isOnFor('guide', userId)} />}
            <main className={role ? 'min-w-0 flex-1 pb-24 lg:pb-10' : 'min-w-0 flex-1'}>{children}</main>
          </div>
          {role && <TabBar role={role} martEnabled={MART_ENABLED} />}
          {/* The assistant, minimised in the corner of every buyer / provider page (not in a focused task like checkout). */}
          {role && AGENT_ENABLED && <AssistantLauncher persona={role} />}
        </ActionsProvider>
        <LegalGate />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-2 px-4 sm:gap-4">
          <Link
            href={homeHref as '/app'}
            prefetch={false}
            className="shrink-0 font-display text-[22px] font-bold leading-none tracking-tight text-primary sm:text-[26px]"
          >
            AMClub<span className="hidden text-foreground-secondary sm:inline">{suffix}</span>
          </Link>
          <div className="flex h-10 min-w-0 items-center gap-1 sm:gap-2">
            {/* Jurisdiction is a buyer-discovery control — shown in the MSME shell. */}
            {context === 'msme' && <JurisdictionSelector className="hidden md:inline-flex" />}
            <LanguageSwitcher />
            {/* The bell links into the msme/provider notification centres — an
                admin clicking it would be dropped out of the admin shell. */}
            {context !== 'admin' && <NotificationBell href={notificationsHref} />}
            <AccountMenu name={name} email={email} phone={phone} context={context} hasMsme={hasMsme} hasProvider={hasProvider} isAdmin={isAdmin} />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      {/* Phase 2b — blocks the shell until current-version legal docs are accepted. */}
      <LegalGate />
    </div>
  )
}
