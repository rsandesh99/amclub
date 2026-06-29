'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Banner {
  id: string
  slot: string
  variant: 'image' | 'hero'
  image_url: string | null
  link: string | null
  headline: { en: string; hi?: string } | null
  discount_pct: number | null
  locale: string | null
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
}

const SLOTS = ['hero', 'home_hero', 'app_home', 'services_top']

export default function AdminCmsPage() {
  const t = useTranslations('admin_cms')
  const [banners, setBanners] = useState<Banner[]>([])
  const [maxDiscount, setMaxDiscount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [variant, setVariant] = useState<'image' | 'hero'>('hero')
  const [slot, setSlot] = useState(SLOTS[0])
  const [imageUrl, setImageUrl] = useState('')
  const [link, setLink] = useState('')
  const [locale, setLocale] = useState<'' | 'en' | 'hi'>('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  // hero fields
  const [headlineEn, setHeadlineEn] = useState('')
  const [headlineHi, setHeadlineHi] = useState('')
  const [sublineEn, setSublineEn] = useState('')
  const [sublineHi, setSublineHi] = useState('')
  const [ctaEn, setCtaEn] = useState('')
  const [ctaHi, setCtaHi] = useState('')
  const [ctaHref, setCtaHref] = useState('/services')
  const [discountPct, setDiscountPct] = useState('')

  async function load() {
    try {
      const res = await fetch('/api/v1/admin/cms', { cache: 'no-store' })
      if (res.ok) {
        const d = await res.json()
        setBanners(d.banners ?? [])
        setMaxDiscount(typeof d.maxDiscountPct === 'number' ? d.maxDiscountPct : null)
      }
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function create() {
    setBusy(true); setError('')
    try {
      const i18n = (en: string, hi: string) => (en.trim() ? { en: en.trim(), ...(hi.trim() ? { hi: hi.trim() } : {}) } : undefined)
      const body =
        variant === 'hero'
          ? {
              slot, variant, locale: locale || null,
              headline: i18n(headlineEn, headlineHi),
              subline: i18n(sublineEn, sublineHi),
              ctaLabel: i18n(ctaEn, ctaHi),
              ctaHref: ctaHref.trim() || undefined,
              discountPct: discountPct.trim() ? Number(discountPct) : undefined,
              startsAt: startsAt ? new Date(startsAt).toISOString() : null,
              endsAt: endsAt ? new Date(endsAt + 'T23:59:59').toISOString() : null,
            }
          : {
              slot, variant, locale: locale || null,
              imageUrl: imageUrl.trim(),
              link: link.trim() || undefined,
              startsAt: startsAt ? new Date(startsAt).toISOString() : null,
              endsAt: endsAt ? new Date(endsAt + 'T23:59:59').toISOString() : null,
            }
      const res = await fetch('/api/v1/admin/cms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('create_failed'))
      setImageUrl(''); setLink(''); setStartsAt(''); setEndsAt('')
      setHeadlineEn(''); setHeadlineHi(''); setSublineEn(''); setSublineHi(''); setCtaEn(''); setCtaHi(''); setDiscountPct('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('create_failed'))
    } finally { setBusy(false) }
  }

  async function toggle(id: string, isActive: boolean) {
    await fetch('/api/v1/admin/cms', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, isActive }),
    })
    setBanners((prev) => prev.map((b) => (b.id === id ? { ...b, is_active: isActive } : b)))
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>

      <div className="card-surface space-y-4 p-5">
        <h2 className="text-sm font-semibold">{t('new_banner')}</h2>

        {/* Variant toggle */}
        <div className="flex gap-2">
          {(['hero', 'image'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVariant(v)}
              aria-pressed={variant === v}
              className={
                'chip-toggle ' +
                (variant === v ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-foreground-secondary hover:border-primary/40')
              }
            >
              {t(`variant_${v}`)}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">{t('slot')}
            <select value={slot} onChange={(e) => setSlot(e.target.value)} className="field-select mt-1">
              {SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm">{t('locale')}
            <select value={locale} onChange={(e) => setLocale(e.target.value as '' | 'en' | 'hi')} className="field-select mt-1">
              <option value="">{t('all_locales')}</option>
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
            </select>
          </label>

          {variant === 'hero' ? (
            <>
              <label className="col-span-2 text-sm">{t('headline')} (EN)
                <Input value={headlineEn} onChange={(e) => setHeadlineEn(e.target.value)} className="mt-1" placeholder={t('headline_ph')} />
              </label>
              <label className="col-span-2 text-sm">{t('headline')} (HI)
                <Input value={headlineHi} onChange={(e) => setHeadlineHi(e.target.value)} className="mt-1" placeholder={t('optional')} />
              </label>
              <label className="col-span-2 text-sm">{t('subline')} (EN)
                <Input value={sublineEn} onChange={(e) => setSublineEn(e.target.value)} className="mt-1" />
              </label>
              <label className="col-span-2 text-sm">{t('subline')} (HI)
                <Input value={sublineHi} onChange={(e) => setSublineHi(e.target.value)} className="mt-1" placeholder={t('optional')} />
              </label>
              <label className="text-sm">{t('cta_label')} (EN)
                <Input value={ctaEn} onChange={(e) => setCtaEn(e.target.value)} className="mt-1" placeholder={t('cta_ph')} />
              </label>
              <label className="text-sm">{t('cta_label')} (HI)
                <Input value={ctaHi} onChange={(e) => setCtaHi(e.target.value)} className="mt-1" placeholder={t('optional')} />
              </label>
              <label className="text-sm">{t('cta_href')}
                <Input value={ctaHref} onChange={(e) => setCtaHref(e.target.value)} className="mt-1" placeholder="/services" />
              </label>
              <label className="text-sm">{t('discount_pct')}
                <Input type="number" inputMode="numeric" min={0} max={100} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} className="mt-1" placeholder={maxDiscount != null ? String(maxDiscount) : ''} />
                {maxDiscount != null && (
                  <span className="mt-1 block text-xs text-foreground-secondary">{t('discount_hint', { pct: maxDiscount })}</span>
                )}
              </label>
            </>
          ) : (
            <>
              <label className="col-span-2 text-sm">{t('image_url')}
                <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="mt-1" placeholder="https://…" />
              </label>
              <label className="col-span-2 text-sm">{t('link')}
                <Input value={link} onChange={(e) => setLink(e.target.value)} className="mt-1" placeholder={t('optional')} />
              </label>
            </>
          )}

          <label className="text-sm">{t('starts_at')}
            <Input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1" />
          </label>
          <label className="text-sm">{t('ends_at')}
            <Input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="mt-1" />
          </label>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button onClick={create} loading={busy}>{t('create')}</Button>
      </div>

      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : banners.length === 0 ? (
        <div className="card-surface p-10 text-center text-sm text-foreground-secondary">{t('empty')}</div>
      ) : (
        <ul className="space-y-3">
          {banners.map((b) => (
            <li key={b.id} className="card-surface flex items-center gap-4 p-3">
              {b.variant === 'hero' ? (
                <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded bg-primary text-xs font-semibold text-white">
                  {b.discount_pct ? `${b.discount_pct}%` : t('variant_hero')}
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={b.image_url ?? ''} alt="" className="h-12 w-20 rounded object-cover" />
              )}
              <div className="flex-1 text-sm">
                <p className="font-medium">
                  {b.variant === 'hero' && b.headline ? b.headline.en : b.slot}
                  <span className="text-xs text-foreground-secondary"> · {b.slot} · {b.locale ?? t('all_locales')}</span>
                </p>
                <p className="text-xs text-foreground-secondary">{b.starts_at?.slice(0, 10) ?? '—'} → {b.ends_at?.slice(0, 10) ?? '∞'}</p>
              </div>
              <Button variant="outline" onClick={() => toggle(b.id, !b.is_active)}>{b.is_active ? t('disable') : t('enable')}</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
