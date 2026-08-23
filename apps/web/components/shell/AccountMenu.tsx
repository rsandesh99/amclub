'use client'

import { useState, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { User, LogOut, Briefcase, Home, LifeBuoy, ChevronDown, Shield } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

export type ShellContext = 'msme' | 'provider' | 'admin' | 'public'

interface AccountMenuProps {
  name: string | null
  context: ShellContext
  /** PROFILE existence, not role flags — every provider signup also gets the
   *  'msme' role, so roles overstate which surfaces actually exist. */
  hasMsme: boolean
  hasProvider: boolean
  isAdmin: boolean
}

/** Avatar dropdown: profile, role switch / become-provider, help, sign out.
 *  Shared across every logged-in surface (and the public header when logged in). */
export function AccountMenu({ name, context, hasMsme, hasProvider, isAdmin }: AccountMenuProps) {
  const t = useTranslations('shell')
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  async function signOut() {
    setSigningOut(true)
    const supabase = createClient()
    await supabase.auth.signOut()
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

  const initial = (name ?? '?').charAt(0).toUpperCase()
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
        className="flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pl-1 pr-2 hover:border-primary/40"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
          {initial}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-foreground-secondary" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-card border border-border bg-surface py-1 shadow-card"
        >
          {name && (
            <div className="border-b border-border px-3 py-2">
              <p className="truncate text-sm font-medium">{name}</p>
            </div>
          )}

          {context !== 'admin' && (
            <MenuLink href={profileHref} icon={User} label={t('profile')} onClick={() => setOpen(false)} />
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
      role="menuitem"
      onClick={onClick}
      className={cn('flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-primary/5')}
    >
      <Icon className="h-4 w-4 text-foreground-secondary" />
      {label}
    </Link>
  )
}
