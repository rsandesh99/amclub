'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter, Link } from '@/i18n/navigation'
import { pickLocale, PRODUCT_UNITS, GST_RATE_BPS_OPTIONS, HSN_CODE_RE, type CatalogDraft } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { SheetCard, GoldStamp, LatheSpinner } from './primitives'

export interface ListingDraft {
  name: string
  description: string
  categorySlug: string
  hsnCode: string
  gstRateBps: string
  unit: string
  minOrderQty: string
  countryOfOrigin: string
  images: { key: string; url: string }[]
  tiers: { minQty: string; rupees: string }[]
}

const EMPTY: ListingDraft = {
  name: '', description: '', categorySlug: '', hsnCode: '', gstRateBps: '', unit: 'pcs', minOrderQty: '1', countryOfOrigin: 'IN',
  images: [], tiers: [{ minQty: '1', rupees: '' }],
}

const STEPS = ['capture', 'confirm', 'pricing', 'review'] as const
type Step = (typeof STEPS)[number]
type ConfirmField = 'name' | 'description' | 'categorySlug' | 'hsnCode' | 'gstRateBps' | 'unit'
const CONFIRM_FIELDS: ConfirmField[] = ['name', 'description', 'categorySlug', 'hsnCode', 'gstRateBps', 'unit']
const PROPOSED_KEY: Record<ConfirmField, keyof CatalogDraft> = {
  name: 'name', description: 'description', categorySlug: 'category_slug', hsnCode: 'hsn_code', gstRateBps: 'gst_rate_bps', unit: 'unit',
}

type Category = { slug: string; nameI18n: { en: string; hi?: string; te?: string }; bisBlocked: boolean }

/**
 * Catalog manager (FRONTEND.md §7 / MART_DESIGN.md §5 Catalog Agent):
 * photos + description → agent DRAFT → per-field CONFIRM (every AI-touched
 * field must be explicitly confirmed; the proposed/final pair feeds
 * ai_decisions on save) → tiers → review → "sent for approval" stamp.
 */
export function CatalogWizard({
  mode, productId, categories, locale, initial,
}: {
  mode: 'create' | 'edit'
  productId?: string
  categories: Category[]
  locale: string
  initial?: Partial<ListingDraft>
}) {
  const t = useTranslations('mart')
  const router = useRouter()
  const [draft, setDraft] = useState<ListingDraft>({ ...EMPTY, ...initial })
  const [stepIdx, setStepIdx] = useState(mode === 'edit' ? 1 : 0)
  const [proposed, setProposed] = useState<CatalogDraft | null>(null)
  const [inputRefs, setInputRefs] = useState<Record<string, unknown> | null>(null)
  const [stub, setStub] = useState(false)
  const [confirmed, setConfirmed] = useState<Set<ConfirmField>>(new Set(mode === 'edit' ? CONFIRM_FIELDS : []))
  const [busy, setBusy] = useState<'draft' | 'upload' | 'save' | 'submit' | null>(null)
  const [error, setError] = useState('')
  const [savedId, setSavedId] = useState<string | null>(productId ?? null)
  const [done, setDone] = useState<'draft' | 'submitted' | null>(null)
  const step: Step = STEPS[stepIdx]!
  const set = (patch: Partial<ListingDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const catName = (slug: string) => { const c = categories.find((x) => x.slug === slug); return c ? pickLocale(c.nameI18n, locale) : slug }
  const gstLabel = (bps: number) => `${bps / 100}%`

  async function uploadImage(file: File) {
    setBusy('upload'); setError('')
    try {
      const fd = new FormData(); fd.append('file', file)
      const res = await fetch('/api/v1/mart/seller/images', { method: 'POST', body: fd })
      const d = await res.json()
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('upload_failed'))
      setDraft((cur) => ({ ...cur, images: [...cur.images, { key: d.key, url: d.url }].slice(0, 6) }))
    } catch (e) { setError(e instanceof Error ? e.message : t('upload_failed')) } finally { setBusy(null) }
  }

  async function runAgent() {
    setBusy('draft'); setError('')
    try {
      const res = await fetch('/api/v1/mart/seller/products/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: draft.description, imageKeys: draft.images.map((i) => i.key) }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(t('error_generic'))
      const p = d.draft as CatalogDraft
      setProposed(p); setInputRefs(d.inputRefs ?? null); setStub(!!d.stub)
      set({
        name: p.name ?? draft.name,
        description: p.description ?? draft.description,
        categorySlug: p.category_slug ?? draft.categorySlug,
        hsnCode: p.hsn_code ?? draft.hsnCode,
        gstRateBps: p.gst_rate_bps != null ? String(p.gst_rate_bps) : draft.gstRateBps,
        unit: p.unit ?? draft.unit,
        ...(p.tiers ? { tiers: p.tiers.map((x) => ({ minQty: String(x.min_qty), rupees: (x.unit_price_paise / 100).toString() })) } : {}),
      })
      setConfirmed(new Set())
      setStepIdx(1)
    } catch (e) { setError(e instanceof Error ? e.message : t('error_generic')) } finally { setBusy(null) }
  }

  function validate(s: Step): string | null {
    if (s === 'confirm') {
      if (draft.name.trim().length < 3) return t('err_name')
      if (!draft.categorySlug) return t('err_category')
      if (!HSN_CODE_RE.test(draft.hsnCode)) return t('err_hsn')
      if (!draft.gstRateBps) return t('err_gst')
      if (CONFIRM_FIELDS.some((f) => !confirmed.has(f))) return t('confirm_field')
    }
    if (s === 'pricing') {
      const tiers = draft.tiers.map((x) => ({ min_qty: Number(x.minQty), unit_price_paise: Math.round(Number(x.rupees) * 100) }))
      if (tiers.some((x) => !Number.isInteger(x.min_qty) || x.min_qty <= 0 || !Number.isFinite(x.unit_price_paise) || x.unit_price_paise <= 0)) return t('err_price')
      if (tiers[0]?.min_qty !== 1) return t('err_tiers')
      for (let i = 1; i < tiers.length; i++) {
        if (tiers[i]!.min_qty <= tiers[i - 1]!.min_qty || tiers[i]!.unit_price_paise >= tiers[i - 1]!.unit_price_paise) return t('err_tiers')
      }
    }
    return null
  }

  function body() {
    return {
      category_slug: draft.categorySlug,
      name: draft.name.trim(),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      hsn_code: draft.hsnCode.trim(),
      gst_rate_bps: Number(draft.gstRateBps),
      unit: draft.unit,
      images: draft.images.map((i) => i.key),
      min_order_qty: Math.max(1, Math.floor(Number(draft.minOrderQty) || 1)),
      country_of_origin: draft.countryOfOrigin || 'IN',
      tiers: draft.tiers.map((x) => ({ min_qty: Number(x.minQty), unit_price_paise: Math.round(Number(x.rupees) * 100) })),
    }
  }

  async function save(): Promise<string | null> {
    setBusy('save'); setError('')
    try {
      const payload = { ...body(), ...(proposed && !savedId ? { ai: { input_refs: inputRefs ?? {}, proposed } } : {}) }
      const res = await fetch(savedId ? `/api/v1/mart/seller/products/${savedId}` : '/api/v1/mart/seller/products', {
        method: savedId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('error_generic'))
      const id = (d.id as string | undefined) ?? savedId
      setSavedId(id)
      return id
    } catch (e) { setError(e instanceof Error ? e.message : t('error_generic')); return null } finally { setBusy(null) }
  }

  async function saveAndSubmit() {
    const id = await save()
    if (!id) return
    setBusy('submit'); setError('')
    try {
      const res = await fetch(`/api/v1/mart/seller/products/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'submit' }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDone('draft')
        setError(d.error === 'activation_required' ? t('activation_required') : t('error_generic'))
        return
      }
      setDone('submitted')
    } finally { setBusy(null) }
  }

  function toggleConfirm(field: ConfirmField) {
    setConfirmed((s) => { const n = new Set(s); if (n.has(field)) n.delete(field); else n.add(field); return n })
  }

  function fieldRow(field: ConfirmField, label: string, control: ReactNode) {
    const sug = proposed ? proposed[PROPOSED_KEY[field]] : null
    const isConfirmed = confirmed.has(field)
    const sugText = sug == null || sug === '' ? null : field === 'gstRateBps' ? gstLabel(Number(sug)) : field === 'categorySlug' ? catName(String(sug)) : String(sug)
    return (
      <div className={`rounded-[8px] border p-3 ${isConfirmed ? 'border-brass/60' : 'border-border'}`}>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`f-${field}`}>{label}</Label>
          <button
            type="button"
            aria-pressed={isConfirmed}
            onClick={() => toggleConfirm(field)}
            className={`inline-flex h-9 items-center gap-1 rounded-chip px-3 text-xs font-semibold ${isConfirmed ? 'bg-gold-metal text-emerald-ink' : 'border border-emerald text-emerald'}`}
          >
            {isConfirmed ? '✓ ' + t('confirmed') : t('confirm_field')}
          </button>
        </div>
        {sugText && <p className="mt-1 text-xs text-foreground-secondary">{t('suggested')}: <span className="text-emerald-ink">{sugText}</span></p>}
        <div className="mt-2">{control}</div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="mart-enter mx-auto max-w-lg px-4 py-16 text-center">
        <div className="jaali-ivory rounded-[10px] border border-brass/50 px-6 py-12">
          <GoldStamp className="mx-auto h-16 w-16 text-2xl">✓</GoldStamp>
          <h1 className="mt-4 font-display text-2xl font-bold text-emerald-ink">{done === 'submitted' ? t('sent_for_approval') : t('save_draft')}</h1>
          <p className="mt-2 text-sm text-foreground-secondary">{done === 'submitted' ? t('sent_stamp_body') : error}</p>
          <Link href={'/partner/goods' as '/partner'}><Button className="mt-6 bg-emerald hover:bg-emerald-ink">{t('seller_title')}</Button></Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mart-enter mx-auto max-w-2xl space-y-5 px-4 py-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-emerald-ink">{mode === 'create' ? t('wizard_title_new') : t('wizard_title_edit')}</h1>
        <div className="mt-3"><Progress value={((stepIdx + 1) / STEPS.length) * 100} label={t(`step_${step}` as 'step_capture')} /></div>
      </div>

      {step === 'capture' && (
        <SheetCard className="space-y-4">
          <div>
            <Label>{t('photos')}</Label>
            <p className="text-xs text-foreground-secondary">{t('photo_hint')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {draft.images.map((img) => (
                <div key={img.key} className="relative h-20 w-20 overflow-hidden rounded-[8px] border border-brass/40">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt="" className="h-full w-full object-cover" />
                  <button type="button" aria-label={t('remove')} onClick={() => set({ images: draft.images.filter((i) => i.key !== img.key) })} className="absolute right-0 top-0 h-6 w-6 rounded-bl bg-ivory/90 text-xs text-stamp">×</button>
                </div>
              ))}
              {draft.images.length < 6 && (
                <label className="flex h-20 w-20 cursor-pointer items-center justify-center rounded-[8px] border border-dashed border-brass/60 text-xs text-emerald">
                  {busy === 'upload' ? <LatheSpinner /> : t('add_photo')}
                  <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = '' }} />
                </label>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="desc">{t('description')}</Label>
            <p className="text-xs text-foreground-secondary">{t('description_hint')}</p>
            <Textarea id="desc" className="mt-2" value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={4} />
          </div>
          {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={runAgent} loading={busy === 'draft'} disabled={!draft.description.trim() && draft.images.length === 0} className="bg-emerald hover:bg-emerald-ink">
              {busy === 'draft' ? t('drafting') : t('draft_cta')}
            </Button>
            <Button variant="outline" onClick={() => setStepIdx(1)}>{t('skip_draft')}</Button>
          </div>
        </SheetCard>
      )}

      {step === 'confirm' && (
        <SheetCard className="space-y-3">
          {proposed && <p className="text-sm font-medium text-emerald-ink">{t('draft_ready')}</p>}
          {proposed?.uncertain && <p className="rounded-button bg-warning/10 px-3 py-2 text-xs text-warning">{t('draft_uncertain')}</p>}
          {stub && <p className="text-xs text-foreground-secondary">{t('draft_stub_note')}</p>}
          {fieldRow('name', t('field_name'), <Input id="f-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />)}
          {fieldRow('description', t('field_description'), <Textarea id="f-description" value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={3} />)}
          {fieldRow('categorySlug', t('field_category'),
            <Select id="f-categorySlug" value={draft.categorySlug} onChange={(e) => set({ categorySlug: e.target.value })} placeholder={t('select_category')}>
              {categories.map((c) => <option key={c.slug} value={c.slug} disabled={c.bisBlocked}>{pickLocale(c.nameI18n, locale)}{c.bisBlocked ? ` — ${t('blocked_category')}` : ''}</option>)}
            </Select>)}
          {fieldRow('hsnCode', t('field_hsn'), <Input id="f-hsnCode" inputMode="numeric" value={draft.hsnCode} onChange={(e) => set({ hsnCode: e.target.value.replace(/\D/g, '').slice(0, 8) })} />)}
          {fieldRow('gstRateBps', t('field_gst'),
            <Select id="f-gstRateBps" value={draft.gstRateBps} onChange={(e) => set({ gstRateBps: e.target.value })} placeholder={t('select_gst')}>
              {GST_RATE_BPS_OPTIONS.map((b) => <option key={b} value={String(b)}>{gstLabel(b)}</option>)}
            </Select>)}
          {fieldRow('unit', t('field_unit'),
            <Select id="f-unit" value={draft.unit} onChange={(e) => set({ unit: e.target.value })} placeholder={t('select_unit')}>
              {PRODUCT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </Select>)}
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="moq">{t('field_min_order')}</Label><Input id="moq" inputMode="numeric" value={draft.minOrderQty} onChange={(e) => set({ minOrderQty: e.target.value })} /></div>
            <div><Label htmlFor="coo">{t('field_country')}</Label><Input id="coo" maxLength={2} value={draft.countryOfOrigin} onChange={(e) => set({ countryOfOrigin: e.target.value.toUpperCase() })} /></div>
          </div>
          {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStepIdx(0)}>{t('back')}</Button>
            <Button className="bg-emerald hover:bg-emerald-ink" onClick={() => { const e = validate('confirm'); if (e) { setError(e); return } setError(''); setStepIdx(2) }}>{t('next')}</Button>
          </div>
        </SheetCard>
      )}

      {step === 'pricing' && (
        <SheetCard className="space-y-3">
          <h2 className="text-sm font-semibold text-emerald-ink">{t('tiers_title')}</h2>
          <p className="text-xs text-foreground-secondary">{t('tiers_hint')}</p>
          {draft.tiers.map((tier, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <div><Label htmlFor={`tq-${i}`}>{t('tier_min_qty')}</Label><Input id={`tq-${i}`} inputMode="numeric" value={tier.minQty} disabled={i === 0} onChange={(e) => set({ tiers: draft.tiers.map((x, j) => (j === i ? { ...x, minQty: e.target.value } : x)) })} /></div>
              <div><Label htmlFor={`tp-${i}`}>{t('tier_unit_price_rupees')}</Label><Input id={`tp-${i}`} inputMode="decimal" value={tier.rupees} onChange={(e) => set({ tiers: draft.tiers.map((x, j) => (j === i ? { ...x, rupees: e.target.value } : x)) })} /></div>
              <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => set({ tiers: draft.tiers.filter((_, j) => j !== i) })}>{t('remove_tier')}</Button>
            </div>
          ))}
          {draft.tiers.length < 8 && <Button variant="outline" size="sm" onClick={() => set({ tiers: [...draft.tiers, { minQty: '', rupees: '' }] })}>{t('add_tier')}</Button>}
          {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStepIdx(1)}>{t('back')}</Button>
            <Button className="bg-emerald hover:bg-emerald-ink" onClick={() => { const e = validate('pricing'); if (e) { setError(e); return } setError(''); setStepIdx(3) }}>{t('next')}</Button>
          </div>
        </SheetCard>
      )}

      {step === 'review' && (
        <SheetCard className="space-y-3">
          <h2 className="font-display text-xl font-bold text-emerald-ink">{draft.name}</h2>
          <p className="text-sm text-emerald-ink">{draft.description}</p>
          <dl className="grid grid-cols-2 gap-2 text-xs text-foreground-secondary">
            <div><dt>{t('field_category')}</dt><dd className="text-emerald-ink">{catName(draft.categorySlug)}</dd></div>
            <div><dt>{t('field_hsn')}</dt><dd className="text-emerald-ink">{draft.hsnCode}</dd></div>
            <div><dt>{t('field_gst')}</dt><dd className="text-emerald-ink">{gstLabel(Number(draft.gstRateBps))}</dd></div>
            <div><dt>{t('field_unit')}</dt><dd className="text-emerald-ink">{draft.unit}</dd></div>
          </dl>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-foreground-secondary"><th className="py-1 font-medium">{t('tier_qty')}</th><th className="py-1 font-medium">{t('tier_unit_price_rupees')}</th></tr></thead>
            <tbody>{draft.tiers.map((x, i) => <tr key={i} className="border-t border-brass/20"><td className="py-1 tabular-nums">{x.minQty}+</td><td className="py-1 font-semibold tabular-nums text-ink">₹{x.rupees}</td></tr>)}</tbody>
          </table>
          {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" onClick={() => setStepIdx(2)}>{t('back')}</Button>
            <div className="flex gap-2">
              <Button variant="outline" loading={busy === 'save'} onClick={async () => { const id = await save(); if (id) router.push('/partner/goods' as '/partner') }}>{t('save_draft')}</Button>
              <Button className="bg-gold-metal text-emerald-ink" loading={busy === 'submit' || busy === 'save'} onClick={saveAndSubmit}>{t('submit_for_approval')}</Button>
            </div>
          </div>
        </SheetCard>
      )}
    </div>
  )
}
