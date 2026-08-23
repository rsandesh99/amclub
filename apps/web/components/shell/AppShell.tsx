import { Link } from '@/i18n/navigation'
import { LanguageSwitcher } from '@/components/catalog/LanguageSwitcher'
import { JurisdictionSelector } from '@/components/catalog/JurisdictionSelector'
import { NotificationBell } from './NotificationBell'
import { AccountMenu, type ShellContext } from './AccountMenu'

/**
 * Shared chrome for every logged-in surface (MSME / provider / admin). One
 * header, one account menu (profile, role switch, help, sign out) — no more
 * per-page headers or dead-end inner pages.
 */
export function AppShell({
  context,
  name,
  roles,
  hasMsmeProfile,
  hasProviderProfile,
  children,
}: {
  context: ShellContext
  name: string | null
  roles: string[]
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

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
          <Link href={homeHref as '/app'} className="font-display text-lg font-bold text-primary">
            AMClub<span className="text-foreground-secondary">{suffix}</span>
          </Link>
          <div className="flex items-center gap-2">
            {/* Jurisdiction is a buyer-discovery control — shown in the MSME shell. */}
            {context === 'msme' && <JurisdictionSelector className="hidden sm:inline-flex" />}
            <LanguageSwitcher />
            {/* The bell links into the msme/provider notification centres — an
                admin clicking it would be dropped out of the admin shell. */}
            {context !== 'admin' && <NotificationBell href={notificationsHref} />}
            <AccountMenu name={name} context={context} hasMsme={hasMsme} hasProvider={hasProvider} isAdmin={isAdmin} />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  )
}
