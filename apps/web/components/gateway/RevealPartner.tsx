'use client'

import { useTranslations } from 'next-intl'
import { ShieldCheck } from 'lucide-react'
import { useRouter } from '@/i18n/navigation'
import { RevealHeader } from './RevealHeader'
import { RevealFooter } from './RevealFooter'
import { catKey, EXP_KEY } from './constants'
import type { ProviderDraft } from './draft'
import type { AppLocale } from '@/i18n/routing'

interface RevealPartnerProps {
  answers: ProviderDraft
  onStartOver: () => void
  onSelectLocale: (locale: AppLocale) => void
  track: (event: string, props?: Record<string, unknown>) => void
}

/**
 * Provider reveal — application review. "Send application" goes straight into
 * the REAL partner signup/KYC wizard (which reads the gateway draft as
 * prefill) — no fake success state like the mock.
 */
export function RevealPartner({ answers, onStartOver, onSelectLocale, track }: RevealPartnerProps) {
  const t = useTranslations('gateway')
  const router = useRouter()

  const chips = [
    answers.cat ? t(`cat_${catKey(answers.cat)}`) : null,
    answers.cred ? t(`cred_${answers.cred}`) : null,
    answers.exp ? t(EXP_KEY[answers.exp]) : null,
    answers.state ? t(`state_${answers.state}`) : null,
  ].filter((c): c is string => Boolean(c))

  const how = [1, 2, 3].map((n) => ({
    n,
    title: t(`phow_${n}_t`),
    sub: t(`phow_${n}_s`),
  }))

  function submit() {
    track('gateway_provider_application_submitted', {
      category: answers.cat,
      state: answers.state,
    })
    router.push('/partner/signup')
  }

  return (
    <div className="gw-fade-fast absolute inset-0 flex flex-col overflow-y-auto overscroll-contain bg-background">
      <RevealHeader
        label={t('partner_label')}
        onStartOver={onStartOver}
        onSelectLocale={onSelectLocale}
      />

      <main className="mx-auto flex w-full max-w-[760px] flex-col gap-[22px] px-4 pb-[88px] pt-6 sm:px-10 sm:pb-24 sm:pt-9">
        <div className="gw-rise" style={{ animationDelay: '100ms' }}>
          <h1 className="mb-0 mt-3 font-display text-[26px] font-extrabold leading-[1.2] tracking-[-0.02em] text-foreground [text-wrap:pretty] sm:text-[34px] sm:leading-[1.15]">
            {t('papply_title')}
          </h1>
          <div className="mt-2 flex items-start gap-1.5 text-sm leading-[1.45] text-foreground-secondary">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{t('papply_meta')}</span>
          </div>
        </div>

        <div
          className="gw-rise rounded-[14px] border border-border bg-surface px-4 py-5 shadow-resting sm:px-[22px]"
          style={{ animationDelay: '200ms' }}
        >
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <span
                  key={c}
                  className="rounded-chip bg-primary-soft px-3.5 py-1.5 text-sm font-semibold text-primary"
                >
                  {c}
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={submit}
              className="inline-flex min-h-11 items-center gap-2 self-start rounded-button bg-primary px-5 py-2.5 font-sans text-base font-semibold text-white transition-colors hover:bg-primary-strong motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {t('psubmit')}
            </button>
          </div>
        </div>

        <div className="gw-rise flex flex-col gap-3.5" style={{ animationDelay: '300ms' }}>
          <h2 className="m-0 font-display text-xl font-bold tracking-[-0.01em] text-foreground">
            {t('phow_title')}
          </h2>
          {how.map((h) => (
            <div key={h.n} className="flex items-start gap-3.5">
              <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-chip bg-primary-soft font-display text-[15px] font-bold text-primary">
                {h.n}
              </span>
              <div className="flex flex-col gap-0.5">
                <div className="text-base font-semibold text-foreground">{h.title}</div>
                <div className="text-sm leading-normal text-foreground-secondary [text-wrap:pretty]">
                  {h.sub}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>

      <RevealFooter />
    </div>
  )
}
