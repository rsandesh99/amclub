'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Briefcase, Building2, ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'

type Door = 'msme' | 'provider'

/**
 * Scene 1 — the two doors. Entrance cascade (spec): headline block rises at
 * 550ms, MSME door 610ms, provider door 670ms, log-in line 730ms (the card
 * itself pops at 350ms, so these are absolute delays from page load).
 * Hover: 4px lift, deeper shadow, icon chip rotates 8°, chevron slides in.
 */
export function IntroDoors({ onPick }: { onPick: (door: Door, e: React.MouseEvent) => void }) {
  const t = useTranslations('gateway')
  const [hover, setHover] = useState<Door | null>(null)

  const doorBase =
    'flex min-h-[88px] w-full cursor-pointer items-center gap-4 rounded-2xl p-4 text-left font-sans ' +
    'transition-[transform,box-shadow,border-color] duration-200 ease-out motion-safe:active:scale-[0.97] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:px-5 sm:py-[18px]'

  const chip = (active: boolean) =>
    `inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] transition-transform duration-200 ease-out ${
      active ? 'motion-safe:rotate-[8deg]' : ''
    }`

  const chevron = (active: boolean) =>
    `ml-auto inline-flex shrink-0 transition-[opacity,transform] duration-200 ease-out ${
      active ? 'translate-x-0 opacity-100' : '-translate-x-2 opacity-0'
    }`

  return (
    <div className="flex flex-col gap-[22px]">
      <div className="gw-rise-sm" style={{ animationDelay: '550ms' }}>
        <div className="text-[11.5px] font-bold uppercase tracking-[0.12em] text-primary">
          {t('eyebrow')}
        </div>
        <h1 className="mt-2 font-display text-[27px] font-extrabold leading-[1.15] tracking-[-0.02em] text-foreground [text-wrap:pretty] sm:text-[34px] sm:leading-[1.12]">
          {t('headline')}
        </h1>
      </div>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={(e) => onPick('msme', e)}
          onMouseEnter={() => setHover('msme')}
          onMouseLeave={() => setHover(null)}
          className={`${doorBase} gw-rise-sm border-none bg-primary motion-safe:hover:-translate-y-1`}
          style={{
            animationDelay: '610ms',
            boxShadow:
              hover === 'msme'
                ? '0 18px 34px -12px rgba(16,30,24,0.5)'
                : '0 6px 16px -8px rgba(16,30,24,0.35)',
          }}
        >
          <span className={`${chip(hover === 'msme')} bg-accent text-[#3A2A00]`}>
            <Building2 className="h-6 w-6" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="text-lg font-bold leading-tight text-white [text-wrap:pretty]">
              {t('msme_title')}
            </span>
            <span className="text-[13.5px] leading-[1.4] text-white/[0.82] [text-wrap:pretty]">
              {t('msme_sub')}
            </span>
          </span>
          <span className={`${chevron(hover === 'msme')} text-white/90`}>
            <ChevronRight className="h-5 w-5" strokeWidth={2.5} aria-hidden />
          </span>
        </button>

        <button
          type="button"
          onClick={(e) => onPick('provider', e)}
          onMouseEnter={() => setHover('provider')}
          onMouseLeave={() => setHover(null)}
          className={`${doorBase} gw-rise-sm border-[1.5px] bg-white motion-safe:hover:-translate-y-1`}
          style={{
            animationDelay: '670ms',
            borderColor: 'color-mix(in srgb, var(--primary) 35%, var(--border))',
            boxShadow:
              hover === 'provider'
                ? '0 18px 34px -12px rgba(16,30,24,0.28)'
                : 'var(--shadow-resting)',
          }}
        >
          <span className={`${chip(hover === 'provider')} bg-primary-soft text-primary`}>
            <Briefcase className="h-6 w-6" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="text-lg font-bold leading-tight text-primary [text-wrap:pretty]">
              {t('prov_title')}
            </span>
            <span className="text-[13.5px] leading-[1.4] text-foreground-secondary [text-wrap:pretty]">
              {t('prov_sub')}
            </span>
          </span>
          <span className={`${chevron(hover === 'provider')} text-primary`}>
            <ChevronRight className="h-5 w-5" strokeWidth={2.5} aria-hidden />
          </span>
        </button>
      </div>

      <div
        className="gw-rise-sm text-center text-[13.5px] text-foreground-secondary"
        style={{ animationDelay: '730ms' }}
      >
        {t('login_pre')}{' '}
        <Link
          href="/login"
          className="font-semibold text-primary underline underline-offset-[3px] hover:no-underline"
        >
          {t('login_link')}
        </Link>
      </div>
    </div>
  )
}
