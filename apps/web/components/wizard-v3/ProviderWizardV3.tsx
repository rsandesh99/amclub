'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  autofilledFields,
  CATEGORY_LIST,
  categoriesRequiringCredential,
  indianStateName,
  indianStateOptions,
  isValidGstin,
  ONBOARDING_V3_STEPS,
  pickI18n,
  PROVIDER_LANGUAGES,
  PROVIDER_LEGAL_DOCS,
  statutoryOptionsForCategory,
  type GstinAutofill,
  type OnboardingV3Step,
} from '@amclub/shared'
import { useRouter } from '@/i18n/navigation'
import { acceptLegalDocs } from '@/lib/legal/client'
import { useAnalytics } from '@/components/providers/posthog'
import { LOCALE_LABELS } from '@/components/catalog/LanguageSwitcher'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Stepper } from '@/components/ui-v3/Stepper'
import { Picker } from '@/components/ui-v3/Picker'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'

const DRAFT_KEY = 'amclub_provider_wizard_v3'
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CATEGORIES = 5

interface Draft {
  fullName: string
  gstin: string
  autofill: GstinAutofill | null
  legalName: string
  displayName: string
  stateCode: string
  city: string
  yearsExperience: '' | '0-2' | '3-9' | '10+'
  primaryCategory: string
  extraCategories: string[]
  languages: string[]
  credentialKinds: Record<string, string>
  credentialNumbers: Record<string, string>
  credentialUploads: Record<string, { url: string; name: string }>
  bankAccount: string
  bankIfsc: string
  bankHolder: string
  bankVerified: boolean
  bankStub: boolean
  bankHolderFromBank: string | null
  /** ADR 028 — the bank's holder name does not match the GST-registered name (payouts hold until ops review). */
  bankNameReview: boolean
}

const EMPTY: Draft = {
  fullName: '', gstin: '', autofill: null, legalName: '', displayName: '', stateCode: '', city: '', yearsExperience: '',
  primaryCategory: '', extraCategories: [], languages: ['en'],
  credentialKinds: {}, credentialNumbers: {}, credentialUploads: {},
  bankAccount: '', bankIfsc: '', bankHolder: '', bankVerified: false, bankStub: false, bankHolderFromBank: null, bankNameReview: false,
}

type View = 'needs' | OnboardingV3Step | 'done'

/**
 * PRD Experience v3 E10 (flag `onboarding`) — the provider wizard in four
 * named steps: Contact · Business (GSTIN first, autofilled from GST records)
 * · Credentials & bank · Review & submit. Same writes as the v2 wizard
 * (acceptLegalDocs → POST /profile/provider); each step is saved on the
 * server (onboarding-progress) so a stalled draft can be nudged back to it.
 * The bank account number is never stored on the device.
 */
export function ProviderWizardV3({ initialName, initialStep, next = null, waEnabled = false }: { initialName: string; initialStep?: OnboardingV3Step | null; next?: string | null; waEnabled?: boolean }) {
  const t = useTranslations('onboarding_v3')
  const tp = useTranslations('provider_signup')
  const tGw = useTranslations('gateway')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const analytics = useAnalytics()

  const [view, setView] = useState<View>(initialStep ?? 'needs')
  const [draft, setDraft] = useState<Draft>({ ...EMPTY, fullName: initialName })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'gstin' | 'bank' | 'upload' | 'submit' | null>(null)
  const [tried, setTried] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const enteredAt = useRef<number>(Date.now())
  // FR-10.4 — "Finish on WhatsApp" only while the S1.6 onboarding agent is on for this provider's cohort.
  const [wa, setWa] = useState<{ number: string | null; optIn: boolean } | 'error' | null>(null)
  async function startWhatsApp() {
    const res = await fetch('/api/v1/agent/onboarding/start', { method: 'POST' }).catch(() => null)
    const d = (await res?.json().catch(() => ({}))) as { sessionId?: string; whatsappNumber?: string | null; needsOptIn?: boolean; error?: string } | undefined
    if (res && (res.status === 201 || (res.status === 409 && d?.error === 'session_active'))) setWa({ number: d?.whatsappNumber ?? null, optIn: d?.needsOptIn !== false })
    else setWa('error')
  }

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const categories = [draft.primaryCategory, ...draft.extraCategories.filter((c) => c !== draft.primaryCategory)].filter(Boolean)
  const credSlugs = categoriesRequiringCredential(categories)

  // Restore the device draft (TTL; the account number never comes back).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return
      const env = JSON.parse(raw) as { savedAt?: number; draft?: Partial<Draft> }
      if (!env.savedAt || Date.now() - env.savedAt > DRAFT_TTL_MS) { localStorage.removeItem(DRAFT_KEY); return }
      setDraft((d) => ({ ...d, ...env.draft, bankAccount: '', bankVerified: false, bankStub: false, bankHolderFromBank: null, bankNameReview: false, fullName: env.draft?.fullName || d.fullName }))
      if (!initialStep) setView('contact')
    } catch { /* bad JSON / private mode: start fresh */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount
  }, [])
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), draft: { ...draft, bankAccount: '' } })) } catch { /* ignore */ }
  }, [draft])

  // FR-10.4 — step analytics + the server-side progress row the stall nudge reads.
  const trackView = useCallback((v: View) => {
    if (v === 'needs' || v === 'done') return
    enteredAt.current = Date.now()
    analytics.capture('onboarding_step_viewed', { device: 'web', step: v, category: draft.primaryCategory || null })
    void fetch('/api/v1/profile/provider/onboarding-progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: v, ...(draft.primaryCategory ? { categorySlug: draft.primaryCategory } : {}) }),
    }).catch(() => undefined)
  }, [analytics, draft.primaryCategory])
  useEffect(() => { trackView(view) }, [view]) // eslint-disable-line react-hooks/exhaustive-deps -- once per step change

  function go(to: View) {
    if (view !== 'needs' && view !== 'done' && to !== view && ONBOARDING_V3_STEPS.indexOf(to as OnboardingV3Step) > ONBOARDING_V3_STEPS.indexOf(view)) {
      analytics.capture('onboarding_step_completed', { device: 'web', step: view, ms: Date.now() - enteredAt.current })
    }
    setError('')
    setTried(false)
    setView(to)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }

  // ── Step 2: GSTIN first ─────────────────────────────────────────────────────
  async function verifyGstin() {
    const gstin = draft.gstin.trim().toUpperCase()
    if (!isValidGstin(gstin)) { setError(tp('gstin_invalid_format')); return }
    setBusy('gstin'); setError('')
    try {
      const res = await fetch('/api/v1/profile/provider/kyc/verify-gstin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gstin }) })
      const d = (await res.json().catch(() => ({}))) as { verified?: boolean; autofill?: GstinAutofill }
      if (!res.ok || !d.verified || !d.autofill) { setError(tp('gstin_failed')); update({ autofill: null }); return }
      const a = d.autofill
      update({
        gstin,
        autofill: a,
        legalName: a.legalName ?? draft.legalName,
        displayName: draft.displayName || a.tradeName || a.legalName || '',
        stateCode: a.state ?? draft.stateCode,
      })
      if (a.active) analytics.capture('onboarding_gstin_autofilled', { device: 'web', fields: autofilledFields(a).length })
    } catch {
      setError(tp('gstin_failed'))
    } finally {
      setBusy(null)
    }
  }

  // ── Step 3: credentials + bank ──────────────────────────────────────────────
  async function upload(slug: string, file: File) {
    setBusy('upload'); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('category', slug)
      const res = await fetch('/api/v1/profile/provider/credential-upload', { method: 'POST', body: fd })
      const d = (await res.json().catch(() => ({}))) as { url?: string; error?: unknown }
      if (!res.ok || !d.url) throw new Error()
      update({ credentialUploads: { ...draft.credentialUploads, [slug]: { url: d.url, name: file.name } } })
    } catch {
      setError(tp('upload_failed'))
    } finally {
      setBusy(null)
    }
  }

  async function verifyBank() {
    const account = draft.bankAccount.trim()
    const ifsc = draft.bankIfsc.trim().toUpperCase()
    if (!/^\d{9,18}$/.test(account)) { setError(tp('err_bank_account')); return }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) { setError(tp('err_bank_ifsc')); return }
    const holder = draft.bankHolder.trim() || draft.legalName
    setBusy('bank'); setError('')
    try {
      const res = await fetch('/api/v1/profile/provider/kyc/verify-bank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountNumber: account, ifsc, holderName: holder, ...(draft.gstin.length === 15 ? { gstin: draft.gstin } : {}) }) })
      const d = (await res.json().catch(() => ({}))) as { verified?: boolean; stub?: boolean; accountHolderName?: string; nameMatch?: boolean }
      if (!res.ok || !d.verified) { setError(tp('bank_verify_failed')); return }
      // FR-10.2 — the holder name comes from bank verification.
      update({ bankIfsc: ifsc, bankHolder: d.accountHolderName || holder, bankHolderFromBank: d.accountHolderName ?? null, bankVerified: true, bankStub: d.stub === true, bankNameReview: d.nameMatch === false })
    } catch {
      setError(tp('bank_verify_failed'))
    } finally {
      setBusy(null)
    }
  }

  // ── Continue rules per step ─────────────────────────────────────────────────
  const contactOk = draft.fullName.trim().length >= 2
  const gstinOk = !!draft.autofill?.verified && draft.autofill.active && draft.gstin.length === 15
  const businessOk = gstinOk && draft.legalName.trim().length >= 2 && draft.displayName.trim().length >= 2 && !!draft.stateCode && !!draft.primaryCategory
  const credsOk = credSlugs.every((s) => !!draft.credentialKinds[s] && !!draft.credentialNumbers[s]?.trim() && !!draft.credentialUploads[s])
  const bankOk = draft.bankVerified && !!draft.bankAccount.trim()

  async function submit() {
    if (!accepted) { setError(tp('addendum_required')); return }
    if (!bankOk) { setError(tp('err_bank_verify_required')); go('credentials_bank'); return }
    setBusy('submit'); setError('')
    try {
      const legal = await acceptLegalDocs([...PROVIDER_LEGAL_DOCS], locale)
      if (!legal.ok) throw new Error(tp('error_generic'))
      const res = await fetch('/api/v1/profile/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: draft.fullName.trim(),
          preferredLocale: locale,
          legalName: draft.legalName.trim(),
          displayName: draft.displayName.trim(),
          ...(draft.yearsExperience ? { yearsExperience: draft.yearsExperience } : {}),
          gstin: draft.gstin,
          categorySlugs: categories,
          state: draft.stateCode,
          ...(draft.city.trim() ? { city: draft.city.trim() } : {}),
          languages: draft.languages,
          bankIfsc: draft.bankIfsc,
          bankAccount: draft.bankAccount.trim(),
          bankHolder: draft.bankHolder.trim() || draft.legalName.trim(),
          bankVerified: draft.bankVerified,
          credentialUploads: Object.fromEntries(credSlugs.map((s) => [s, { ...draft.credentialUploads[s], kind: draft.credentialKinds[s], number: draft.credentialNumbers[s]?.trim() }])),
        }),
      })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: unknown }
        throw new Error(typeof d.error === 'string' ? d.error : tp('submission_failed'))
      }
      analytics.capture('onboarding_step_completed', { device: 'web', step: 'review', ms: Date.now() - enteredAt.current })
      analytics.capture('onboarding_submitted', { device: 'web', category: draft.primaryCategory, path: 'gstin' })
      try { localStorage.removeItem(DRAFT_KEY) } catch { /* ignore */ }
      setView('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : tp('error_generic'))
    } finally {
      setBusy(null)
    }
  }

  const stepNames = [t('step_contact'), t('step_business'), t('step_credentials_bank'), t('step_review')]
  const idx = ONBOARDING_V3_STEPS.indexOf(view as OnboardingV3Step)
  const fromGst = <span className="t-caption text-foreground-secondary" data-testid="from-gst">{t('from_gst')}</span>
  const stateLabel = (code: string) => indianStateName(code, locale)

  // ── Render ───────────────────────────────────────────────────────────────────
  if (view === 'needs') {
    return (
      <div className="space-y-5" data-testid="onboarding-needs">
        <h2 className="t-title-2">{t('needs_title')}</h2>
        <ul className="space-y-2 text-sm">
          <li>• {t('needs_gstin')}</li>
          <li>• {t('needs_bank')}</li>
          <li>• {t('needs_credential')}</li>
          <li>• {t('needs_logo')}</li>
        </ul>
        <p className="t-footnote text-foreground-secondary">{t('needs_time')}</p>
        <Button className="w-full" onClick={() => go('contact')}>{t('start')}</Button>
        {waEnabled && (
          <div className="rounded-card border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="onboarding-wa">
            <p className="font-medium text-primary">{tp('wa_card_title')}</p>
            <p className="mt-1 text-xs text-foreground-secondary">{tp('wa_card_body')}</p>
            {wa && wa !== 'error' ? (
              <p className="mt-2 text-xs">
                {wa.optIn ? tp('wa_card_steps_opt_in') : tp('wa_card_steps')}{' '}
                {wa.number ? <a href={`https://wa.me/${wa.number}?text=${encodeURIComponent(wa.optIn ? 'START' : 'JOIN')}`} target="_blank" rel="noopener" className="text-primary underline underline-offset-2">{tp('wa_card_open', { number: wa.number })}</a> : tp('wa_card_no_number')}
              </p>
            ) : (
              <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={startWhatsApp}>{tp('wa_card_button')}</Button>
            )}
            {wa === 'error' && <p className="mt-1 text-xs text-danger">{tp('wa_card_failed')}</p>}
          </div>
        )}
      </div>
    )
  }

  if (view === 'done') {
    return (
      <div className="flex flex-col items-center gap-5 py-6 text-center" data-testid="onboarding-done">
        <h2 className="t-title-2">{tp('under_review_title')}</h2>
        <p className="max-w-sm text-sm text-foreground-secondary">{tp('under_review_body')}</p>
        {next && <Button onClick={() => router.push(next)} className="w-full max-w-xs">{tp('continue_to_next')}</Button>}
        <Button variant={next ? 'outline' : 'primary'} onClick={() => router.push('/partner')} className="w-full max-w-xs">{t('go_dashboard')}</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6" data-testid="onboarding-v3" data-step={view}>
      <Stepper steps={stepNames} current={idx} ariaLabel={t('stepper_label')} />

      {view === 'contact' && (
        <section className="space-y-4">
          <h2 className="t-title-3">{t('step_contact')}</h2>
          <div className="space-y-1">
            <Label htmlFor="ob-name">{t('name_label')}</Label>
            <Input id="ob-name" value={draft.fullName} onChange={(e) => update({ fullName: e.target.value })} autoComplete="name" aria-invalid={tried && !contactOk} />
            <p className="t-caption text-foreground-secondary">{t('phone_from_signin')}</p>
          </div>
          <Button className="w-full" onClick={() => (contactOk ? go('business') : setTried(true))}>{t('continue')}</Button>
        </section>
      )}

      {view === 'business' && (
        <section className="space-y-4">
          <h2 className="t-title-3">{t('step_business')}</h2>
          <div className="space-y-1">
            <Label htmlFor="ob-gstin">{tp('gstin_label')}</Label>
            <div className="flex gap-2">
              <Input id="ob-gstin" value={draft.gstin} maxLength={15} placeholder={tp('gstin_placeholder')} className="font-mono uppercase" onChange={(e) => update({ gstin: e.target.value.toUpperCase().trim(), autofill: null })} />
              <Button type="button" variant="secondary" onClick={verifyGstin} loading={busy === 'gstin'} className="shrink-0">{tp('gstin_verify_btn')}</Button>
            </div>
            {draft.autofill && draft.autofill.active && (
              <p className="t-footnote text-success" data-testid="gstin-active">{draft.autofill.stub ? tp('gstin_dev_stub') : t('gstin_active')}</p>
            )}
            {draft.autofill && !draft.autofill.active && (
              <p className="t-footnote text-danger" role="alert" data-testid="gstin-inactive">{t('gstin_inactive', { status: draft.autofill.statusText ?? '' })}</p>
            )}
          </div>

          {gstinOk && (
            <>
              <div className="space-y-1">
                <Label htmlFor="ob-legal">{tp('legal_name_label')}</Label>
                <Input id="ob-legal" value={draft.legalName} readOnly={!!draft.autofill?.legalName} onChange={(e) => update({ legalName: e.target.value })} aria-describedby="ob-legal-src" />
                {draft.autofill?.legalName ? <p id="ob-legal-src" className="t-caption text-foreground-secondary">🔒 {t('from_gst_locked')}</p> : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="ob-display">{tp('display_name_label')}</Label>
                <Input id="ob-display" value={draft.displayName} onChange={(e) => update({ displayName: e.target.value })} />
                {draft.autofill?.tradeName && draft.displayName === draft.autofill.tradeName ? fromGst : null}
              </div>
              <div className="space-y-1">
                <Picker id="ob-state" label={tp('state_label')} value={draft.stateCode || null} options={indianStateOptions(locale)} onChange={(v) => update({ stateCode: v ?? '' })} />
                {draft.autofill?.state && draft.stateCode === draft.autofill.state ? fromGst : null}
              </div>
              {draft.autofill?.registrationDate && (
                <p className="text-sm" data-testid="since">{t('since', { date: new Date(`${draft.autofill.registrationDate}T00:00:00+05:30`).toLocaleDateString(`${locale}-IN`, { month: 'short', year: 'numeric' }) })} · {fromGst}</p>
              )}
              <div className="space-y-1">
                <Label htmlFor="ob-city">{tp('city_label')}</Label>
                <Input id="ob-city" value={draft.city} placeholder={tp('city_placeholder')} onChange={(e) => update({ city: e.target.value })} />
              </div>
              <Picker id="ob-category" label={t('primary_category')} value={draft.primaryCategory || null} options={CATEGORY_LIST.map((c) => ({ value: c.slug, label: pickI18n(c.name_i18n, locale) }))} onChange={(v) => update({ primaryCategory: v ?? '', extraCategories: draft.extraCategories.filter((x) => x !== v) })} />
              {draft.primaryCategory && (
                <div className="space-y-1.5">
                  <p className="t-footnote text-foreground-secondary">{t('more_categories')}</p>
                  <div className="flex flex-wrap gap-2">
                    {CATEGORY_LIST.filter((c) => c.slug !== draft.primaryCategory).map((c) => {
                      const on = draft.extraCategories.includes(c.slug)
                      return (
                        <button
                          key={c.slug}
                          type="button"
                          aria-pressed={on}
                          onClick={() => update({ extraCategories: on ? draft.extraCategories.filter((x) => x !== c.slug) : draft.extraCategories.length < MAX_CATEGORIES - 1 ? [...draft.extraCategories, c.slug] : draft.extraCategories })}
                          className={`rounded-chip border px-3 py-1 text-sm ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}
                        >
                          {pickI18n(c.name_i18n, locale)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <p className="t-footnote text-foreground-secondary">{tp('experience_label')}</p>
                <SegmentedControl ariaLabel={tp('experience_label')} value={draft.yearsExperience || null} onChange={(v) => update({ yearsExperience: v })} options={[{ value: '0-2', label: tp('exp_0_2') }, { value: '3-9', label: tp('exp_3_9') }, { value: '10+', label: tp('exp_10p') }]} />
              </div>
              <div className="space-y-1.5">
                <p className="t-footnote text-foreground-secondary">{tp('languages_label')}</p>
                <div className="flex flex-wrap gap-2">
                  {PROVIDER_LANGUAGES.map((l) => {
                    const on = draft.languages.includes(l)
                    return (
                      <button key={l} type="button" aria-pressed={on} onClick={() => update({ languages: on ? (draft.languages.length > 1 ? draft.languages.filter((x) => x !== l) : draft.languages) : [...draft.languages, l] })} className={`rounded-chip border px-3 py-1 text-sm ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}>
                        {LOCALE_LABELS[l as keyof typeof LOCALE_LABELS] ?? l}
                      </button>
                    )
                  })}
                </div>
              </div>
            </>
          )}
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          {tried && !businessOk && !error && <p className="text-sm text-danger" role="alert">{gstinOk ? tp('err_business_required') : tp('gstin_required_error')}</p>}
          <div className="flex gap-3">
            <Button variant="ghost" onClick={() => go('contact')}>{tCommon('back')}</Button>
            <Button className="flex-1" onClick={() => (businessOk ? go('credentials_bank') : setTried(true))}>{t('continue')}</Button>
          </div>
        </section>
      )}

      {view === 'credentials_bank' && (
        <section className="space-y-5">
          <h2 className="t-title-3">{t('step_credentials_bank')}</h2>
          {credSlugs.map((slug) => {
            const cat = CATEGORY_LIST.find((c) => c.slug === slug)
            const opts = statutoryOptionsForCategory(slug)
            return (
              <div key={slug} className="space-y-2 rounded-card border border-border p-3" data-testid={`cred-${slug}`}>
                <p className="text-sm font-medium">{cat ? pickI18n(cat.name_i18n, locale) : slug}</p>
                <SegmentedControl ariaLabel={tp('credential_kind_label')} size="sm" value={draft.credentialKinds[slug] ?? null} onChange={(v) => update({ credentialKinds: { ...draft.credentialKinds, [slug]: v } })} options={opts.map((o) => ({ value: o, label: tGw(`cred_${o}` as 'cred_ca') }))} />
                <div className="space-y-1">
                  <Label htmlFor={`ob-cred-${slug}`}>{tp('credential_number_label')}</Label>
                  <Input id={`ob-cred-${slug}`} value={draft.credentialNumbers[slug] ?? ''} placeholder={tp('credential_number_placeholder')} onChange={(e) => update({ credentialNumbers: { ...draft.credentialNumbers, [slug]: e.target.value } })} />
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <input type="file" accept="application/pdf,image/jpeg,image/png" aria-label={tp('credential_upload')} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(slug, f) }} />
                  {draft.credentialUploads[slug] && <span className="t-footnote text-success">{tp('credential_uploaded', { name: draft.credentialUploads[slug]!.name })}</span>}
                </div>
              </div>
            )
          })}
          <div className="space-y-3">
            <p className="text-sm font-medium">{tp('step4_title')}</p>
            <div className="space-y-1">
              <Label htmlFor="ob-acct">{tp('bank_account_label')}</Label>
              <Input id="ob-acct" inputMode="numeric" autoComplete="off" value={draft.bankAccount} placeholder={tp('bank_account_placeholder')} onChange={(e) => update({ bankAccount: e.target.value.replace(/\s/g, ''), bankVerified: false })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ob-ifsc">{tp('bank_ifsc_label')}</Label>
              <Input id="ob-ifsc" value={draft.bankIfsc} placeholder={tp('bank_ifsc_placeholder')} className="uppercase" onChange={(e) => update({ bankIfsc: e.target.value.toUpperCase().trim(), bankVerified: false })} />
            </div>
            {draft.bankVerified ? (
              <p className="t-footnote text-success" data-testid="bank-verified">
                {draft.bankStub ? tp('bank_dev_stub') : tp('bank_verified')}
                {draft.bankHolderFromBank ? ` · ${t('holder_from_bank', { name: draft.bankHolderFromBank })}` : ''}
                {draft.bankNameReview && <span className="mt-1 block text-warning" data-testid="bank-name-review">{t('bank_name_review')}</span>}
              </p>
            ) : (
              <Button type="button" variant="secondary" onClick={verifyBank} loading={busy === 'bank'}>{tp('bank_verify_btn')}</Button>
            )}
          </div>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          {tried && !(credsOk && bankOk) && !error && <p className="text-sm text-danger" role="alert">{!credsOk ? tp('credential_required_error') : tp('err_bank_verify_required')}</p>}
          <div className="flex gap-3">
            <Button variant="ghost" onClick={() => go('business')}>{tCommon('back')}</Button>
            <Button className="flex-1" disabled={busy === 'upload'} onClick={() => (credsOk && bankOk ? go('review') : setTried(true))}>{t('continue')}</Button>
          </div>
        </section>
      )}

      {view === 'review' && (
        <section className="space-y-4" data-testid="onboarding-review">
          <h2 className="t-title-3">{t('step_review')}</h2>
          {[
            { key: 'contact' as const, rows: [[t('name_label'), draft.fullName]] },
            { key: 'business' as const, rows: [[tp('gstin_label'), draft.gstin], [tp('legal_name_label'), draft.legalName], [tp('display_name_label'), draft.displayName], [tp('state_label'), stateLabel(draft.stateCode)], [t('primary_category'), pickI18n(CATEGORY_LIST.find((c) => c.slug === draft.primaryCategory)?.name_i18n, locale)]] },
            { key: 'credentials_bank' as const, rows: [...credSlugs.map((s) => [tGw(`cred_${draft.credentialKinds[s] ?? 'ca'}` as 'cred_ca'), draft.credentialNumbers[s] ?? '']), [tp('bank_account_label'), draft.bankAccount ? `•••• ${draft.bankAccount.slice(-4)}` : ''], [tp('bank_ifsc_label'), draft.bankIfsc]] },
          ].map((sec) => (
            <div key={sec.key} className="rounded-card border border-border p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">{stepNames[ONBOARDING_V3_STEPS.indexOf(sec.key)]}</p>
                <button type="button" onClick={() => go(sec.key)} className="t-footnote font-medium text-primary">{t('edit')}</button>
              </div>
              <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                {sec.rows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-foreground-secondary">{k}</dt>
                    <dd className="min-w-0 truncate">{v || '—'}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <label htmlFor="ob-legal-consent" className="flex cursor-pointer items-start gap-3 rounded-button border border-border px-3 py-2.5 text-sm">
            <input id="ob-legal-consent" type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-primary" />
            <span>
              {tp.rich('addendum_checkbox', {
                terms: (c) => <a href="/terms" target="_blank" rel="noopener" className="text-primary underline underline-offset-2">{c}</a>,
                privacy: (c) => <a href="/privacy" target="_blank" rel="noopener" className="text-primary underline underline-offset-2">{c}</a>,
                addendum: (c) => <a href="/provider-addendum" target="_blank" rel="noopener" className="text-primary underline underline-offset-2">{c}</a>,
              })}
            </span>
          </label>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex gap-3">
            <Button variant="ghost" onClick={() => go('credentials_bank')}>{tCommon('back')}</Button>
            <Button className="flex-1" onClick={submit} loading={busy === 'submit'} disabled={!accepted || !businessOk || !credsOk || !bankOk}>{tp('submit_btn')}</Button>
          </div>
        </section>
      )}
    </div>
  )
}
