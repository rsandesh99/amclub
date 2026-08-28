'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { resolvePostAuthRoute } from '@/lib/auth/post-auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { INDIAN_STATES } from '@/lib/constants/india'
import { loadBuyerDraft } from '@/components/gateway/draft'
import { ConsentCheckbox } from '@/components/auth/ConsentCheckbox'
import { acceptLegalDocs } from '@/lib/legal/client'
import { BUYER_LEGAL_DOCS } from '@amclub/shared'

type Step = 'auth' | 'profile' | 'business'

interface WizardState {
  fullName: string
  businessName: string
  sector: string
  stateCode: string
  city: string
  udyamNumber: string
  gstin: string
  preferredLocale: string
}

interface MsmeWizardProps {
  /** True when the user is already authenticated (e.g. via Google/email) and
   *  only needs to complete their profile. */
  skipAuth?: boolean
}

export function MsmeWizard({ skipAuth }: MsmeWizardProps) {
  const t = useTranslations('msme_signup')
  const tAuth = useTranslations('auth')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const locale = useLocale()

  const [step, setStep] = useState<Step>(skipAuth ? 'profile' : 'auth')
  const [wizardState, setWizardState] = useState<WizardState>({
    fullName: '',
    businessName: '',
    sector: '',
    stateCode: '',
    city: '',
    udyamNumber: '',
    gstin: '',
    preferredLocale: 'en',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Phase 2b — explicit Terms + Privacy consent. Ticked on the auth step, or on
  // the profile step for users who arrive already authenticated (Google/email
  // → /signup?complete=1). Written to terms_acceptances right before the
  // profile POST, which refuses without it.
  const [consented, setConsented] = useState(false)

  // Phase 8a — prefill from the gateway wizard's draft profile (biz → sector,
  // state → stateCode; both enums match 1:1). Effect, not initial state:
  // localStorage is unavailable during SSR/hydration of this page.
  useEffect(() => {
    const draft = loadBuyerDraft()
    if (!draft) return
    setWizardState((s) => ({
      ...s,
      sector: s.sector || (draft.biz ?? ''),
      stateCode: s.stateCode || (draft.state ?? ''),
      // preferred_locale is en/hi in the DB (notifications §Phase 6); te/ta
      // gateway visitors keep the 'en' default until those channels exist.
      preferredLocale: locale === 'hi' ? 'hi' : s.preferredLocale,
    }))
  }, [locale])

  const stepOrder: Step[] = skipAuth ? ['profile', 'business'] : ['auth', 'profile', 'business']
  const currentIdx = stepOrder.indexOf(step)
  const progress = ((currentIdx + 1) / stepOrder.length) * 100

  function update(patch: Partial<WizardState>) {
    setWizardState((s) => ({ ...s, ...patch }))
  }

  // Returning user → role home; brand-new user → continue to the profile step.
  async function handleAuthenticated() {
    const { isNew, destination } = await resolvePostAuthRoute()
    if (isNew) setStep('profile')
    else router.push(destination)
  }

  async function submitBusiness(skip = false) {
    if (!consented) {
      setError(tAuth('consent_required'))
      return
    }
    setLoading(true)
    setError('')
    try {
      // Acceptance rows first — the profile endpoint is gated on them.
      const legal = await acceptLegalDocs([...BUYER_LEGAL_DOCS], wizardState.preferredLocale)
      if (!legal.ok) throw new Error(t('save_failed'))
      const res = await fetch('/api/v1/profile/msme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: wizardState.fullName,
          businessName: wizardState.businessName,
          sector: skip ? undefined : wizardState.sector || undefined,
          state: skip ? undefined : wizardState.stateCode || undefined,
          city: skip ? undefined : wizardState.city || undefined,
          udyamNumber: skip ? undefined : wizardState.udyamNumber || undefined,
          gstin: skip ? undefined : wizardState.gstin || undefined,
          preferredLocale: wizardState.preferredLocale,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(typeof d.error === 'string' ? d.error : t('save_failed'))
      }
      router.push('/app')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('save_failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Progress value={progress} />

      {step === 'auth' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('step1_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('step1_subtitle')}</p>
          </div>
          <AuthPanel
            onAuthenticated={handleAuthenticated}
            googleRedirectTo="/signup?complete=1"
            consent={{ checked: consented, onChange: setConsented }}
          />
        </>
      )}

      {step === 'profile' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('step2_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('step2_subtitle')}</p>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fullName">{tAuth('name_label')}</Label>
              <Input
                id="fullName"
                placeholder={tAuth('name_placeholder')}
                value={wizardState.fullName}
                onChange={(e) => update({ fullName: e.target.value })}
                autoComplete="name"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="businessName">{tAuth('business_name_label')}</Label>
              <Input
                id="businessName"
                placeholder={tAuth('business_name_placeholder')}
                value={wizardState.businessName}
                onChange={(e) => update({ businessName: e.target.value })}
                autoComplete="organization"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="locale">{t('language_label')}</Label>
              <Select
                id="locale"
                value={wizardState.preferredLocale}
                onChange={(e) => update({ preferredLocale: e.target.value })}
              >
                <option value="en">English</option>
                <option value="hi">हिंदी</option>
              </Select>
            </div>
            {/* Already-authenticated arrivals never saw the auth step — consent here. */}
            {!consented && <ConsentCheckbox checked={consented} onChange={setConsented} id="legal-consent-profile" />}
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button
              onClick={() => {
                if (!wizardState.fullName.trim() || !wizardState.businessName.trim()) {
                  setError(t('err_name_business'))
                  return
                }
                if (!consented) {
                  setError(tAuth('consent_required'))
                  return
                }
                setError('')
                setStep('business')
              }}
              className="w-full"
            >
              {tCommon('continue')}
            </Button>
          </div>
        </>
      )}

      {step === 'business' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('step3_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('step3_subtitle')}</p>
          </div>
          <p className="rounded-button bg-accent/10 px-3 py-2 text-xs text-warning">
            {t('rfq_notice')}
          </p>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sector">{t('sector_label')}</Label>
              <Select
                id="sector"
                value={wizardState.sector}
                onChange={(e) => update({ sector: e.target.value })}
                placeholder="— Select sector —"
              >
                <option value="manufacturing">{t('sector_manufacturing')}</option>
                <option value="trade">{t('sector_trade')}</option>
                <option value="services">{t('sector_services')}</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stateCode">{t('state_label')}</Label>
              <Select
                id="stateCode"
                value={wizardState.stateCode}
                onChange={(e) => update({ stateCode: e.target.value })}
                placeholder="— Select state —"
              >
                {INDIAN_STATES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="city">{t('city_label')}</Label>
              <Input
                id="city"
                placeholder={t('city_placeholder')}
                value={wizardState.city}
                onChange={(e) => update({ city: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="udyam">{t('udyam_label')}</Label>
              <Input
                id="udyam"
                placeholder="UDYAM-XX-00-0000000"
                value={wizardState.udyamNumber}
                onChange={(e) => update({ udyamNumber: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gstin">{t('gstin_label')}</Label>
              <Input
                id="gstin"
                placeholder="29ABCDE1234F1Z5"
                value={wizardState.gstin}
                onChange={(e) => update({ gstin: e.target.value.toUpperCase() })}
              />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button onClick={() => submitBusiness(false)} loading={loading} className="w-full">
              {t('done')}
            </Button>
            <Button variant="ghost" onClick={() => submitBusiness(true)} disabled={loading} className="w-full">
              {t('skip_business')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
