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
  children,
}: {
  context: ShellContext
  name: string | null
  roles: string[]
  children: React.ReactNode
}) {
  const isMsme = roles.includes('msme')
  const isProvider = roles.includes('provider')
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
            <NotificationBell href={notificationsHref} />
            <AccountMenu name={name} context={context} isMsme={isMsme} isProvider={isProvider} isAdmin={isAdmin} />
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  )
}
