'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { INDIAN_STATES } from '@/lib/constants/india'
import { CATEGORY_LIST, categoriesNeedingCredentialUpload } from '@amclub/shared'
import { loadProviderDraft } from '@/components/gateway/draft'

type Step = 'auth' | 'business' | 'kyc' | 'bank' | 'submit' | 'under_review'

const DRAFT_KEY = 'amclub_provider_wizard_draft'
// A provider may list in up to 5 categories (server enforces the same — §5).
const MAX_CATEGORIES = 5
// Drafts older than this are discarded (signed credential URLs expire ~7d, and
// stale verification flags shouldn't linger).
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

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
  /** True when the user is already authenticated and only needs to complete KYC. */
  skipAuth?: boolean
}

export function ProviderWizard({ skipAuth }: ProviderWizardProps) {
  const t = useTranslations('provider_signup')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [step, setStep] = useState<Step>(skipAuth ? 'business' : 'auth')
  const [draft, setDraft] = useState<Draft>({ ...EMPTY })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [gstinLoading, setGstinLoading] = useState(false)
  const [bankLoading, setBankLoading] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [uploadingFor, setUploadingFor] = useState<string | null>(null)

  // Restore draft on mount — only if it isn't stale (TTL). Note the bank account
  // number is never persisted (see below), so it comes back blank to re-enter.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY)
      if (!saved) return
      const env = JSON.parse(saved) as { savedAt?: number; draft?: Partial<Draft> }
      // Back-compat: older drafts were stored as the bare draft object.
      const parsed = env.draft ?? (env as Partial<Draft>)
      const savedAt = env.savedAt ?? 0
      if (savedAt && Date.now() - savedAt > DRAFT_TTL_MS) {
        localStorage.removeItem(DRAFT_KEY)
        return
      }
      setDraft((d) => ({ ...d, ...parsed, bankAccount: '' }))
      setDraftRestored(true)
      setTimeout(() => setDraftRestored(false), 3000)
    } catch {}
  }, [])

  // Phase 8a — seed category + state from the gateway's partner mini-wizard
  // when this wizard has no answer of its own yet (own draft always wins).
  useEffect(() => {
    const gw = loadProviderDraft()
    if (!gw) return
    setDraft((d) => ({
      ...d,
      categorySlugs: d.categorySlugs.length > 0 ? d.categorySlugs : gw.cat ? [gw.cat] : [],
      stateCode: d.stateCode || (gw.state ?? ''),
    }))
  }, [])

  // Persist draft on change. NEVER store the bank account number in localStorage
  // (sensitive financial data; XSS-readable) — strip it; re-entered on restore.
  useEffect(() => {
    try {
      const safe = { ...draft, bankAccount: '' }
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), draft: safe }))
    } catch {}
  }, [draft])

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }))
  }

  // Already a provider → dashboard; otherwise continue KYC (new or msme-only user).
  async function handleAuthenticated() {
    const res = await fetch('/api/v1/profile/me')
    const d = await res.json().catch(() => ({}))
    if (d.hasProviderProfile) router.push('/partner')
    else setStep('business')
  }

  const stepOrder: Step[] = skipAuth
    ? ['business', 'kyc', 'bank', 'submit']
    : ['auth', 'business', 'kyc', 'bank', 'submit']
  const activeSteps = stepOrder.filter((s) => s !== 'under_review')
  const currentIdx = activeSteps.findIndex((s) => s === step)
  const progress = step === 'under_review' ? 100 : ((currentIdx + 1) / activeSteps.length) * 100

  const stepLabels: Record<Step, string> = {
    auth: t('step_contact'), business: t('step_business'),
    kyc: t('step_kyc'), bank: t('step_bank'), submit: t('step_submit'), under_review: t('step_submit'),
  }

  // Credential gating (§3.3/§5): only categories whose required_credentials need
  // an uploaded document (icai/bar_council/…) — gstin/pan are API-verified.
  const credsNeededSlugs = categoriesNeedingCredentialUpload(draft.categorySlugs)
  const credsRequired = credsNeededSlugs.length > 0
  const credsComplete = credsNeededSlugs.every((slug) => !!draft.credentialUploads[slug])

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
    // Validate format up front (the dev stub "verifies" anything; the server
    // rejects bad formats on submit). Matches the server's Zod rules.
    if (!/^\d{9,18}$/.test(draft.bankAccount)) { setError(t('err_bank_account')); return }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(draft.bankIfsc)) { setError(t('err_bank_ifsc')); return }
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
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('upload_failed'))
      update({
        credentialUploads: {
          ...draft.credentialUploads,
          [categorySlug]: { url: d.url, name: file.name },
        },
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('error_generic'))
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
        throw new Error(readApiError(d))
      }
      localStorage.removeItem(DRAFT_KEY)
      setStep('under_review')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('error_generic'))
    } finally {
      setLoading(false)
    }
  }

  // Turn a server error (string OR Zod fieldErrors) into a readable message, so
  // a validation failure is never hidden behind a generic "Submission failed".
  function readApiError(d: unknown): string {
    const err = (d as { error?: unknown })?.error
    if (typeof err === 'string') return err
    const fieldErrors = (err as { fieldErrors?: Record<string, string[]> })?.fieldErrors
    if (fieldErrors) {
      if (fieldErrors['categorySlugs']) return t('err_categories_max', { max: MAX_CATEGORIES })
      if (fieldErrors['bankAccount']) return t('err_bank_account')
      if (fieldErrors['bankIfsc']) return t('err_bank_ifsc')
      const first = Object.values(fieldErrors).flat()[0]
      if (first) return first
    }
    return t('submission_failed')
  }

  // Step back to re-check a previous form.
  function goBack() {
    const idx = stepOrder.indexOf(step)
    if (idx > 0) {
      setError('')
      setStep(stepOrder[idx - 1]!)
    }
  }

  function toggleCategory(slug: string) {
    const existing = draft.categorySlugs
    if (existing.includes(slug)) {
      update({ categorySlugs: existing.filter((s) => s !== slug) })
    } else if (existing.length < MAX_CATEGORIES) {
      update({ categorySlugs: [...existing, slug] })
    } else {
      // At the cap — tell the user instead of silently ignoring.
      setError(t('err_categories_max', { max: MAX_CATEGORIES }))
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
            <p className="rounded-button bg-success/10 px-3 py-2 text-xs text-success">{t('draft_restored')}</p>
          )}
        </>
      )}

      {/* ── Step 1: Auth (phone / email / Google) ─────────────────────────── */}
      {step === 'auth' && (
        <>
          <div>
            <h2 className="mb-1 text-xl font-semibold">{t('step1_title')}</h2>
            <p className="text-sm text-foreground-secondary">{t('step1_subtitle')}</p>
          </div>
          <AuthPanel onAuthenticated={handleAuthenticated} googleRedirectTo="/partner/onboarding" />
        </>
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
              <p className="text-xs text-foreground-secondary">
                {t('categories_hint')} · {t('categories_count', { n: draft.categorySlugs.length, max: MAX_CATEGORIES })}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {CATEGORY_LIST.map((cat) => {
                  const selected = draft.categorySlugs.includes(cat.slug)
                  const atCap = !selected && draft.categorySlugs.length >= MAX_CATEGORIES
                  return (
                    <button
                      key={cat.slug}
                      type="button"
                      onClick={() => toggleCategory(cat.slug)}
                      disabled={atCap}
                      aria-pressed={selected}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                        selected
                          ? 'border-primary bg-primary text-white'
                          : atCap
                          ? 'border-border text-foreground-secondary opacity-50'
                          : 'border-border text-foreground hover:border-primary hover:text-primary'
                      }`}
                    >
                      {cat.name_i18n.en}
                    </button>
                  )
                })}
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
                    className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${draft.languages.includes(lang) ? 'border-primary bg-primary text-white' : 'border-border text-foreground hover:border-primary'}`}>
                    {lang === 'en' ? 'English' : 'हिंदी'}
                  </button>
                ))}
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button
              onClick={() => {
                if (!draft.legalName.trim() || !draft.displayName.trim() || draft.categorySlugs.length === 0 || !draft.stateCode) {
                  setError(t('err_business_required'))
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
            {/* Credential uploads — only categories that require an uploaded document */}
            <div className="flex flex-col gap-3">
              <Label>{t('credential_section')}</Label>
              <p className="text-xs text-foreground-secondary">{t('credential_hint')}</p>
              {credsRequired ? (
                credsNeededSlugs.map((slug) => {
                  const cat = CATEGORY_LIST.find((c) => c.slug === slug)
                  const uploaded = draft.credentialUploads[slug]
                  return (
                    <div key={slug} className="flex items-center justify-between rounded-button border border-border p-3">
                      <div>
                        <p className="text-sm font-medium">{cat?.name_i18n.en}</p>
                        {uploaded ? (
                          <p className="text-xs text-success mt-0.5">{t('credential_uploaded', { name: uploaded.name })}</p>
                        ) : (
                          <p className="text-xs text-warning mt-0.5">{t('credential_required_badge')}</p>
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
                        <span className={`inline-flex h-9 items-center rounded-button border px-3 text-xs font-medium transition-colors ${uploaded ? 'border-success/40 text-success' : 'border-primary text-primary hover:bg-primary/10'}`}>
                          {uploadingFor === slug ? '…' : uploaded ? 'Re-upload' : t('credential_upload')}
                        </span>
                      </label>
                    </div>
                  )
                })
              ) : (
                <p className="rounded-button bg-muted px-3 py-2 text-xs text-foreground-secondary">{t('credential_not_required')}</p>
              )}
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex gap-3">
              <Button variant="ghost" onClick={goBack} className="shrink-0">{tCommon('back')}</Button>
              <Button
                onClick={() => {
                  if (!draft.gstinVerified) { setError(t('gstin_required_error')); return }
                  if (!credsComplete) { setError(t('credential_required_error')); return }
                  setError('')
                  setStep('bank')
                }}
                className="flex-1"
              >
                {tCommon('continue')}
              </Button>
            </div>
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
            <div className="flex gap-3">
              <Button variant="ghost" onClick={goBack} className="shrink-0">{tCommon('back')}</Button>
              <Button
                onClick={() => {
                  if (!draft.bankVerified) { setError(t('err_bank_verify_required')); return }
                  setError('')
                  setStep('submit')
                }}
                className="flex-1"
              >
                {tCommon('continue')}
              </Button>
            </div>
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
              {
                key: 'creds',
                done: credsComplete,
                // When no selected category needs an upload, show "not required".
                label: credsRequired ? t('submit_checklist_creds') : t('submit_checklist_creds_not_required'),
              },
              { key: 'bank', done: draft.bankVerified, label: t('submit_checklist_bank') },
            ].map(({ key, done, label }) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                <span className={done ? 'text-success' : 'text-foreground-secondary'}>{done ? '✓' : '○'}</span>
                <span className={done ? 'text-foreground' : 'text-foreground-secondary'}>{label}</span>
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-3">
            <Button variant="ghost" onClick={goBack} disabled={loading} className="shrink-0">{tCommon('back')}</Button>
            <Button
              onClick={submitForReview}
              loading={loading}
              disabled={!draft.gstinVerified || !credsComplete || !draft.bankVerified}
              className="flex-1"
            >
              {t('submit_btn')}
            </Button>
          </div>
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
