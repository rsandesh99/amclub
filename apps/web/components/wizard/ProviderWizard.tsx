'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { PhoneStep } from '@/components/auth/PhoneStep'
import { OtpStep } from '@/components/auth/OtpStep'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { INDIAN_STATES } from '@/lib/constants/india'
import { CATEGORY_LIST } from '@amclub/shared'

type Step = 'phone' | 'otp' | 'business' | 'kyc' | 'bank' | 'submit' | 'under_review'

const DRAFT_KEY = 'amclub_provider_wizard_draft'

interface Draft {
  phone: string
  email: string
  legalName: string
  displayName: string
  about: string
  gstin: string
  gstinVerified: boolean
  gstinStub: boolean
  pan: string
  categorySlugs: string[]
  stateCode: string
  city: string
  languages: string[]
  bankIfsc: string
  bankAccount: string
  bankHolder: string
  bankVerified: boolean
  bankStub: boolean
  credentialUploads: Record<string, { url: string; name: string }>
}

const EMPTY: Draft = {
  phone: '', email: '', legalName: '', displayName: '', about: '',
  gstin: '', gstinVerified: false, gstinStub: false, pan: '',
  categorySlugs: [], stateCode: '', city: '', languages: ['en'],
  bankIfsc: '', bankAccount: '', bankHolder: '',
  bankVerified: false, bankStub: false, credentialUploads: {},
}

interface ProviderWizardProps {
  skipAuth?: boolean
  initialPhone?: string
}

export function ProviderWizard({ skipAuth, initialPhone }: ProviderWizardProps) {
  const t = useTranslations('provider_signup')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [step, setStep] = useState<Step>(skipAuth ? 'business' : 'phone')
  const [draft, setDraft] = useState<Draft>({ ...EMPTY, phone: initialPhone ?? '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [gstinLoading, setGstinLoading] = useState(false)
  const [bankLoading, setBankLoading] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [uploadingFor, setUploadingFor] = useState<string | null>(null)

  // Restore draft on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<Draft>
        setDraft((d) => ({ ...d, ...parsed }))
        setDraftRestored(true)
        setTimeout(() => setDraftRestored(false), 3000)
      }
    } catch {}
  }, [])

  // Persist draft to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {}
  }, [draft])

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }))
  }

  const stepOrder: Step[] = skipAuth
    ? ['business', 'kyc', 'bank', 'submit']
    : ['phone', 'otp', 'business', 'kyc', 'bank', 'submit']
  const activeSteps = stepOrder.filter((s) => s !== 'under_review')
  const currentIdx = activeSteps.findIndex((s) => s === step)
  const progress = step === 'under_review' ? 100 : ((currentIdx + 1) / activeSteps.length) * 100

  const stepLabels: Record<Step, string> = {
    phone: t('step_contact'), otp: t('step_contact'), business: t('step_business'),
    kyc: t('step_kyc'), bank: t('step_bank'), submit: t('step_submit'), under_review: t('step_submit'),
  }

  async function verifyGstin() {
    if (!draft.gstin) return
    setGstinLoading(true)
    setError('')
    try {
      const res = await fetch('/api/v1/profile/provider/kyc/verify-gstin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gstin: draft.gstin }),
      })
      const d = await res.json()
      if (d.verified) {
        update({ gstinVerified: true, gstinStub: d.stub ?? false, legalName: d.legalName ?? draft.legalName })
      } else {
        setError(t('gstin_failed'))
      }
    } catch {
      setError(t('gstin_failed'))
    } finally {
      setGstinLoading(false)
    }
  }

  async function verifyBank() {
    if (!draft.bankAccount || !draft.bankIfsc || !draft.bankHolder) return
    setBankLoading(true)
    setError('')
    try {
      const res = await fetch('/api/v1/profile/provider/kyc/verify-bank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountNumber: draft.bankAccount,
          ifsc: draft.bankIfsc,
          holderName: draft.bankHolder,
        }),
      })
      const d = await res.json()
      if (d.verified) {
        update({ bankVerified: true, bankStub: d.stub ?? false })
      } else {
        setError(d.error ?? 'Bank verification failed')
      }
    } catch {
      setError('Bank verification failed')
    } finally {
      setBankLoading(false)
    }
  }

  async function handleCredentialUpload(categorySlug: string, file: File) {
    setUploadingFor(categorySlug)
    setError('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('category', categorySlug)
      const res = await fetch('/api/v1/profile/provider/credential-upload', {
        method: 'POST',
        body: formData,
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Upload failed')
      update({
        credentialUploads: {
          ...draft.credentialUploads,
          [categorySlug]: { url: d.url, name: file.name },
        },
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'An error occurred')
    } finally {
      setUploadingFor(null)
    }
  }

  async function submitForReview() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/v1/profile/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: draft.phone,
          email: draft.email,
          legalName: draft.legalName,
          displayName: draft.displayName,
          about: draft.about,
          gstin: draft.gstin,
          pan: draft.pan,
          categorySlugs: draft.categorySlugs,
          state: draft.stateCode,
          city: draft.city,
          languages: draft.languages,
          bankIfsc: draft.bankIfsc,
          bankAccount: draft.bankAccount,
          bankHolder: draft.bankHolder,
          bankVerified: draft.bankVerified,
          credentialUploads: draft.credentialUploads,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Submission failed')
      }
      localStorage.removeItem(DRAFT_KEY)
      setStep('under_review')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  function toggleCategory(slug: string) {
    const existing = draft.categorySlugs
    if (existing.includes(slug)) {
      update({ categorySlugs: existing.filter((s) => s !== slug) })
    } else {
      update({ categorySlugs: [...existing, slug] })
    }
  }

  function toggleLanguage(lang: string) {
    const existing = draft.languages
    if (existing.includes(lang) && existing.length > 1) {
      update({ languages: existing.filter((l) => l !== lang) })
    } else if (!existing.includes(lang)) {
      update({ languages: [...existing, lang] })
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {step !== 'under_review' && (
        <>
          <Progress value={progress} label={stepLabels[step]} />
          {draftRestored && (
            <p className="rounded-[10px] bg-success/10 px-3 py-2 text-xs text-success">{t('draft_restored')}</p>
          )}
        </>
      )}

      {/* ── Step 1: Phone ─────────────────────────────────────────────────── */}
      {step === 'phone' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('step1_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('step1_subtitle')}</p>
          </div>
          <PhoneStep
            emailField
            onEmailChange={(email) => update({ email })}
            onSuccess={(phone) => { update({ phone }); setStep('otp') }}
          />
        </>
      )}

      {/* ── Step 2: OTP ───────────────────────────────────────────────────── */}
      {step === 'otp' && (
        <OtpStep
          phone={draft.phone}
          onSuccess={() => setStep('business')}
          onChangePhone={() => setStep('phone')}
        />
      )}

      {/* ── Step 3: Business ──────────────────────────────────────────────── */}
      {step === 'business' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('step2_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('step2_subtitle')}</p>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="legalName">{t('legal_name_label')}</Label>
              <Input id="legalName" placeholder={t('legal_name_placeholder')} value={draft.legalName} onChange={(e) => update({ legalName: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="displayName">{t('display_name_label')}</Label>
              <Input id="displayName" placeholder={t('display_name_placeholder')} value={draft.displayName} onChange={(e) => update({ displayName: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="about">{t('about_label')}</Label>
              <Textarea id="about" placeholder={t('about_placeholder')} value={draft.about} onChange={(e) => update({ about: e.target.value })} rows={4} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('categories_label')}</Label>
              <p className="text-xs text-foreground-secondary">{t('categories_hint')}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                {CATEGORY_LIST.map((cat) => (
                  <button
                    key={cat.slug}
                    type="button"
                    onClick={() => toggleCategory(cat.slug)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      draft.categorySlugs.includes(cat.slug)
                        ? 'border-primary bg-primary text-white'
                        : 'border-gray-300 text-foreground hover:border-primary hover:text-primary'
                    }`}
                  >
                    {cat.name_i18n.en}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="stateCode">{t('state_label')}</Label>
                <Select id="stateCode" value={draft.stateCode} onChange={(e) => update({ stateCode: e.target.value })} placeholder="— Select state —">
                  {INDIAN_STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </Select>
              </div>
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="city">{t('city_label')}</Label>
                <Input id="city" placeholder="City" value={draft.city} onChange={(e) => update({ city: e.target.value })} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('languages_label')}</Label>
              <div className="flex gap-2">
                {(['en', 'hi'] as const).map((lang) => (
                  <button key={lang} type="button" onClick={() => toggleLanguage(lang)}
                    className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${draft.languages.includes(lang) ? 'border-primary bg-primary text-white' : 'border-gray-300 text-foreground hover:border-primary'}`}>
                    {lang === 'en' ? 'English' : 'हिंदी'}
                  </button>
                ))}
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button
              onClick={() => {
                if (!draft.legalName || !draft.displayName || draft.categorySlugs.length === 0 || !draft.stateCode) {
                  setError('Please fill required fields and select at least one category')
                  return
                }
                setError('')
                setStep('kyc')
              }}
              className="w-full"
            >
              {tCommon('continue')}
            </Button>
          </div>
        </>
      )}

      {/* ── Step 4: KYC ───────────────────────────────────────────────────── */}
      {step === 'kyc' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('step3_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('step3_subtitle')}</p>
          </div>
          <div className="flex flex-col gap-4">
            {/* GSTIN */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gstin">{t('gstin_label')}</Label>
              <div className="flex gap-2">
                <Input
                  id="gstin"
                  placeholder={t('gstin_placeholder')}
                  value={draft.gstin}
                  onChange={(e) => update({ gstin: e.target.value.toUpperCase(), gstinVerified: false })}
                  maxLength={15}
                  disabled={draft.gstinVerified}
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  onClick={verifyGstin}
                  loading={gstinLoading}
                  disabled={draft.gstinVerified || !draft.gstin}
                  size="md"
                  className="shrink-0"
                >
                  {draft.gstinVerified ? '✓' : t('gstin_verify_btn')}
                </Button>
              </div>
              {draft.gstinVerified && (
                <p className="text-xs text-success">
                  {draft.gstinStub ? t('gstin_dev_stub') : t('gstin_verified')}
                </p>
              )}
            </div>
            {/* PAN */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pan">{t('pan_label')} <span className="text-foreground-secondary font-normal">({tCommon('optional')})</span></Label>
              <Input id="pan" placeholder={t('pan_placeholder')} value={draft.pan} onChange={(e) => update({ pan: e.target.value.toUpperCase() })} maxLength={10} />
            </div>
            {/* Credential uploads */}
            <div className="flex flex-col gap-3">
              <Label>{t('credential_section')}</Label>
              <p className="text-xs text-foreground-secondary">{t('credential_hint')}</p>
              {draft.categorySlugs.map((slug) => {
                const cat = CATEGORY_LIST.find((c) => c.slug === slug)
                const uploaded = draft.credentialUploads[slug]
                return (
                  <div key={slug} className="flex items-center justify-between rounded-[10px] border border-gray-200 p-3">
                    <div>
                      <p className="text-sm font-medium">{cat?.name_i18n.en}</p>
                      {uploaded && (
                        <p className="text-xs text-success mt-0.5">{t('credential_uploaded', { name: uploaded.name })}</p>
                      )}
                    </div>
                    <label className="cursor-pointer">
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) handleCredentialUpload(slug, file)
                        }}
                      />
                      <span className={`inline-flex h-9 items-center rounded-[10px] border px-3 text-xs font-medium transition-colors ${uploaded ? 'border-success/40 text-success' : 'border-primary text-primary hover:bg-primary/10'}`}>
                        {uploadingFor === slug ? '…' : uploaded ? 'Re-upload' : t('credential_upload')}
                      </span>
                    </label>
                  </div>
                )
              })}
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button
              onClick={() => {
                if (!draft.gstinVerified) { setError('Please verify your GSTIN before continuing'); return }
                setError('')
                setStep('bank')
              }}
              className="w-full"
            >
              {tCommon('continue')}
            </Button>
          </div>
        </>
      )}

      {/* ── Step 5: Bank ──────────────────────────────────────────────────── */}
      {step === 'bank' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('step4_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('step4_subtitle')}</p>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bankHolder">{t('bank_holder_label')}</Label>
              <Input id="bankHolder" placeholder="Account holder name" value={draft.bankHolder} onChange={(e) => update({ bankHolder: e.target.value, bankVerified: false })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bankAccount">{t('bank_account_label')}</Label>
              <Input id="bankAccount" type="text" inputMode="numeric" placeholder="Account number" value={draft.bankAccount} onChange={(e) => update({ bankAccount: e.target.value, bankVerified: false })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bankIfsc">{t('bank_ifsc_label')}</Label>
              <Input id="bankIfsc" placeholder={t('bank_ifsc_placeholder')} value={draft.bankIfsc} onChange={(e) => update({ bankIfsc: e.target.value.toUpperCase(), bankVerified: false })} maxLength={11} />
            </div>
            <Button variant="outline" onClick={verifyBank} loading={bankLoading} disabled={draft.bankVerified || !draft.bankAccount || !draft.bankIfsc || !draft.bankHolder}>
              {draft.bankVerified ? (draft.bankStub ? t('bank_dev_stub') : t('bank_verified')) : t('bank_verify_btn')}
            </Button>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button
              onClick={() => {
                if (!draft.bankVerified) { setError('Please verify your bank account before continuing'); return }
                setError('')
                setStep('submit')
              }}
              className="w-full"
            >
              {tCommon('continue')}
            </Button>
          </div>
        </>
      )}

      {/* ── Step 6: Submit ────────────────────────────────────────────────── */}
      {step === 'submit' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('submit_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('submit_detail')}</p>
          </div>
          <div className="flex flex-col gap-2">
            {[
              { key: 'gstin', done: draft.gstinVerified, label: t('submit_checklist_gstin') },
              { key: 'creds', done: Object.keys(draft.credentialUploads).length > 0, label: t('submit_checklist_creds') },
              { key: 'bank', done: draft.bankVerified, label: t('submit_checklist_bank') },
            ].map(({ key, done, label }) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                <span className={done ? 'text-success' : 'text-foreground-secondary'}>{done ? '✓' : '○'}</span>
                <span className={done ? 'text-foreground' : 'text-foreground-secondary'}>{label}</span>
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button onClick={submitForReview} loading={loading} className="w-full">
            {t('submit_btn')}
          </Button>
        </>
      )}

      {/* ── Under review ──────────────────────────────────────────────────── */}
      {step === 'under_review' && (
        <div className="flex flex-col items-center gap-6 py-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
            <svg className="h-8 w-8 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-semibold">{t('under_review_title')}</h2>
            <p className="mt-2 text-sm text-foreground-secondary max-w-sm">{t('under_review_body')}</p>
          </div>
          <Button onClick={() => router.push('/partner')} className="w-full max-w-xs">
            {t('browse_as_msme')}
          </Button>
        </div>
      )}
    </div>
  )
}
