import { Link } from '@/i18n/navigation'
import { resolveDensity } from '@amclub/shared'
import { LanguageSwitcher } from '@/components/catalog/LanguageSwitcher'
import { JurisdictionSelector } from '@/components/catalog/JurisdictionSelector'
import { NotificationBell } from './NotificationBell'
import { AccountMenu, type ShellContext } from './AccountMenu'
import { LegalGate } from '@/components/legal/LegalGate'
import { isOnFor } from '@/lib/experiments'
import { getUiDensity } from '@/lib/auth/session'
import { MART_ENABLED } from '@/lib/flags'
import { ActionsProvider } from '@/components/shell-v3/ActionsProvider'
import { ShellTopBar } from '@/components/shell-v3/ShellTopBar'
import { SideRail, TabBar } from '@/components/shell-v3/NavBars'

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
  roles,
  userId,
  hasMsmeProfile,
  hasProviderProfile,
  children,
}: {
  context: ShellContext
  name: string | null
  roles: string[]
  /** Needed for the v3 flag bucket and the density preference. */
  userId?: string
  /** PROFILE existence (not roles) — every provider signup also carries the
   *  'msme' role, so role flags overstate what surfaces actually exist. */
  hasMsmeProfile?: boolean
  hasProviderProfile?: boolean
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
    const role = context === 'msme' ? 'buyer' : context === 'provider' && hasProvider ? 'provider' : null
    return (
      <div data-ui="v3" data-density={density} className="flex min-h-screen flex-col bg-background text-foreground">
        <ActionsProvider>
          <ShellTopBar
            brand={
              <Link href={homeHref as '/app'} className="shrink-0 text-[22px] font-bold leading-none tracking-tight text-primary">
                AMClub<span className="font-medium text-foreground-secondary">{suffix}</span>
              </Link>
            }
            trailing={
              <>
                {context === 'msme' && <JurisdictionSelector className="hidden xl:inline-flex" />}
                <LanguageSwitcher />
                {context !== 'admin' && <NotificationBell href={notificationsHref} />}
                <AccountMenu name={name} context={context} hasMsme={hasMsme} hasProvider={hasProvider} isAdmin={isAdmin} density={density} />
              </>
            }
          />
          <div className="mx-auto flex w-full max-w-[1280px] flex-1 lg:px-6">
            {role && <SideRail role={role} martEnabled={MART_ENABLED} />}
            <main className={role ? 'min-w-0 flex-1 pb-24 lg:pb-10' : 'min-w-0 flex-1'}>{children}</main>
          </div>
          {role && <TabBar role={role} martEnabled={MART_ENABLED} />}
        </ActionsProvider>
        <LegalGate />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
          <Link
            href={homeHref as '/app'}
            className="font-display text-[26px] font-bold leading-none tracking-tight text-primary"
          >
            AMClub<span className="text-foreground-secondary">{suffix}</span>
          </Link>
          <div className="flex h-10 items-center gap-2">
            {/* Jurisdiction is a buyer-discovery control — shown in the MSME shell. */}
            {context === 'msme' && <JurisdictionSelector className="hidden md:inline-flex" />}
            <LanguageSwitcher />
            {/* The bell links into the msme/provider notification centres — an
                admin clicking it would be dropped out of the admin shell. */}
            {context !== 'admin' && <NotificationBell href={notificationsHref} />}
            <AccountMenu name={name} context={context} hasMsme={hasMsme} hasProvider={hasProvider} isAdmin={isAdmin} />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      {/* Phase 2b — blocks the shell until current-version legal docs are accepted. */}
      <LegalGate />
    </div>
  )
}
