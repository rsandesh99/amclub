'use client'

import { useState, useEffect, useRef } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { acceptLegalDocs } from '@/lib/legal/client'
import { useRouter } from '@/i18n/navigation'
import { AuthPanel } from '@/components/auth/AuthPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import {
  CATEGORY_LIST,
  categoriesRequiringCredential,
  indianStateOptions,
  pickI18n,
  statutoryOptionsForCategory,
  isStatutoryCredential,
  isValidGstin,
  PROVIDER_LEGAL_DOCS,
  PROVIDER_LANGUAGES,
} from '@amclub/shared'
import { LOCALE_LABELS } from '@/components/catalog/LanguageSwitcher'
import { loadProviderDraft } from '@/components/gateway/draft'

type Step = 'auth' | 'business' | 'kyc' | 'bank' | 'submit' | 'under_review'

const DRAFT_KEY = 'amclub_provider_wizard_draft'
// A provider may list in up to 5 categories (server enforces the same — §5).
const MAX_CATEGORIES = 5
// Drafts older than this are discarded (signed credential URLs expire ~7d, and
// stale verification flags shouldn't linger).
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface CredentialUpload {
  url: string
  name: string
  /** Statutory credential type (ca/cs/cma/adv/gstp/dsa) for this category. */
  kind?: string
  /** Membership / enrolment / registration number for that credential. */
  number?: string
}

interface Draft {
  phone: string
  email: string
  legalName: string
  displayName: string
  about: string
  yearsExperience: string
  website: string
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
  credentialUploads: Record<string, CredentialUpload>
  /** Credential type picked per category BEFORE the document is uploaded. */
  credentialKinds: Record<string, string>
  /** Credential number typed per category BEFORE the document is uploaded. */
  credentialNumbers: Record<string, string>
}

const EMPTY: Draft = {
  phone: '', email: '', legalName: '', displayName: '', about: '',
  yearsExperience: '', website: '',
  gstin: '', gstinVerified: false, gstinStub: false, pan: '',
  categorySlugs: [], stateCode: '', city: '', languages: ['en'],
  bankIfsc: '', bankAccount: '', bankHolder: '',
  bankVerified: false, bankStub: false, credentialUploads: {},
  credentialKinds: {}, credentialNumbers: {},
}

/** S1.6 — the confirmed WhatsApp interview draft as the server passes it (GET /api/v1/agent/onboarding/draft shape). */
export interface WaDraftProp {
  sessionId: string
  draft: { profile: { display_name: string | null; legal_name: string | null; about: string | null; city: string | null; state: string | null; languages: string[]; category_slugs: string[] } } | null
  gstin: string | null
}

interface ProviderWizardProps {
  /** True when the user is already authenticated and only needs to complete KYC. */
  skipAuth?: boolean
  /** S1.6 — server-evaluated "Finish on WhatsApp" flag; undefined ⇒ the wizard asks /profile/me itself. */
  waEnabled?: boolean
  /** S1.6 — server-loaded confirmed draft; undefined ⇒ the wizard asks the draft route itself. */
  waDraft?: WaDraftProp | null
  /** E0 (U1) — the sanitized page the applicant was heading to when the auth wall sent them here. */
  next?: string | null
  /** Experience v3 E10 — after sign-in, continue in the v3 wizard at this path instead of the v2 steps. */
  handoffTo?: string
}

/** Fill only EMPTY fields from a confirmed draft; returns the patch and the keys it filled. */
function prefillFromWa(d: Draft, v: WaDraftProp | null | undefined): { next: Partial<Draft>; filled: string[] } {
  const next: Partial<Draft> = {}
  const filled: string[] = []
  const p = v?.draft?.profile
  if (!v || !p) return { next, filled }
  if (p.display_name && !d.displayName.trim()) { next.displayName = p.display_name; filled.push('displayName') }
  if (p.legal_name && !d.legalName.trim()) { next.legalName = p.legal_name; filled.push('legalName') }
  if (p.about && !d.about.trim()) { next.about = p.about; filled.push('about') }
  if (p.city && !d.city.trim()) { next.city = p.city; filled.push('city') }
  if (p.state && !d.stateCode) { next.stateCode = p.state; filled.push('stateCode') }
  if (typeof v.gstin === 'string' && v.gstin && !d.gstin) { next.gstin = v.gstin; filled.push('gstin') }
  if (Array.isArray(p.languages) && p.languages.length > 0 && d.languages.length === 1 && d.languages[0] === 'en') {
    const langs = p.languages.filter((l) => (PROVIDER_LANGUAGES as readonly string[]).includes(l))
    if (langs.length > 0) { next.languages = langs; filled.push('languages') }
  }
  if (Array.isArray(p.category_slugs) && p.category_slugs.length > 0 && d.categorySlugs.length === 0) {
    next.categorySlugs = p.category_slugs.slice(0, MAX_CATEGORIES); filled.push('categorySlugs')
  }
  return { next, filled }
}

export function ProviderWizard({ skipAuth, waEnabled: waEnabledProp, waDraft: waDraftProp, next = null, handoffTo }: ProviderWizardProps) {
  const t = useTranslations('provider_signup')
  const tCommon = useTranslations('common')
  // Credential type labels live in the gateway namespace (translated in all 4
  // locales) — reuse them instead of duplicating.
  const tGw = useTranslations('gateway')
  const router = useRouter()
  const locale = useLocale()

  const [step, setStep] = useState<Step>(skipAuth ? 'business' : 'auth')
  // Phase 2b/2d — Terms+Privacy consent on the auth step; all three documents
  // (incl. the Provider Addendum) on the submit step. Rows are written right
  // before the profile POST, which refuses without them.
  const [legalAccepted, setLegalAccepted] = useState(false)
  const [addendumAccepted, setAddendumAccepted] = useState(false)
  // S1.6 — a server-passed confirmed draft prefills the initial state so the chips render on first paint.
  const serverPrefill = prefillFromWa(EMPTY, waDraftProp)
  const [draft, setDraft] = useState<Draft>({ ...EMPTY, ...serverPrefill.next })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [gstinLoading, setGstinLoading] = useState(false)
  const [bankLoading, setBankLoading] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [uploadingFor, setUploadingFor] = useState<string | null>(null)
  // Set on a failed "Continue" so each missing required field highlights red
  // instead of one generic message leaving the user hunting.
  const [triedContinue, setTriedContinue] = useState(false)
  // S1.6 — "Finish on WhatsApp": the card shows when /profile/me.onboardingWhatsAppEnabled; a CONFIRMED
  // interview draft prefills the empty fields (a chip marks each) and its session id rides the submit.
  // The wizard still owns KYC, bank, legal acceptance and the profile write exactly as before.
  const [waEnabled, setWaEnabled] = useState(waEnabledProp === true)
  const [waStart, setWaStart] = useState<{ sessionId: string; whatsappNumber: string | null; needsOptIn: boolean } | null>(null)
  const [waBusy, setWaBusy] = useState(false)
  const [waError, setWaError] = useState('')
  const [waSessionId, setWaSessionId] = useState<string | null>(waDraftProp?.draft ? waDraftProp.sessionId : null)
  const [fromWa, setFromWa] = useState<string[]>(serverPrefill.filled)
  const draftRef = useRef(draft)
  useEffect(() => { draftRef.current = draft }, [draft])

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
      // The account number is never persisted, so it comes back blank — a
      // stored "verified" flag would then let the wizard submit with NO
      // account. Verification always re-runs against the re-entered number.
      setDraft((d) => {
        const next = { ...d, ...parsed, bankAccount: '' }
        return next.bankAccount ? next : { ...next, bankVerified: false, bankStub: false }
      })
      setDraftRestored(true)
      setTimeout(() => setDraftRestored(false), 3000)
    } catch {}
  }, [])

  // Phase 8a — seed category, state, experience and declared credential from
  // the gateway's partner mini-wizard when this wizard has no answer of its own
  // yet (own draft always wins).
  useEffect(() => {
    const gw = loadProviderDraft()
    if (!gw) return
    setDraft((d) => {
      const categorySlugs =
        d.categorySlugs.length > 0 ? d.categorySlugs : gw.cat ? [gw.cat] : []
      // Pre-select the credential TYPE the visitor declared at the gateway for
      // the category it was declared against (statutory credentials only —
      // firm/freelancer have no per-category credential row).
      const credentialKinds = { ...d.credentialKinds }
      if (
        gw.cat &&
        gw.cred &&
        !credentialKinds[gw.cat] &&
        isStatutoryCredential(gw.cred) &&
        statutoryOptionsForCategory(gw.cat).includes(gw.cred)
      ) {
        credentialKinds[gw.cat] = gw.cred
      }
      return {
        ...d,
        categorySlugs,
        stateCode: d.stateCode || (gw.state ?? ''),
        yearsExperience: d.yearsExperience || (gw.exp ?? ''),
        credentialKinds,
      }
    })
  }, [])

  // S1.6 — client fallback when the parent passed no server props (the /partner/signup entry):
  // flag from /profile/me, prefill from the draft route (own draft always wins; only empty fields are filled).
  useEffect(() => {
    if (waEnabledProp !== undefined && waDraftProp !== undefined) return
    let cancelled = false
    ;(async () => {
      try {
        if (waEnabledProp === undefined) {
          // Always drain the body: an unread 401 body keeps the request "in flight" in Chromium (never networkidle).
          const me = await fetch('/api/v1/profile/me', { cache: 'no-store' })
            .then(async (r) => { const j = await r.json().catch(() => null); return r.ok ? j : null })
            .catch(() => null)
          if (cancelled) return
          if (me?.onboardingWhatsAppEnabled) setWaEnabled(true)
        }
        if (waDraftProp !== undefined) return
        const res = await fetch('/api/v1/agent/onboarding/draft', { cache: 'no-store' })
        const v = (await res.json().catch(() => null)) as WaDraftProp | null // drained even on 404 (flag off)
        if (!res.ok || cancelled || !v) return
        const { next, filled } = prefillFromWa(draftRef.current, v)
        if (Object.keys(next).length > 0) setDraft((cur) => ({ ...cur, ...next }))
        if (filled.length > 0) setFromWa(filled)
        if (v?.draft) setWaSessionId(v.sessionId)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [waEnabledProp, waDraftProp])

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

  // S1.6 — start (or resume) the WhatsApp interview; the reply carries the number and whether START is needed first.
  async function startWhatsApp() {
    setWaBusy(true)
    setWaError('')
    try {
      const res = await fetch('/api/v1/agent/onboarding/start', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (res.status === 201 || (res.status === 409 && d.error === 'session_active' && d.sessionId)) {
        setWaStart({ sessionId: d.sessionId, whatsappNumber: d.whatsappNumber ?? null, needsOptIn: d.needsOptIn !== false })
      } else if (res.status === 404) {
        setWaEnabled(false)
      } else {
        setWaError(t('wa_card_failed'))
      }
    } catch {
      setWaError(t('wa_card_failed'))
    } finally {
      setWaBusy(false)
    }
  }
  const waChip = (key: string) =>
    fromWa.includes(key) ? <span className="ml-2 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">{t('wa_prefill_chip')}</span> : null

  // Already a provider → dashboard; otherwise continue KYC (new or msme-only user).
  async function handleAuthenticated() {
    const res = await fetch('/api/v1/profile/me')
    const d = await res.json().catch(() => ({}))
    if (d.hasProviderProfile) router.push(next ?? '/partner')
    else if (handoffTo) router.push(handoffTo as '/partner/onboarding')
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

  // Credential gating: categories where listing requires a statutory
  // credential (type + membership number + certificate document). GSTIN/PAN
  // are API-verified separately.
  const credsNeededSlugs = categoriesRequiringCredential(draft.categorySlugs)
  const credsRequired = credsNeededSlugs.length > 0
  const credsComplete = credsNeededSlugs.every(
    (slug) =>
      !!draft.credentialUploads[slug] &&
      !!draft.credentialKinds[slug] &&
      !!draft.credentialNumbers[slug]?.trim(),
  )

  async function verifyGstin() {
    if (!draft.gstin) return
    // Format + checksum check BEFORE the paid API call, with a specific
    // message — "could not verify" must mean the registry said no, not a typo.
    if (!isValidGstin(draft.gstin)) {
      setError(t('gstin_invalid_format'))
      return
    }
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
        setError(t('bank_verify_failed'))
      }
    } catch {
      setError(t('bank_verify_failed'))
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
    if (!addendumAccepted) {
      setError(t('addendum_required'))
      return
    }
    // Never submit a "verified" bank flag without the account it verified.
    if (!draft.bankVerified || !draft.bankAccount) {
      setError(t('err_bank_verify_required'))
      setStep('bank')
      return
    }
    setLoading(true)
    setError('')
    try {
      // Terms + Privacy + Provider Addendum rows first — the endpoint is gated.
      const legal = await acceptLegalDocs([...PROVIDER_LEGAL_DOCS], locale)
      if (!legal.ok) throw new Error(t('error_generic'))
      const res = await fetch('/api/v1/profile/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: draft.phone,
          email: draft.email,
          legalName: draft.legalName,
          displayName: draft.displayName,
          about: draft.about,
          ...(waSessionId ? { onboardingSessionId: waSessionId } : {}),
          yearsExperience: draft.yearsExperience || undefined,
          website: draft.website.trim() || undefined,
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
          // Fold the per-category credential type + number into each upload so
          // the server can write precise verification rows (kind + value).
          credentialUploads: Object.fromEntries(
            Object.entries(draft.credentialUploads).map(([slug, u]) => [
              slug,
              {
                ...u,
                kind: draft.credentialKinds[slug],
                number: draft.credentialNumbers[slug]?.trim(),
              },
            ]),
          ),
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
          <AuthPanel
            onAuthenticated={handleAuthenticated}
            googleRedirectTo="/partner/onboarding"
            consent={{ checked: legalAccepted, onChange: setLegalAccepted }}
          />
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
            {waEnabled && (
              <div className="rounded-button border border-primary/30 bg-primary/5 p-3">
                <p className="text-sm font-medium text-primary">{t('wa_card_title')}</p>
                <p className="mt-1 text-xs text-foreground-secondary">{t('wa_card_body')}</p>
                {waStart ? (
                  <div className="mt-2 text-xs text-foreground">
                    <p>{waStart.needsOptIn ? t('wa_card_steps_opt_in') : t('wa_card_steps')}</p>
                    {waStart.whatsappNumber ? (
                      <a
                        href={`https://wa.me/${waStart.whatsappNumber}?text=${encodeURIComponent(waStart.needsOptIn ? 'START' : 'JOIN')}`}
                        target="_blank"
                        rel="noopener"
                        className="mt-1 inline-block text-primary underline underline-offset-2"
                      >
                        {t('wa_card_open', { number: `+${waStart.whatsappNumber}` })}
                      </a>
                    ) : (
                      <p className="mt-1 text-foreground-secondary">{t('wa_card_no_number')}</p>
                    )}
                  </div>
                ) : (
                  <Button variant="outline" size="md" className="mt-2" onClick={startWhatsApp} loading={waBusy}>{t('wa_card_button')}</Button>
                )}
                {waError && <p className="mt-1 text-xs text-danger">{waError}</p>}
              </div>
            )}
            {fromWa.length > 0 && <p className="rounded-button bg-success/10 px-3 py-2 text-xs text-success">{t('wa_prefill_notice')}</p>}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="legalName">{t('legal_name_label')} <span className="text-danger">*</span>{waChip('legalName')}</Label>
              <Input id="legalName" placeholder={t('legal_name_placeholder')} value={draft.legalName} onChange={(e) => update({ legalName: e.target.value })} className={triedContinue && !draft.legalName.trim() ? 'border-danger' : ''} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="displayName">{t('display_name_label')} <span className="text-danger">*</span>{waChip('displayName')}</Label>
              <Input id="displayName" placeholder={t('display_name_placeholder')} value={draft.displayName} onChange={(e) => update({ displayName: e.target.value })} className={triedContinue && !draft.displayName.trim() ? 'border-danger' : ''} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="about">{t('about_label')}{waChip('about')}</Label>
              <Textarea id="about" placeholder={t('about_placeholder')} value={draft.about} onChange={(e) => update({ about: e.target.value })} rows={4} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('categories_label')} <span className="text-danger">*</span>{waChip('categorySlugs')}</Label>
              <p className={`text-xs ${triedContinue && draft.categorySlugs.length === 0 ? 'text-danger' : 'text-foreground-secondary'}`}>
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
                      {pickI18n(cat.name_i18n, locale)}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="stateCode">{t('state_label')} <span className="text-danger">*</span>{waChip('stateCode')}</Label>
                <Select id="stateCode" value={draft.stateCode} onChange={(e) => update({ stateCode: e.target.value })} placeholder={t('state_placeholder')} className={triedContinue && !draft.stateCode ? 'border-danger' : ''}>
                  {indianStateOptions(locale).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </Select>
              </div>
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="city">{t('city_label')}{waChip('city')}</Label>
                <Input id="city" placeholder={t('city_placeholder')} autoComplete="address-level2" value={draft.city} onChange={(e) => update({ city: e.target.value })} />
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="yearsExp">{t('experience_label')}</Label>
                <Select
                  id="yearsExp"
                  value={draft.yearsExperience}
                  onChange={(e) => update({ yearsExperience: e.target.value })}
                  placeholder={t('experience_placeholder')}
                >
                  <option value="0-2">{t('exp_0_2')}</option>
                  <option value="3-9">{t('exp_3_9')}</option>
                  <option value="10+">{t('exp_10p')}</option>
                </Select>
              </div>
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="website">
                  {t('website_label')}{' '}
                  <span className="text-foreground-secondary font-normal">({tCommon('optional')})</span>
                </Label>
                <Input
                  id="website"
                  type="url"
                  inputMode="url"
                  placeholder="https://…"
                  value={draft.website}
                  onChange={(e) => update({ website: e.target.value })}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('languages_label')}{waChip('languages')}</Label>
              <div className="flex gap-2">
                {PROVIDER_LANGUAGES.map((lang) => (
                  <button key={lang} type="button" onClick={() => toggleLanguage(lang)} lang={lang} aria-pressed={draft.languages.includes(lang)}
                    className={`min-h-[44px] rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${draft.languages.includes(lang) ? 'border-primary bg-primary text-white' : 'border-border text-foreground hover:border-primary'}`}>
                    {LOCALE_LABELS[lang]}
                  </button>
                ))}
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button
              onClick={() => {
                if (!draft.legalName.trim() || !draft.displayName.trim() || draft.categorySlugs.length === 0 || !draft.stateCode) {
                  setTriedContinue(true)
                  setError(t('err_business_required'))
                  return
                }
                setTriedContinue(false)
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
              <Label htmlFor="gstin">{t('gstin_label')} <span className="text-danger">*</span>{waChip('gstin')}</Label>
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
                  const kindOptions = statutoryOptionsForCategory(slug)
                  const pickedKind = draft.credentialKinds[slug] ?? ''
                  const number = draft.credentialNumbers[slug] ?? ''
                  return (
                    <div key={slug} className="flex flex-col gap-3 rounded-button border border-border p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">{cat ? pickI18n(cat.name_i18n, locale) : slug}</p>
                        {uploaded && pickedKind && number.trim() ? (
                          <p className="text-xs text-success">{t('credential_uploaded', { name: uploaded.name })}</p>
                        ) : (
                          <p className="text-xs text-warning">{t('credential_required_badge')}</p>
                        )}
                      </div>
                      <div className="flex gap-3">
                        <div className="flex-1 flex flex-col gap-1.5">
                          <Label htmlFor={`credkind-${slug}`}>{t('credential_kind_label')}</Label>
                          <Select
                            id={`credkind-${slug}`}
                            value={pickedKind}
                            onChange={(e) =>
                              update({ credentialKinds: { ...draft.credentialKinds, [slug]: e.target.value } })
                            }
                            placeholder={t('credential_kind_placeholder')}
                          >
                            {kindOptions.map((o) => (
                              <option key={o} value={o}>{tGw(`cred_${o}` as 'cred_ca')}</option>
                            ))}
                          </Select>
                        </div>
                        <div className="flex-1 flex flex-col gap-1.5">
                          <Label htmlFor={`crednum-${slug}`}>{t('credential_number_label')}</Label>
                          <Input
                            id={`crednum-${slug}`}
                            placeholder={t('credential_number_placeholder')}
                            value={number}
                            maxLength={40}
                            onChange={(e) =>
                              update({ credentialNumbers: { ...draft.credentialNumbers, [slug]: e.target.value } })
                            }
                          />
                        </div>
                      </div>
                      <label className="cursor-pointer self-start">
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
                          {uploadingFor === slug ? '…' : uploaded ? t('credential_reupload') : t('credential_upload')}
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
              <Input id="bankHolder" placeholder={t('bank_holder_placeholder')} autoComplete="name" value={draft.bankHolder} onChange={(e) => update({ bankHolder: e.target.value, bankVerified: false })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bankAccount">{t('bank_account_label')}</Label>
              <Input id="bankAccount" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" placeholder={t('bank_account_placeholder')} value={draft.bankAccount} onChange={(e) => update({ bankAccount: e.target.value.replace(/\D/g, '').slice(0, 18), bankVerified: false })} />
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
                  if (!draft.bankVerified || !draft.bankAccount) { setError(t('err_bank_verify_required')); return }
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
              { key: 'bank', done: draft.bankVerified && !!draft.bankAccount, label: t('submit_checklist_bank') },
            ].map(({ key, done, label }) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                <span className={done ? 'text-success' : 'text-foreground-secondary'}>{done ? '✓' : '○'}</span>
                <span className={done ? 'text-foreground' : 'text-foreground-secondary'}>{label}</span>
              </div>
            ))}
          </div>
          {/* Phase 2b/2d — explicit acceptance covering all three documents (Google
              arrivals skipped the auth-step checkbox; the addendum is provider-only). */}
          <label htmlFor="provider-legal-consent" className="flex cursor-pointer items-start gap-3 rounded-button border border-border bg-surface px-3 py-2.5 text-sm leading-relaxed text-foreground">
            <input
              id="provider-legal-consent"
              type="checkbox"
              checked={addendumAccepted}
              onChange={(e) => setAddendumAccepted(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-primary"
            />
            <span>
              {t.rich('addendum_checkbox', {
                terms: (chunks) => <a href="/terms" target="_blank" rel="noopener" className="text-primary underline underline-offset-2 hover:no-underline">{chunks}</a>,
                privacy: (chunks) => <a href="/privacy" target="_blank" rel="noopener" className="text-primary underline underline-offset-2 hover:no-underline">{chunks}</a>,
                addendum: (chunks) => <a href="/provider-addendum" target="_blank" rel="noopener" className="text-primary underline underline-offset-2 hover:no-underline">{chunks}</a>,
              })}
            </span>
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-3">
            <Button variant="ghost" onClick={goBack} disabled={loading} className="shrink-0">{tCommon('back')}</Button>
            <Button
              onClick={submitForReview}
              loading={loading}
              disabled={!draft.gstinVerified || !credsComplete || !draft.bankVerified || !draft.bankAccount || !addendumAccepted}
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
          {next && (
            <Button onClick={() => router.push(next)} className="w-full max-w-xs">
              {t('continue_to_next')}
            </Button>
          )}
          <Button onClick={() => router.push('/services')} variant={next ? 'outline' : 'primary'} className="w-full max-w-xs">
            {t('browse_as_msme')}
          </Button>
        </div>
      )}
    </div>
  )
}
