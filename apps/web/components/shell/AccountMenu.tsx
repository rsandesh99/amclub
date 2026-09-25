'use client'

import { useState, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { User, LogOut, Briefcase, Home, LifeBuoy, ChevronDown, Shield, Search, Rows3, Sparkles } from 'lucide-react'
import { useRouter } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

export type ShellContext = 'msme' | 'provider' | 'admin' | 'public'

interface AccountMenuProps {
  name: string | null
  /** Who is signed in when there is no name (the email, else the phone). */
  email?: string | null
  phone?: string | null
  context: ShellContext
  /** PROFILE existence, not role flags — every provider signup also gets the
   *  'msme' role, so roles overstate which surfaces actually exist. */
  hasMsme: boolean
  hasProvider: boolean
  isAdmin: boolean
  /** N33 — shown only in the v3 shell; toggles Comfortable ⇄ Compact. */
  density?: 'comfortable' | 'compact'
  /** The assistant home for this context (AGENT_ENABLED), or null. */
  assistantHref?: string | null
}

/** The avatar letter: the name's initial, else the email's first letter, else
 *  null (the avatar then shows a person icon, never "?"). */
export function avatarInitials(name: string | null, email?: string | null): string | null {
  const source = name?.trim() || (email ?? '').trim().split('@')[0] || ''
  const letter = Array.from(source).find((c) => /[\p{L}\p{N}]/u.test(c))
  return letter ? letter.toUpperCase() : null
}

/** Avatar dropdown: profile, role switch / become-provider, help, sign out.
 *  Shared across every logged-in surface (and the public header when logged in). */
export function AccountMenu({ name, email = null, phone = null, context, hasMsme, hasProvider, isAdmin, density, assistantHref = null }: AccountMenuProps) {
  const t = useTranslations('shell')
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const analytics = useAnalytics()

  async function toggleDensity() {
    const next = density === 'compact' ? 'comfortable' : 'compact'
    const res = await fetch('/api/v1/profile/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uiDensity: next }) })
    if (res.ok) {
      analytics.capture('density_changed', { density: next, surface: context })
      setOpen(false)
      router.refresh()
    }
  }

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function signOut() {
    setSigningOut(true)
    // Loaded on demand: the Supabase browser client (~50 KB gz) was the
    // largest script on every PUBLIC page purely because this menu imported
    // it for sign-out. Nothing else on a public page needs it.
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    await supabase.auth.signOut()
    // Shared-device hygiene (P0-6): no cached page or API response from this
    // session may survive for the next person on the device.
    const { purgeOfflineCaches } = await import('@/components/pwa/purge-caches')
    await purgeOfflineCaches()
    // Sign-out means session over: clear the gateway's saved mid-choreography
    // position and wizard drafts, so `/` restarts at the two doors instead of
    // resuming a stale half-finished application — and no PII (legal name,
    // GSTIN) from the signup drafts lingers on a shared computer.
    try {
      window.sessionStorage.removeItem('amc_gateway_pos_v1')
      window.localStorage.removeItem('amc_draft_profile_v1')
      window.localStorage.removeItem('amc_provider_draft_v1')
      window.localStorage.removeItem('amclub_provider_wizard_draft')
      window.localStorage.removeItem('amclub_rfq_draft')
    } catch {
      /* storage unavailable — sign-out still proceeds */
    }
    // Hard navigation clears all cached server state.
    window.location.href = '/'
  }

  const initials = avatarInitials(name, email)
  // The menu says who is signed in: the name, and the email (else the phone) under it.
  const identity = email || phone || null
  // Providers without a buyer profile must never be sent into /app/* — the
  // MSME pages bounce them through /signup?complete=1 (a confusing two-hop).
  const profileHref =
    context === 'provider' || (context === 'public' && hasProvider && !hasMsme)
      ? '/partner/profile'
      : '/app/profile'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        // Phones: the avatar alone (the chevron joins from sm up, where the header has room).
        className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface pl-1 pr-1 hover:border-primary/40 sm:pr-2"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {initials ?? (
            <>
              <User className="h-4 w-4" aria-hidden />
              <span className="sr-only">{t('profile')}</span>
            </>
          )}
        </span>
        <ChevronDown className="hidden h-3.5 w-3.5 text-foreground-secondary sm:block" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-card border border-border bg-surface py-1 shadow-card"
        >
          {(name || identity) && (
            <div className="border-b border-border px-3 py-2" data-testid="account-identity">
              {name && <p className="truncate text-sm font-medium">{name}</p>}
              {identity && <p className={cn('truncate', name ? 'text-xs text-foreground-secondary' : 'text-sm font-medium')}>{identity}</p>}
            </div>
          )}

          {context !== 'admin' && (
            <MenuLink href={profileHref} icon={User} label={t('profile')} onClick={() => setOpen(false)} />
          )}
          {assistantHref && (
            <MenuLink href={assistantHref} icon={Sparkles} label={t('assistant_menu')} onClick={() => setOpen(false)} />
          )}
          {/* E0 / U6 — /app/search was unreachable from the logged-in shell (interim until the E1 nav). */}
          {context === 'msme' && (
            <MenuLink href="/app/search" icon={Search} label={t('search')} onClick={() => setOpen(false)} />
          )}

          {/* Role switching / become a provider — driven by PROFILE existence. */}
          {context === 'msme' && hasProvider && (
            <MenuLink href="/partner" icon={Briefcase} label={t('provider_dashboard')} onClick={() => setOpen(false)} />
          )}
          {context === 'msme' && !hasProvider && (
            <MenuLink href="/partner/onboarding" icon={Briefcase} label={t('become_provider')} onClick={() => setOpen(false)} />
          )}
          {(context === 'provider' || context === 'admin') && hasMsme && (
            <MenuLink href="/app" icon={Home} label={t('msme_home')} onClick={() => setOpen(false)} />
          )}
          {context === 'provider' && !hasMsme && (
            <MenuLink href="/signup?complete=1" icon={Home} label={t('setup_buyer')} onClick={() => setOpen(false)} />
          )}
          {context === 'public' && (
            <MenuLink href={hasProvider ? '/partner' : '/app'} icon={Home} label={t('dashboard')} onClick={() => setOpen(false)} />
          )}
          {isAdmin && context !== 'admin' && (
            <MenuLink href="/admin/verifications" icon={Shield} label={t('admin_panel')} onClick={() => setOpen(false)} />
          )}

          {density && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={density === 'compact'}
              onClick={toggleDensity}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground hover:bg-primary/5"
            >
              <Rows3 className="h-4 w-4 text-foreground-secondary" />
              <span className="flex-1">{t('compact_view')}</span>
              <span className="text-xs text-foreground-secondary">{density === 'compact' ? t('on') : t('off')}</span>
            </button>
          )}
          <MenuLink href="/help" icon={LifeBuoy} label={t('help')} onClick={() => setOpen(false)} />

          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            disabled={signingOut}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-danger hover:bg-danger/5 disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" />
            {signingOut ? t('signing_out') : t('sign_out')}
          </button>
        </div>
      )}
    </div>
  )
}

function MenuLink({
  href, icon: Icon, label, onClick,
}: {
  href: string
  icon: typeof User
  label: string
  onClick: () => void
}) {
  return (
    <Link
      href={href as '/app'}
      // Signed-in, dynamic pages: opening the menu must not fire a burst of RSC prefetches (F10).
      prefetch={false}
      role="menuitem"
      onClick={onClick}
      className={cn('flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-primary/5')}
    >
      <Icon className="h-4 w-4 text-foreground-secondary" />
      {label}
    </Link>
  )
}
