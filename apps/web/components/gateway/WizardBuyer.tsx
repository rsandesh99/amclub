'use client'

import { useTranslations } from 'next-intl'
import { ChevronLeft } from 'lucide-react'
import { OptionButton } from './OptionButton'
import { ProgressDots } from './ProgressDots'
import {
  BAND_KEY,
  BAND_OPTIONS,
  BIZ_OPTIONS,
  GATEWAY_CATEGORIES,
  catKey,
} from './constants'
import { GATEWAY_STATES } from './draft'

interface WizardBuyerProps {
  step: number
  picked: string | null
  onAnswer: (field: 'biz' | 'cat' | 'band' | 'state', value: string, e?: React.MouseEvent) => void
  onBack: () => void
  onSkip: () => void
}

/**
 * Scene 3 (buyer) — 4 card-morph steps: business type → need → size band →
 * state. Each step slides in (gwSlideIn 350ms); an answer pops the marigold
 * tick and auto-advances after 250ms (timing owned by Gateway.tsx).
 */
export function WizardBuyer({ step, picked, onAnswer, onBack, onSkip }: WizardBuyerProps) {
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
        <div key="s0" className="gw-slide-in flex flex-col gap-5">
          <h2 className={heading}>{t('q1')}</h2>
          <div className="flex flex-col gap-[11px]">
            {BIZ_OPTIONS.map((v) => (
              <OptionButton
                key={v}
                variant="row"
                label={t(`biz_${v}`)}
                sub={t(`biz_${v}_sub`)}
                picked={picked === v}
                onClick={() => onAnswer('biz', v)}
              />
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div key="s1" className="gw-slide-in flex flex-col gap-[18px]">
          <h2 className={heading}>{t('q2')}</h2>
          <div className="grid grid-cols-2 gap-2.5">
            {GATEWAY_CATEGORIES.map(({ slug, icon }) => (
              <OptionButton
                key={slug}
                variant="need"
                label={t(`need_${catKey(slug)}`)}
                sub={t(`cat_${catKey(slug)}`)}
                icon={icon}
                picked={picked === slug}
                onClick={() => onAnswer('cat', slug)}
              />
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div key="s2" className="gw-slide-in flex flex-col gap-5">
          <h2 className={heading}>{t('q3')}</h2>
          <div className="flex flex-col gap-[11px]">
            {BAND_OPTIONS.map((v) => (
              <OptionButton
                key={v}
                variant="row-plain"
                label={t(BAND_KEY[v])}
                picked={picked === v}
                onClick={() => onAnswer('band', v)}
              />
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div key="s3" className="gw-slide-in flex flex-col gap-4">
          <div>
            <h2 className={heading}>{t('q4')}</h2>
            <p className="mb-0 mt-1.5 text-[13.5px] text-foreground-secondary">{t('q4_note')}</p>
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

      <div className="mt-auto flex items-center justify-between pt-1.5">
        <button
          type="button"
          onClick={onSkip}
          className="min-h-11 cursor-pointer border-none bg-transparent p-0 font-sans text-[13.5px] font-semibold text-foreground-secondary underline underline-offset-[3px] transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {t('skip')}
        </button>
        <ProgressDots step={step} />
      </div>
    </div>
  )
}
