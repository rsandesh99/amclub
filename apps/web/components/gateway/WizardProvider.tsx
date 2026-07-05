'use client'

import { useTranslations } from 'next-intl'
import { ChevronLeft } from 'lucide-react'
import { OptionButton } from './OptionButton'
import { ProgressDots } from './ProgressDots'
import { CRED_OPTIONS, EXP_KEY, EXP_OPTIONS, GATEWAY_CATEGORIES, catKey } from './constants'
import { GATEWAY_STATES } from './draft'

interface WizardProviderProps {
  step: number
  picked: string | null
  onAnswer: (field: 'cat' | 'cred' | 'exp' | 'state', value: string) => void
  onBack: () => void
}

/**
 * Scene 3 (provider) — category → credential → experience → state. Same
 * card-morph choreography as the buyer wizard; no skip (a partner application
 * without these answers has nothing to review).
 */
export function WizardProvider({ step, picked, onAnswer, onBack }: WizardProviderProps) {
  const t = useTranslations('gateway')

  const heading =
    'm-0 font-display text-[22px] font-extrabold leading-[1.2] tracking-[-0.015em] text-foreground [text-wrap:pretty] sm:text-[27px] sm:leading-[1.15] sm:tracking-[-0.018em]'

  return (
    <div className="flex min-h-[380px] flex-col gap-[18px]">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('back')}
          className="-ml-2.5 -mt-2 inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl border-none bg-transparent text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ChevronLeft className="h-[21px] w-[21px]" aria-hidden />
        </button>
        <span className="text-[12.5px] font-semibold text-foreground-secondary">
          {t('step_of', { n: step + 1 })}
        </span>
      </div>

      {step === 0 && (
        <div key="p0" className="gw-slide-in flex flex-col gap-[18px]">
          <h2 className={heading}>{t('pq1')}</h2>
          <div className="grid grid-cols-2 gap-2.5">
            {GATEWAY_CATEGORIES.map(({ slug, icon }) => (
              <OptionButton
                key={slug}
                variant="category"
                label={t(`cat_${catKey(slug)}`)}
                icon={icon}
                picked={picked === slug}
                onClick={() => onAnswer('cat', slug)}
              />
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div key="p1" className="gw-slide-in flex flex-col gap-[18px]">
          <h2 className={heading}>{t('pq2')}</h2>
          <div className="flex flex-col gap-[11px]">
            {CRED_OPTIONS.map((v) => (
              <OptionButton
                key={v}
                variant="row"
                label={t(`cred_${v}`)}
                sub={t(`cred_${v}_sub`)}
                picked={picked === v}
                onClick={() => onAnswer('cred', v)}
              />
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div key="p2" className="gw-slide-in flex flex-col gap-5">
          <h2 className={heading}>{t('pq3')}</h2>
          <div className="flex flex-col gap-[11px]">
            {EXP_OPTIONS.map((v) => (
              <OptionButton
                key={v}
                variant="row-plain"
                label={t(EXP_KEY[v])}
                picked={picked === v}
                onClick={() => onAnswer('exp', v)}
              />
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div key="p3" className="gw-slide-in flex flex-col gap-4">
          <div>
            <h2 className={heading}>{t('pq4')}</h2>
            <p className="mb-0 mt-1.5 text-[13.5px] text-foreground-secondary">{t('pq4_note')}</p>
          </div>
          <div className="grid grid-cols-2 gap-[9px]">
            {GATEWAY_STATES.map((code) => (
              <OptionButton
                key={code}
                variant="state"
                label={t(`state_${code}`)}
                picked={picked === code}
                onClick={() => onAnswer('state', code)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto flex items-center justify-end pt-1.5">
        <ProgressDots step={step} />
      </div>
    </div>
  )
}
