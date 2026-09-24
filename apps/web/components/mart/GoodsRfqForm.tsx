'use client'

import { useCallback, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
import { useRouter } from '@/i18n/navigation'
import { PRODUCT_UNITS } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { VoiceDictation } from '@/components/mart/VoiceDictation'
import { SheetCard } from '@/components/mart/primitives'
import type { DeliveryDefaults } from '@/lib/mart/delivery-defaults'
import { IntakeDocumentButton } from '@/components/rfq/IntakeDocumentButton'
import type { IntakeResult } from '@amclub/shared'

export interface GoodsRfqCategoryOption { slug: string; name: string }
export interface GoodsRfqPrefill {
  productId: string | null
  item: string
  unit: string
  categorySlug: string
  productName: string | null
  /** E16 N42 "Customise" — the listing's typed attributes + specs as starting spec rows (the buyer edits them). */
  spec?: SpecRow[]
}

interface SpecRow { k: string; v: string }

/**
 * AMC Mart M2 — goods RFQ. Posts kind:'goods' to the same /api/v1/rfq the
 * services form uses; the server validates the Mart category and stores the
 * spec. No money arithmetic here: the target price is a paise integer the
 * buyer typed, sent as a signal.
 */
export function GoodsRfqForm({ categories, states, defaults, prefill, documentIntakeEnabled = false }: { categories: GoodsRfqCategoryOption[]; states: { value: string; label: string }[]; defaults: DeliveryDefaults | null; prefill: GoodsRfqPrefill | null; documentIntakeEnabled?: boolean }) {
  const t = useTranslations('rfq')
  const tm = useTranslations('mart')
  const locale = useLocale()
  const router = useRouter()
  const posthog = useAnalytics()

  const [categorySlug, setCategorySlug] = useState(prefill?.categorySlug ?? '')
  const [item, setItem] = useState(prefill?.item ?? '')
  const [qty, setQty] = useState('')
  const [unit, setUnit] = useState(prefill?.unit ?? 'pcs')
  const [rows, setRows] = useState<SpecRow[]>(prefill?.spec?.length ? prefill.spec : [{ k: '', v: '' }])
  const [brand, setBrand] = useState('')
  const [target, setTarget] = useState('')
  const [details, setDetails] = useState('')
  const [neededBy, setNeededBy] = useState('')
  const [form, setForm] = useState({
    contact_name: defaults?.contact_name ?? '', contact_phone: defaults?.contact_phone ?? '', address: defaults?.address ?? '',
    city: defaults?.city ?? '', state: defaults?.state || 'AP', pincode: defaults?.pincode ?? '', pickup: defaults?.pickup ?? false,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // S1.8 — document / drawing intake: attachments + the extraction ids the Create tap confirms.
  const [attachments, setAttachments] = useState<{ url: string; name: string }[]>([])
  const [intakeIds, setIntakeIds] = useState<string[]>([])
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))
  const track = useCallback((event: string, props?: Record<string, unknown>) => posthog.capture(event, { locale, device: 'web', ...props }), [posthog, locale])

  function onIntake(r: IntakeResult) {
    setAttachments((a) => (a.length < 5 ? [...a, r.attachment] : a))
    setIntakeIds((ids) => (ids.length < 4 ? [...ids, r.extraction_id] : ids))
    const incoming: SpecRow[] = r.kind === 'document' ? r.result.facts.map((f) => ({ k: f.k, v: f.v })) : r.result.spec_rows
    setRows((rs) => {
      const kept = rs.filter((x) => x.k.trim() || x.v.trim())
      const merged = [...kept]
      for (const row of incoming) if (merged.length < 12 && !merged.some((x) => x.k === row.k)) merged.push(row)
      return merged.length ? merged : [{ k: '', v: '' }]
    })
    if (r.kind === 'drawing' && r.result.product_name && !item.trim()) setItem(r.result.product_name.slice(0, 140))
    if (r.kind === 'document' && r.result.description_english) setDetails((d) => (d ? `${d}\n${r.result.description_english}` : r.result.description_english))
  }

  const onDictated = useCallback((text: string) => setDetails((d) => (d ? `${d}\n${text}` : text)), [])

  async function submit() {
    setError('')
    if (!categorySlug) { setError(t('goods_category_label') + ': ' + t('required_field')); return }
    if (item.trim().length < 3) { setError(t('goods_err_item')); return }
    const qtyNum = Number(qty)
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) { setError(t('goods_err_qty')); return }
    const spec = rows.map((r) => ({ k: r.k.trim(), v: r.v.trim() })).filter((r) => r.k || r.v)
    if (spec.some((r) => !r.k || !r.v)) { setError(t('goods_err_spec')); return }
    if (!form.contact_name.trim() || !form.contact_phone.trim() || !form.city.trim() || !form.pincode.trim() || (!form.pickup && form.address.trim().length < 5)) { setError(t('goods_err_delivery')); return }
    const targetPaise = target.trim() ? Math.round(Number(target) * 100) : undefined
    setLoading(true)
    try {
      const title = `${item.trim()} × ${qtyNum} ${unit}`.slice(0, 200)
      const res = await fetch('/api/v1/rfq', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'goods',
          mart_category_slug: categorySlug,
          title: title.length >= 10 ? title : `${title} (goods request)`,
          details: details.trim() ? { additional_details: details.trim() } : {},
          attachments,
          ...(intakeIds.length ? { intake_extraction_ids: intakeIds } : {}),
          ...(neededBy ? { needed_by: neededBy } : {}),
          goods_spec: {
            item: item.trim(), qty: qtyNum, unit, spec,
            ...(brand.trim() ? { brand_preference: brand.trim() } : {}),
            ...(targetPaise && targetPaise > 0 ? { target_unit_price_paise: targetPaise } : {}),
            delivery: { ...form, address: form.pickup && form.address.trim().length < 5 ? `${tm('pickup')} — ${form.city}` : form.address.trim() },
            ...(prefill?.productId ? { product_id: prefill.productId } : {}),
          },
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 403 && d.error === 'profile_incomplete') { router.push('/app/profile'); return }
      if (!res.ok) throw new Error(t('goods_err_create'))
      posthog.capture('mart_goods_rfq_created', { locale, device: 'web', category: categorySlug, qty: qtyNum, unit, spec_lines: spec.length, from_product: !!prefill?.productId, has_target: !!targetPaise })
      router.push(`/app/rfq/${d.rfqId}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('goods_err_create'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {prefill?.productName && <p className="text-xs text-foreground-secondary">{t('goods_from_listing', { name: prefill.productName })}</p>}

      <SheetCard className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-cat">{t('goods_category_label')}</Label>
          <Select id="g-cat" value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} placeholder="—">
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-item">{t('goods_item_label')}</Label>
          <Input id="g-item" value={item} onChange={(e) => setItem(e.target.value)} placeholder={t('goods_item_placeholder')} maxLength={140} />
        </div>
        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="g-qty">{t('goods_qty_label')}</Label>
            <Input id="g-qty" type="number" inputMode="numeric" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="g-unit">{t('goods_unit_label')}</Label>
            <Select id="g-unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {PRODUCT_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>{t('goods_spec_label')}</Label>
          <p className="text-xs text-foreground-secondary">{t('goods_spec_hint')}</p>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2">
                <Input aria-label={t('goods_spec_key_placeholder')} value={r.k} maxLength={40} placeholder={t('goods_spec_key_placeholder')} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                <Input aria-label={t('goods_spec_value_placeholder')} value={r.v} maxLength={200} placeholder={t('goods_spec_value_placeholder')} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                <button type="button" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [{ k: '', v: '' }]))} className="min-h-11 rounded-button px-2 text-xs text-foreground-secondary hover:bg-emerald/10" aria-label={t('goods_spec_remove')}>✕</button>
              </div>
            ))}
          </div>
          {rows.length < 12 && (
            <button type="button" onClick={() => setRows((rs) => [...rs, { k: '', v: '' }])} className="self-start text-meta font-medium text-emerald underline underline-offset-2">+ {t('goods_spec_add')}</button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="g-brand">{t('goods_brand_label')}</Label>
            <Input id="g-brand" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="g-target">{t('goods_target_label')}</Label>
            <Input id="g-target" type="number" inputMode="decimal" min={0} value={target} onChange={(e) => setTarget(e.target.value)} />
            <p className="text-xs text-foreground-secondary">{t('goods_target_hint')}</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-needed">{t('needed_by_label')}</Label>
          <Input id="g-needed" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-details">{t('goods_details_label')}</Label>
          <Textarea id="g-details" value={details} onChange={(e) => setDetails(e.target.value)} rows={3} />
          <div className="flex flex-wrap items-start gap-3">
            <VoiceDictation onText={onDictated} />
            <IntakeDocumentButton mode="goods" enabled={documentIntakeEnabled} track={track} onResult={onIntake} onAttachmentOnly={(a) => setAttachments((x) => (x.length < 5 ? [...x, a] : x))} compact />
          </div>
          {attachments.length > 0 && (
            <ul className="mt-1 space-y-1 text-xs text-foreground-secondary" aria-label={t('intake_attachments_title')}>
              {attachments.map((a) => (
                <li key={a.url} className="flex items-center justify-between gap-2">
                  <span className="truncate">{a.name}</span>
                  <button type="button" onClick={() => setAttachments((x) => x.filter((y) => y.url !== a.url))} className="min-h-8 px-2 underline underline-offset-2">{t('intake_remove')}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetCard>

      <SheetCard className="space-y-3">
        <h2 className="text-meta font-semibold text-emerald-ink">{tm('delivery_title')}</h2>
        <p className="text-xs text-foreground-secondary">{defaults ? tm('address_prefilled') : t('goods_delivery_note')}</p>
        <div><Label htmlFor="cn">{tm('contact_name')}</Label><Input id="cn" value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></div>
        <div><Label htmlFor="cp">{tm('contact_phone')}</Label><Input id="cp" inputMode="tel" value={form.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} /></div>
        <div><Label htmlFor="ad">{tm('address')}</Label><Input id="ad" value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="ci">{tm('city')}</Label><Input id="ci" value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
          <div><Label htmlFor="pc">{tm('pincode')}</Label><Input id="pc" inputMode="numeric" value={form.pincode} onChange={(e) => set('pincode', e.target.value)} /></div>
        </div>
        <div>
          <Label htmlFor="st">{tm('state')}</Label>
          <Select id="st" value={form.state} onChange={(e) => set('state', e.target.value)}>
            {states.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </div>
        <label className="flex items-start gap-2 text-meta text-emerald-ink">
          <input type="checkbox" checked={form.pickup} onChange={(e) => set('pickup', e.target.checked)} className="mt-0.5 h-6 w-6 shrink-0 accent-emerald" />
          <span>{tm('pickup')}<span className="block text-xs text-foreground-secondary">{tm('pickup_hint')}</span></span>
        </label>
      </SheetCard>

      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button onClick={submit} loading={loading} className="w-full">{loading ? t('goods_submitting') : t('goods_submit')}</Button>
    </div>
  )
}
