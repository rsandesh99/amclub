'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { pickLocale, MART_SETTING_DEFS, POOL_PAYMENT_MODES, RETURN_FREIGHT_PAYERS, type MartSettingKey } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'

interface SettingRow { key: MartSettingKey; value: unknown; set: boolean; updated_at: string | null; decision: string; hint: string }
interface CategoryRow {
  slug: string
  name_i18n: { en: string; hi?: string; te?: string }
  return_window_hours: number
  commission_bps: number
  return_freight_payer: 'seller' | 'buyer' | 'split'
  bis_blocked: boolean
  is_active: boolean
  sort_order: number | null
  active_listings: number
}

const fmtIST = (v: string | null) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—')

/** Which keys edit as a plain number / enum; everything else edits as JSON. */
const NUMBER_KEYS: MartSettingKey[] = ['eway_bill_threshold_paise', 'auto_approve_after_listings', 'goods_delivery_days', 'pool_pay_window_hours', 'pool_schedule_day_of_month']
const ENUM_KEYS: Partial<Record<MartSettingKey, readonly string[]>> = { pool_payment_mode: POOL_PAYMENT_MODES, pool_order_model: ['per_member'] }

/**
 * Founder decisions (§9) as config, edited here and never in code. One PUT per
 * key; every write is audited. No motion, Linear-fast, like the rest of admin.
 */
export function MartSettingsClient() {
  const t = useTranslations('admin_mart')
  const locale = useLocale()
  const { toast } = useToast()
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [categories, setCategories] = useState<CategoryRow[]>([])
  const [catDrafts, setCatDrafts] = useState<Record<string, Partial<CategoryRow>>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const [s, c] = await Promise.all([
      fetch('/api/v1/mart/admin/settings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { settings: [] })),
      fetch('/api/v1/mart/admin/categories', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { categories: [] })),
    ])
    setSettings(s.settings ?? [])
    setDrafts(Object.fromEntries((s.settings ?? []).map((row: SettingRow) => [row.key, toText(row.key, row.value)])))
    setCategories(c.categories ?? [])
    setCatDrafts({})
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  async function saveSetting(key: MartSettingKey) {
    setBusy(key)
    setErrors((e) => ({ ...e, [key]: '' }))
    let value: unknown
    try { value = fromText(key, drafts[key] ?? '') } catch { setErrors((e) => ({ ...e, [key]: t('settings_invalid_json') })); setBusy(null); return }
    const res = await fetch('/api/v1/mart/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) })
    const d = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setErrors((e) => ({ ...e, [key]: typeof d.detail === 'string' ? d.detail : t('action_failed') })); return }
    toast(t('settings_saved', { key }))
    void load()
  }

  async function saveCategory(slug: string) {
    const patch = catDrafts[slug]
    if (!patch || Object.keys(patch).length === 0) return
    setBusy(slug)
    setErrors((e) => ({ ...e, [slug]: '' }))
    const res = await fetch(`/api/v1/mart/admin/categories/${slug}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    const d = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setErrors((e) => ({ ...e, [slug]: typeof d.error === 'string' ? d.error : t('action_failed') })); return }
    toast(t('category_saved', { slug }))
    void load()
  }

  const setCat = (slug: string, patch: Partial<CategoryRow>) => setCatDrafts((d) => ({ ...d, [slug]: { ...(d[slug] ?? {}), ...patch } }))
  const catVal = <K extends keyof CategoryRow>(c: CategoryRow, k: K): CategoryRow[K] => (catDrafts[c.slug]?.[k] as CategoryRow[K] | undefined) ?? c[k]

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">{t('settings_title')}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">{t('settings_subtitle')}</p>
        </div>
        <Link href={'/admin/mart' as '/admin'} className="text-sm font-medium text-primary underline underline-offset-2">{t('back')}</Link>
      </div>

      {loading ? <p className="text-sm text-foreground-secondary">{t('loading')}</p> : (
        <>
          {/* §9.2 / §9.3 per category */}
          <section className="rounded-card border border-border bg-surface shadow-card">
            <div className="border-b border-border p-4">
              <h2 className="text-sm font-semibold">{t('categories_title')}</h2>
              <p className="mt-1 text-xs text-foreground-secondary">{t('categories_subtitle')}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-foreground-secondary">
                    <th className="px-4 py-2 font-medium">{t('category')}</th>
                    <th className="px-2 py-2 font-medium">{t('col_return_window')}</th>
                    <th className="px-2 py-2 font-medium">{t('col_commission')}</th>
                    <th className="px-2 py-2 font-medium">{t('col_freight')}</th>
                    <th className="px-2 py-2 font-medium">{t('col_bis')}</th>
                    <th className="px-2 py-2 font-medium">{t('col_active')}</th>
                    <th className="px-2 py-2 font-medium">{t('col_sort')}</th>
                    <th className="px-2 py-2 font-medium">{t('col_listings')}</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {categories.map((c) => (
                    <tr key={c.slug} className="border-t border-border align-middle">
                      <td className="px-4 py-2">
                        <p className="font-medium">{pickLocale(c.name_i18n, locale)}</p>
                        <p className="text-xs text-foreground-secondary">{c.slug}</p>
                      </td>
                      <td className="px-2 py-2"><Input aria-label={t('col_return_window')} type="number" min={0} max={720} className="w-20" value={String(catVal(c, 'return_window_hours'))} onChange={(e) => setCat(c.slug, { return_window_hours: Number(e.target.value) })} /></td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1">
                          <Input aria-label={t('col_commission')} type="number" min={0} max={5000} className="w-20" value={String(catVal(c, 'commission_bps'))} onChange={(e) => setCat(c.slug, { commission_bps: Number(e.target.value) })} />
                          <span className="text-xs text-foreground-secondary tabular-nums">= {(catVal(c, 'commission_bps') / 100).toFixed(2)}%</span>
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <select aria-label={t('col_freight')} value={catVal(c, 'return_freight_payer')} onChange={(e) => setCat(c.slug, { return_freight_payer: e.target.value as CategoryRow['return_freight_payer'] })} className="h-9 rounded-button border border-border bg-surface px-2 text-sm">
                          {RETURN_FREIGHT_PAYERS.map((p) => <option key={p} value={p}>{t(`freight_${p}`)}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-2"><input aria-label={t('col_bis')} type="checkbox" checked={catVal(c, 'bis_blocked')} onChange={(e) => setCat(c.slug, { bis_blocked: e.target.checked })} className="h-5 w-5 accent-primary" /></td>
                      <td className="px-2 py-2"><input aria-label={t('col_active')} type="checkbox" checked={catVal(c, 'is_active')} onChange={(e) => setCat(c.slug, { is_active: e.target.checked })} className="h-5 w-5 accent-primary" /></td>
                      <td className="px-2 py-2"><Input aria-label={t('col_sort')} type="number" min={0} className="w-16" value={catVal(c, 'sort_order') == null ? '' : String(catVal(c, 'sort_order'))} onChange={(e) => setCat(c.slug, { sort_order: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                      <td className="px-2 py-2 tabular-nums text-foreground-secondary">{c.active_listings}</td>
                      <td className="px-4 py-2 text-right">
                        <Button size="sm" variant={catDrafts[c.slug] ? 'primary' : 'outline'} disabled={!catDrafts[c.slug]} loading={busy === c.slug} onClick={() => saveCategory(c.slug)}>{t('save')}</Button>
                        {errors[c.slug] && <p className="mt-1 text-xs text-danger">{errors[c.slug]}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-border px-4 py-3 text-xs text-foreground-secondary">{t('categories_note')}</p>
          </section>

          {/* Registry keys */}
          <section className="rounded-card border border-border bg-surface shadow-card">
            <div className="border-b border-border p-4">
              <h2 className="text-sm font-semibold">{t('keys_title')}</h2>
              <p className="mt-1 text-xs text-foreground-secondary">{t('keys_subtitle')}</p>
            </div>
            <ul className="divide-y divide-border">
              {settings.map((s) => {
                const def = MART_SETTING_DEFS[s.key]
                const enumOpts = ENUM_KEYS[s.key]
                const isNumber = NUMBER_KEYS.includes(s.key)
                return (
                  <li key={s.key} className="grid gap-3 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]">
                    <div>
                      <p className="font-mono text-sm font-semibold">{s.key}</p>
                      <p className="mt-0.5 text-xs text-primary">{def.decision}</p>
                      <p className="mt-1 text-xs text-foreground-secondary">{s.hint}</p>
                      <p className="mt-1 text-[11px] text-foreground-secondary">{s.set ? t('updated_at', { date: fmtIST(s.updated_at) }) : t('not_set')}</p>
                    </div>
                    <div>
                      {enumOpts ? (
                        <select aria-label={s.key} value={drafts[s.key] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} className="h-10 w-full rounded-button border border-border bg-surface px-3 text-sm">
                          {enumOpts.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : isNumber ? (
                        <Input aria-label={s.key} type="number" inputMode="numeric" value={drafts[s.key] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} />
                      ) : (
                        <textarea aria-label={s.key} value={drafts[s.key] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} rows={3} className="w-full rounded-button border border-border bg-surface px-3 py-2 font-mono text-xs" />
                      )}
                      {s.key === 'pool_payment_mode' && drafts[s.key] === 'block_capture' && <p className="mt-1 text-xs text-warning">{t('block_capture_warning')}</p>}
                      {errors[s.key] && <p className="mt-1 text-xs text-danger">{errors[s.key]}</p>}
                    </div>
                    <div className="md:text-right">
                      <Button size="sm" loading={busy === s.key} disabled={(drafts[s.key] ?? '') === toText(s.key, s.value)} onClick={() => saveSetting(s.key)}>{t('save')}</Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}

function toText(key: MartSettingKey, value: unknown): string {
  if (value == null) return ''
  if (NUMBER_KEYS.includes(key) || key in ENUM_KEYS) return String(value)
  return JSON.stringify(value, null, 2)
}

function fromText(key: MartSettingKey, text: string): unknown {
  if (NUMBER_KEYS.includes(key)) return Number(text)
  if (key in ENUM_KEYS) return text
  return JSON.parse(text)
}
