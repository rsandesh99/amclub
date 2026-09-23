'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { CATEGORY_LIST } from '@amclub/shared'
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
}

const EMPTY: PackageDraft = {
  categorySlug: '', title: '', scopeIncluded: [], scopeExcluded: [],
  deliverables: [], requirements: [], priceRupees: '', discountPct: '0',
  memberPct: '0', deliveryDays: '7', revisionCount: '1', faqs: [],
}

const STEPS = ['basics', 'scope', 'deliverables', 'pricing', 'faqs', 'preview'] as const
type Step = (typeof STEPS)[number]

export function PackageWizard({
  mode,
  initial,
  allowedCategorySlugs,
}: {
  mode: 'create' | 'edit'
  initial?: Partial<PackageDraft>
  allowedCategorySlugs: string[]
}) {
  const t = useTranslations('listings')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [draft, setDraft] = useState<PackageDraft>({ ...EMPTY, ...initial })
  const [stepIdx, setStepIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
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
  }

  function commitPendingLists(): PackageDraft {
    const patch: Partial<PackageDraft> = {}
    if (scopeInRef.current) patch.scopeIncluded = scopeInRef.current.commit()
    if (scopeOutRef.current) patch.scopeExcluded = scopeOutRef.current.commit()
    if (deliverablesRef.current) patch.deliverables = deliverablesRef.current.commit()
    if (requirementsRef.current) patch.requirements = requirementsRef.current.commit()
    return { ...draft, ...patch }
  }

  function validateStep(d: PackageDraft = draft): string | null {
    const draft = d
    if (step === 'basics') {
      if (!draft.categorySlug) return t('err_category')
      if (draft.title.trim().length < 5) return t('err_title')
    }
    if (step === 'scope' && draft.scopeIncluded.length === 0) return t('err_scope')
    if (step === 'deliverables' && draft.deliverables.length === 0) return t('err_deliverables')
    if (step === 'pricing') {
      const price = Number(draft.priceRupees)
      if (!Number.isFinite(price) || price <= 0) return t('err_price')
      if (!Number.isFinite(Number(draft.deliveryDays)) || Number(draft.deliveryDays) <= 0)
        return t('err_delivery')
    }
    return null
  }

  function next() {
    const err = validateStep(commitPendingLists())
    if (err) {
      setError(err)
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
    }
  }

  async function submit(status: 'draft' | 'active') {
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
                onChange={(e) => set({ categorySlug: e.target.value })}
              >
                <option value="">{t('select_category')}</option>
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name_i18n.en}
                  </option>
                ))}
              </Select>
            </div>
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
                  value={draft.priceRupees}
                  onChange={(e) => set({ priceRupees: e.target.value })}
                  placeholder="4999"
                />
              </div>
              <div>
                <Label htmlFor="discount">{t('discount_label')}</Label>
                <Input
                  id="discount"
                  type="number"
                  inputMode="numeric"
                  value={draft.discountPct}
                  onChange={(e) => set({ discountPct: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="member">{t('member_label')}</Label>
                <Input
                  id="member"
                  type="number"
                  inputMode="numeric"
                  value={draft.memberPct}
                  onChange={(e) => set({ memberPct: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="delivery">{t('delivery_label')}</Label>
                <Input
                  id="delivery"
                  type="number"
                  inputMode="numeric"
                  value={draft.deliveryDays}
                  onChange={(e) => set({ deliveryDays: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="rev">{t('revisions_label')}</Label>
                <Input
                  id="rev"
                  type="number"
                  inputMode="numeric"
                  value={draft.revisionCount}
                  onChange={(e) => set({ revisionCount: e.target.value })}
                />
              </div>
            </div>
            <p className="text-sm text-foreground-secondary">
              {t('commission_note', { pct: commissionPct })}{' '}
              <span className="text-xs text-foreground-secondary/70">{t('commission_subject')}</span>
            </p>
            {priceP > 0 && (
              <div className="rounded-button border border-border bg-background p-3">
                <p className="mb-1 text-xs text-foreground-secondary">{t('preview_price')}</p>
                <PriceBlock
                  pricePaise={priceP}
                  discountBps={discountB}
                  memberExtraDiscountBps={memberB}
                  size="detail"
                />
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
            <PriceBlock pricePaise={priceP} discountBps={discountB} memberExtraDiscountBps={memberB} size="detail" />
            <div>
              <p className="text-sm font-semibold">{t('scope_included')}</p>
              <ul className="mt-1 list-inside list-disc text-sm text-foreground-secondary">
                {draft.scopeIncluded.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
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

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        {/* Nav */}
        <div className="mt-6 flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" onClick={back} disabled={stepIdx === 0}>
            {tCommon('back')}
          </Button>
          {step !== 'preview' ? (
            <Button type="button" onClick={next} {...{ [LIST_COMMIT_ATTR]: '' }}>
              {tCommon('continue')}
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => submit('draft')} loading={loading}>
                {t('save_draft')}
              </Button>
              <Button type="button" onClick={() => submit('active')} loading={loading}>
                {mode === 'edit' ? t('update_publish') : t('publish')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
