'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRight, MessageCircle, Mic, Sparkles, X } from 'lucide-react'
import { Link, usePathname } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { cn } from '@/lib/utils'

export const LAUNCHER_PREF_KEY = 'amc_assistant_button'
export const LAUNCHER_PREF_EVENT = 'amc:assistant-button'

/** Per device: 'hidden' once someone hides the corner button (the assistant home brings it back). */
export function readLauncherHidden(): boolean {
  try { return localStorage.getItem(LAUNCHER_PREF_KEY) === 'hidden' } catch { return false }
}
export function writeLauncherHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(LAUNCHER_PREF_KEY, 'hidden')
    else localStorage.removeItem(LAUNCHER_PREF_KEY)
  } catch { /* a convenience only */ }
  window.dispatchEvent(new Event(LAUNCHER_PREF_EVENT))
}

interface Availability { on: Record<string, boolean>; allowed: boolean }
interface Action { key: string; href: string; icon: 'mic' | 'chat' | 'spark' }

function actionIcon(name: Action['icon']) {
  if (name === 'mic') return <Mic className="h-4 w-4" aria-hidden />
  if (name === 'chat') return <MessageCircle className="h-4 w-4" aria-hidden />
  return <Sparkles className="h-4 w-4" aria-hidden />
}

/**
 * The assistant, minimised in the bottom corner of every signed-in page
 * (AGENT_ENABLED; the shell mounts it). A tap opens a small panel of what the
 * assistant can do for this person right now: the capabilities that are on for
 * them (read on first open from /api/v1/agent/assistant), and always the way to
 * the assistant home. It sits above any bottom bar (tab bar, sticky actions),
 * measured from `[data-bottom-bar]`.
 */
export function AssistantLauncher({ persona }: { persona: 'buyer' | 'provider' }) {
  const t = useTranslations('assistant_home.launcher')
  const analytics = useAnalytics()
  const pathname = usePathname()
  const [hidden, setHidden] = useState(true)
  const [open, setOpen] = useState(false)
  const [avail, setAvail] = useState<Availability | null>(null)
  const [lift, setLift] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const home = persona === 'buyer' ? '/app/ai' : '/partner/ai'

  useEffect(() => {
    const sync = () => setHidden(readLauncherHidden())
    sync()
    window.addEventListener(LAUNCHER_PREF_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(LAUNCHER_PREF_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])

  // Close on navigation.
  useEffect(() => { setOpen(false) }, [pathname])

  // Stay above whatever is pinned to the bottom of the window.
  useEffect(() => {
    if (hidden) return
    let raf = 0
    const measure = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        let h = 0
        document.querySelectorAll<HTMLElement>('[data-bottom-bar]').forEach((el) => {
          const r = el.getBoundingClientRect()
          // Pinned at (or floating just above) the bottom edge: the tab bar, sticky actions, the compare tray.
          if (r.height > 0 && r.bottom >= window.innerHeight - 120) h = Math.max(h, window.innerHeight - r.top)
        })
        setLift(h)
      })
    }
    measure()
    const mo = new MutationObserver(measure)
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    return () => { cancelAnimationFrame(raf); mo.disconnect(); window.removeEventListener('resize', measure) }
  }, [hidden, pathname])

  const load = useCallback(async () => {
    if (avail) return
    const d = await fetch(`/api/v1/agent/assistant?persona=${persona}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    setAvail(d ? { on: d.on ?? {}, allowed: !!d.allowed } : { on: {}, allowed: false })
  }, [avail, persona])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) { void load(); analytics.capture('assistant_launcher_opened', { persona, path: pathname }) }
  }

  // Escape and outside clicks close the panel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus() } }
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [open])

  if (hidden) return null

  const on = avail?.on ?? {}
  const actions: Action[] = persona === 'buyer'
    ? [
        { key: 'describe', href: '/app/rfq/new?entry=assistant', icon: 'mic' },
        ...(on['procurement'] ? [{ key: 'buying_chat', href: '/app/assistant', icon: 'chat' } as Action] : []),
        ...(on['support'] ? [{ key: 'order_help', href: '/app/support', icon: 'chat' } as Action] : []),
      ]
    : [
        ...(on['munshi'] ? [{ key: 'munshi', href: '/partner/munshi', icon: 'spark' } as Action] : []),
        { key: 'new_requests', href: '/partner/rfqs', icon: 'spark' },
        ...(on['provider_support'] ? [{ key: 'order_help', href: '/partner/support', icon: 'chat' } as Action] : []),
      ]

  return (
    <div
      className="pointer-events-none fixed right-4 z-40 flex flex-col items-end gap-3 lg:right-6"
      style={{ bottom: `calc(${lift}px + 1rem + env(safe-area-inset-bottom, 0px))` }}
      data-testid="assistant-launcher"
    >
      {open && (
        <div
          ref={panel}
          id="assistant-launcher-panel"
          role="dialog"
          aria-label={t('title')}
          className="pointer-events-auto w-[min(22rem,calc(100vw-2rem))] rounded-sheet border border-border bg-surface p-4 shadow-modal"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground"><Sparkles className="h-4 w-4" aria-hidden /></span>
              <div>
                <p className="t-headline text-foreground">{t('title')}</p>
                <p className="t-footnote text-foreground-secondary">{t(persona === 'buyer' ? 'greeting_buyer' : 'greeting_provider')}</p>
              </div>
            </div>
            <button type="button" onClick={() => { setOpen(false); button.current?.focus() }} aria-label={t('minimise')} className="-mr-1 inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground-secondary hover:bg-foreground/5">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <ul className="mt-3 space-y-1.5">
            {actions.map((a) => (
              <li key={a.key}>
                <Link
                  href={a.href as '/app'}
                  onClick={() => analytics.capture('assistant_launcher_action', { persona, action: a.key })}
                  className="flex items-center gap-3 rounded-button border border-border px-3 py-2.5 text-left hover:border-primary/40 hover:bg-primary/5"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">{actionIcon(a.icon)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground">{t(`action_${a.key}`)}</span>
                    <span className="block text-xs text-foreground-secondary">{t(`action_${a.key}_sub`)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          {avail && !avail.allowed && (
            <p className="mt-3 rounded-button bg-muted p-2.5 text-xs text-foreground-secondary">{t('not_allowed')}</p>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <Link href={home as '/app'} onClick={() => analytics.capture('assistant_launcher_action', { persona, action: 'home' })} className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
              {t('learn')} <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <button
              type="button"
              onClick={() => { writeLauncherHidden(true); analytics.capture('assistant_launcher_hidden', { persona }) }}
              className="text-xs text-foreground-secondary underline-offset-2 hover:underline"
            >
              {t('hide')}
            </button>
          </div>
        </div>
      )}

      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={open ? 'assistant-launcher-panel' : undefined}
        aria-label={open ? t('minimise') : t('open')}
        className={cn(
          'pointer-events-auto inline-flex h-12 items-center gap-2 rounded-full bg-primary pl-3.5 pr-4 text-sm font-semibold text-primary-foreground shadow-modal transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
        )}
        data-testid="assistant-launcher-button"
      >
        {open ? <X className="h-5 w-5" aria-hidden /> : <Sparkles className="h-5 w-5" aria-hidden />}
        <span className="hidden sm:inline">{t('label')}</span>
      </button>
    </div>
  )
}
