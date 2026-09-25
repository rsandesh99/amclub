'use client'

import { useRef, useState, type ReactNode } from 'react'
import { MEMBER_PRICING_ENABLED } from '@/lib/public-flags'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import {
  CATEGORY_LIST,
  packageSchema,
  PACKAGE_MAX_DELIVERY_DAYS,
  PACKAGE_MAX_DISCOUNT_BPS,
  PACKAGE_MAX_MEMBER_DISCOUNT_BPS,
  PACKAGE_MAX_REVISIONS,
  priceDisplay,
  SPECIALIZATIONS,
  type CategorySlug,
} from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { PriceBlock } from '@/components/catalog/PriceBlock'
import { LIST_COMMIT_ATTR, ListBuilder, type ListBuilderHandle } from './ListBuilder'

export interface PackageDraft {
  id?: string
  categorySlug: string
  title: string
  scopeIncluded: string[]
  scopeExcluded: string[]
  deliverables: string[]
  requirements: string[]
  priceRupees: string
  discountPct: string
  memberPct: string
  deliveryDays: string
  revisionCount: string
  faqs: { question: string; answer: string }[]
  /** Experience v3 E2 — the level-2 service ('' = none). */
  serviceSlug?: string
}

const EMPTY: PackageDraft = {
  categorySlug: '', title: '', scopeIncluded: [], scopeExcluded: [],
  deliverables: [], requirements: [], priceRupees: '', discountPct: '0',
  memberPct: '0', deliveryDays: '7', revisionCount: '1', faqs: [], serviceSlug: '',
}

const STEPS = ['basics', 'scope', 'deliverables', 'pricing', 'faqs', 'preview'] as const
type Step = (typeof STEPS)[number]

type PricingField = 'price' | 'discount' | 'member' | 'delivery' | 'revisions'

/** A typed number scaled to the stored unit; blank or non-numeric → NaN (which every schema refuses). */
function typedInt(s: string, scale = 1): number {
  const v = s.trim()
  const n = Number(v)
  return v === '' || !Number.isFinite(n) ? Number.NaN : Math.round(n * scale)
}

/**
 * QA F3 — every pricing field against the SAME shared schema the partner
 * routes validate with (no bounds of our own), so the wizard never previews
 * or submits a listing the server would refuse (e.g. "150 % off" → ₹0).
 */
function pricingProblems(d: PackageDraft): Partial<Record<PricingField, true>> {
  const shape = packageSchema.shape
  const out: Partial<Record<PricingField, true>> = {}
  if (!shape.price_paise.safeParse(typedInt(d.priceRupees, 100)).success) out.price = true
  if (!shape.discount_bps.safeParse(typedInt(d.discountPct || '0', 100)).success) out.discount = true
  // Hidden while memberships don't exist: the saved (already valid) value goes back unchanged.
  if (MEMBER_PRICING_ENABLED && !shape.member_extra_discount_bps.safeParse(typedInt(d.memberPct || '0', 100)).success) out.member = true
  if (!shape.delivery_days.safeParse(typedInt(d.deliveryDays)).success) out.delivery = true
  if (!shape.revision_count.safeParse(typedInt(d.revisionCount || '0')).success) out.revisions = true
  return out
}

export function PackageWizard({
  mode,
  initial,
  allowedCategorySlugs,
  offerServices = false,
  pricingExtras,
}: {
  mode: 'create' | 'edit'
  initial?: Partial<PackageDraft>
  allowedCategorySlugs: string[]
  /** Experience v3 E2 (flag `search`): ask which service this package is. */
  offerServices?: boolean
  /** Edit only: the add-ons / plan editors, shown on the Pricing step above the step buttons. */
  pricingExtras?: ReactNode
}) {
  const tServices = useTranslations('services')
  const t = useTranslations('listings')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [draft, setDraft] = useState<PackageDraft>({ ...EMPTY, ...initial })
  const [stepIdx, setStepIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Pricing errors show inline: at once for a typed bad value, and for a blank one after Continue.
  const [pricingTried, setPricingTried] = useState(false)
  const step: Step = STEPS[stepIdx]!
  // Typed-but-not-added list text is committed before Continue validates.
  const scopeInRef = useRef<ListBuilderHandle>(null)
  const scopeOutRef = useRef<ListBuilderHandle>(null)
  const deliverablesRef = useRef<ListBuilderHandle>(null)
  const requirementsRef = useRef<ListBuilderHandle>(null)

  const categories = CATEGORY_LIST.filter(
    (c) => allowedCategorySlugs.length === 0 || allowedCategorySlugs.includes(c.slug),
  )

  function set(patch: Partial<PackageDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
    // QA F16 — a step's message ("Please choose a category.") goes once the field is edited;
    // Continue re-checks the step.
    setError('')
  }

  function commitPendingLists(): PackageDraft {
    const patch: Partial<PackageDraft> = {}
    if (scopeInRef.current) patch.scopeIncluded = scopeInRef.current.commit()
    if (scopeOutRef.current) patch.scopeExcluded = scopeOutRef.current.commit()
    if (deliverablesRef.current) patch.deliverables = deliverablesRef.current.commit()
    if (requirementsRef.current) patch.requirements = requirementsRef.current.commit()
    return { ...draft, ...patch }
  }

  function pricingMessage(field: PricingField): string {
    switch (field) {
      case 'price': return t('err_price')
      case 'discount': return t('err_discount', { max: PACKAGE_MAX_DISCOUNT_BPS / 100 })
      case 'member': return t('err_member', { max: PACKAGE_MAX_MEMBER_DISCOUNT_BPS / 100 })
      case 'delivery': return t('err_delivery', { max: PACKAGE_MAX_DELIVERY_DAYS })
      case 'revisions': return t('err_revisions', { max: PACKAGE_MAX_REVISIONS })
    }
  }

  function validateStep(d: PackageDraft = draft, s: Step = step): string | null {
    const draft = d
    if (s === 'basics') {
      if (!draft.categorySlug) return t('err_category')
      if (draft.title.trim().length < 5) return t('err_title')
    }
    if (s === 'scope' && draft.scopeIncluded.length === 0) return t('err_scope')
    if (s === 'deliverables' && draft.deliverables.length === 0) return t('err_deliverables')
    if (s === 'pricing') {
      const bad = (['price', 'discount', 'member', 'delivery', 'revisions'] as const).find((f) => pricingProblems(draft)[f])
      if (bad) return pricingMessage(bad)
    }
    return null
  }

  function next() {
    const err = validateStep(commitPendingLists())
    if (err) {
      // Pricing problems are shown next to their fields, not repeated below.
      if (step === 'pricing') {
        setPricingTried(true)
        setError('')
      } else {
        setError(err)
      }
      return
    }
    setError('')
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1))
  }

  function back() {
    setError('')
    setStepIdx((i) => Math.max(i - 1, 0))
  }

  function toPayload(status: 'draft' | 'active') {
    return {
      category_slug: draft.categorySlug,
      title: draft.title.trim(),
      scope_included: draft.scopeIncluded,
      scope_excluded: draft.scopeExcluded,
      deliverables: draft.deliverables,
      requirements: draft.requirements,
      price_paise: Math.round(Number(draft.priceRupees) * 100),
      discount_bps: Math.round(Number(draft.discountPct || '0') * 100),
      member_extra_discount_bps: Math.round(Number(draft.memberPct || '0') * 100),
      delivery_days: Math.round(Number(draft.deliveryDays)),
      revision_count: Math.round(Number(draft.revisionCount || '0')),
      faqs: draft.faqs.filter((f) => f.question.trim() && f.answer.trim()),
      status,
      ...(offerServices ? { service_slug: draft.serviceSlug || null } : {}),
    }
  }

  async function submit(status: 'draft' | 'active') {
    if (blocking) return
    setError('')
    setLoading(true)
    try {
      const url = mode === 'edit' && draft.id ? `/api/v1/partner/packages/${draft.id}` : '/api/v1/partner/packages'
      const method = mode === 'edit' ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toPayload(status)),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(typeof d.error === 'string' ? d.error : t('save_failed'))
      }
      router.push('/partner/listings')
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('save_failed'))
    } finally {
      setLoading(false)
    }
  }

  const progress = ((stepIdx + 1) / STEPS.length) * 100
  const priceP = Math.round(Number(draft.priceRupees || '0') * 100)
  const discountB = Math.round(Number(draft.discountPct || '0') * 100)
  const memberB = Math.round(Number(draft.memberPct || '0') * 100)
  // N16 — the preview runs the SAME shared priceDisplay the server sends buyers.
  const previewDisplay = priceDisplay({ pricePaise: priceP, discountBps: discountB, memberExtraDiscountBps: memberB })
  const pricing = pricingProblems(draft)
  const typed: Record<PricingField, string> = {
    price: draft.priceRupees, discount: draft.discountPct, member: draft.memberPct,
    delivery: draft.deliveryDays, revisions: draft.revisionCount,
  }
  const pricingShown = (f: PricingField) => !!pricing[f] && (pricingTried || typed[f].trim() !== '')
  const errorFor = (f: PricingField) => (pricingShown(f) ? { error: pricingMessage(f) } : {})
  const anyPricingShown = (Object.keys(typed) as PricingField[]).some(pricingShown)
  // A price is previewed only from inputs the server would accept — never ₹0 or "150 % off".
  const priceValid = !pricing.price && !pricing.discount && !pricing.member
  // Nothing is saved while any earlier step would be refused.
  const blocking = STEPS.filter((s) => s !== 'preview').map((s) => validateStep(draft, s)).find((e) => e !== null) ?? null

  // Platform commission for the selected category (bps → %), shown wherever the
  // provider sets or reviews their rate. Falls back to the 5% launch default.
  const commissionBps =
    CATEGORY_LIST.find((c) => c.slug === draft.categorySlug)?.commission_bps ?? 500
  const commissionPct =
    Number.isInteger(commissionBps / 100) ? String(commissionBps / 100) : (commissionBps / 100).toFixed(1)

  return (
    <div className="mx-auto max-w-2xl">
      <Progress value={progress} label={t(`step_${step}` as 'step_basics')} className="mb-6" />

      <div className="rounded-card border border-border bg-surface p-6 shadow-card">
        {step === 'basics' && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="cat">{t('category')}</Label>
              <Select
                id="cat"
                value={draft.categorySlug}
                onChange={(e) => set({ categorySlug: e.target.value, serviceSlug: '' })}
              >
                <option value="">{t('select_category')}</option>
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name_i18n.en}
                  </option>
                ))}
              </Select>
            </div>
            {offerServices && draft.categorySlug && SPECIALIZATIONS[draft.categorySlug as CategorySlug] && (
              <div>
                <Label>{t('service_label')}</Label>
                <p className="mb-2 text-xs text-foreground-secondary">{t('service_hint')}</p>
                <div className="flex flex-wrap gap-2" role="group" aria-label={t('service_label')}>
                  {SPECIALIZATIONS[draft.categorySlug as CategorySlug].map((sv) => {
                    const on = draft.serviceSlug === sv
                    return (
                      <button
                        key={sv}
                        type="button"
                        aria-pressed={on}
                        onClick={() => set({ serviceSlug: on ? '' : sv })}
                        className={on ? 'min-h-[36px] rounded-chip border border-primary bg-primary/10 px-3 text-sm font-medium text-primary' : 'min-h-[36px] rounded-chip border border-border px-3 text-sm text-foreground-secondary hover:border-primary/40'}
                      >
                        {tServices(sv as 'gst-filing')}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            <div>
              <Label htmlFor="title">{t('title_label')}</Label>
              <Input
                id="title"
                value={draft.title}
                onChange={(e) => set({ title: e.target.value })}
                placeholder={t('title_placeholder')}
                maxLength={200}
              />
            </div>
          </div>
        )}

        {step === 'scope' && (
          <div className="space-y-5">
            <div>
              <Label>{t('scope_included')}</Label>
              <p className="mb-2 text-xs text-foreground-secondary">{t('scope_included_hint')}</p>
              <ListBuilder
                ref={scopeInRef}
                items={draft.scopeIncluded}
                onChange={(scopeIncluded) => set({ scopeIncluded })}
                placeholder={t('scope_placeholder')}
                addLabel={tCommon('add')}
              />
            </div>
            <div>
              <Label>{t('scope_excluded')}</Label>
              <p className="mb-2 text-xs text-foreground-secondary">{t('scope_excluded_hint')}</p>
              <ListBuilder
                ref={scopeOutRef}
                items={draft.scopeExcluded}
                onChange={(scopeExcluded) => set({ scopeExcluded })}
                placeholder={t('scope_excluded_placeholder')}
                addLabel={tCommon('add')}
              />
            </div>
          </div>
        )}

        {step === 'deliverables' && (
          <div className="space-y-5">
            <div>
              <Label>{t('deliverables')}</Label>
              <p className="mb-2 text-xs text-foreground-secondary">{t('deliverables_hint')}</p>
              <ListBuilder
                ref={deliverablesRef}
                items={draft.deliverables}
                onChange={(deliverables) => set({ deliverables })}
                placeholder={t('deliverables_placeholder')}
                addLabel={tCommon('add')}
              />
            </div>
            <div>
              <Label>{t('requirements')}</Label>
              <p className="mb-2 text-xs text-foreground-secondary">{t('requirements_hint')}</p>
              <ListBuilder
                ref={requirementsRef}
                items={draft.requirements}
                onChange={(requirements) => set({ requirements })}
                placeholder={t('requirements_placeholder')}
                addLabel={tCommon('add')}
              />
            </div>
          </div>
        )}

        {step === 'pricing' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="price">{t('price_label')}</Label>
                <Input
                  id="price"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={draft.priceRupees}
                  onChange={(e) => set({ priceRupees: e.target.value })}
                  placeholder="4999"
                  {...errorFor('price')}
                />
              </div>
              <div>
                <Label htmlFor="discount">{t('discount_label')}</Label>
                <Input
                  id="discount"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={PACKAGE_MAX_DISCOUNT_BPS / 100}
                  value={draft.discountPct}
                  onChange={(e) => set({ discountPct: e.target.value })}
                  {...errorFor('discount')}
                />
              </div>
              {/* Memberships don't exist yet (E0 / U2): the field stays hidden and
                  any saved value is sent back unchanged. */}
              {MEMBER_PRICING_ENABLED && (
                <div>
                  <Label htmlFor="member">{t('member_label')}</Label>
                  <Input
                    id="member"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={PACKAGE_MAX_MEMBER_DISCOUNT_BPS / 100}
                    value={draft.memberPct}
                    onChange={(e) => set({ memberPct: e.target.value })}
                    {...errorFor('member')}
                  />
                </div>
              )}
              <div>
                <Label htmlFor="delivery">{t('delivery_label')}</Label>
                <Input
                  id="delivery"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={PACKAGE_MAX_DELIVERY_DAYS}
                  value={draft.deliveryDays}
                  onChange={(e) => set({ deliveryDays: e.target.value })}
                  {...errorFor('delivery')}
                />
              </div>
              <div>
                <Label htmlFor="rev">{t('revisions_label')}</Label>
                <Input
                  id="rev"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={PACKAGE_MAX_REVISIONS}
                  value={draft.revisionCount}
                  onChange={(e) => set({ revisionCount: e.target.value })}
                  {...errorFor('revisions')}
                />
              </div>
            </div>
            <p className="text-sm text-foreground-secondary">
              {t('commission_note', { pct: commissionPct })}{' '}
              <span className="text-xs text-foreground-secondary/70">{t('commission_subject')}</span>
            </p>
            {priceValid && (
              <div className="rounded-button border border-border bg-background p-3">
                <p className="mb-1 text-xs text-foreground-secondary">{t('preview_price')}</p>
                <PriceBlock display={previewDisplay} size="detail" />
              </div>
            )}
          </div>
        )}

        {step === 'faqs' && (
          <div className="space-y-4">
            <p className="text-xs text-foreground-secondary">{t('faqs_hint')}</p>
            {draft.faqs.map((f, i) => (
              <div key={i} className="space-y-2 rounded-button border border-border p-3">
                <Input
                  value={f.question}
                  onChange={(e) => {
                    const faqs = [...draft.faqs]
                    faqs[i] = { ...faqs[i]!, question: e.target.value }
                    set({ faqs })
                  }}
                  placeholder={t('faq_q')}
                />
                <Textarea
                  value={f.answer}
                  onChange={(e) => {
                    const faqs = [...draft.faqs]
                    faqs[i] = { ...faqs[i]!, answer: e.target.value }
                    set({ faqs })
                  }}
                  placeholder={t('faq_a')}
                  rows={2}
                />
                <button
                  type="button"
                  onClick={() => set({ faqs: draft.faqs.filter((_, j) => j !== i) })}
                  className="text-xs text-danger hover:underline"
                >
                  {tCommon('remove')}
                </button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              onClick={() => set({ faqs: [...draft.faqs, { question: '', answer: '' }] })}
            >
              + {t('add_faq')}
            </Button>
          </div>
        )}

        {step === 'preview' && (
          <div className="space-y-4">
            <h3 className="font-display text-lg font-bold">{draft.title || t('untitled')}</h3>
            {priceValid && <PriceBlock display={previewDisplay} size="detail" />}
            {blocking && <p className="text-sm text-danger" role="alert">{blocking}</p>}
            <div>
              <p className="text-sm font-semibold">{t('scope_included')}</p>
              <ul className="mt-1 list-inside list-disc text-sm text-foreground-secondary">
                {draft.scopeIncluded.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
            {draft.scopeExcluded.length > 0 && (
              <div>
                <p className="text-sm font-semibold">{t('preview_not_included')}</p>
                <ul className="mt-1 list-inside list-disc text-sm text-foreground-secondary">
                  {draft.scopeExcluded.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            <div>
              <p className="text-sm font-semibold">{t('deliverables')}</p>
              <ul className="mt-1 list-inside list-disc text-sm text-foreground-secondary">
                {draft.deliverables.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
            <p className="text-sm text-foreground-secondary">
              {t('delivery_in', { days: Number(draft.deliveryDays || '0') })} ·{' '}
              {t('revisions_count', { count: Number(draft.revisionCount || '0') })}
            </p>
            <p className="text-xs text-foreground-secondary">
              {t('commission_note', { pct: commissionPct })}{' '}
              <span className="text-foreground-secondary/70">{t('commission_subject')}</span>
            </p>
          </div>
        )}

        {/* QA F27 — add-ons and the plan belong to Pricing, above the step buttons. They save on
            their own, so they stay mounted (hidden) on the other steps and keep what was saved. */}
        {pricingExtras && (
          <div className="mt-6 space-y-6" hidden={step !== 'pricing'}>
            {pricingExtras}
          </div>
        )}

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        {/* Nav */}
        <div className="mt-6 flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" onClick={back} disabled={stepIdx === 0}>
            {tCommon('back')}
          </Button>
          {step !== 'preview' ? (
            <Button
              type="button"
              onClick={next}
              disabled={step === 'pricing' && anyPricingShown}
              {...{ [LIST_COMMIT_ATTR]: '' }}
            >
              {tCommon('continue')}
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => submit('draft')} loading={loading} disabled={!!blocking}>
                {t('save_draft')}
              </Button>
              <Button type="button" onClick={() => submit('active')} loading={loading} disabled={!!blocking}>
                {mode === 'edit' ? t('update_publish') : t('publish')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
