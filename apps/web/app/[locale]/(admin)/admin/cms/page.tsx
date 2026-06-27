'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

interface Banner {
  id: string
  slot: string
  image_url: string
  link: string | null
  locale: string | null
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
}

const SLOTS = ['home_hero', 'app_home', 'services_top']

export default function AdminCmsPage() {
  const t = useTranslations('admin_cms')
  const [banners, setBanners] = useState<Banner[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [slot, setSlot] = useState(SLOTS[0])
  const [imageUrl, setImageUrl] = useState('')
  const [link, setLink] = useState('')
  const [locale, setLocale] = useState<'' | 'en' | 'hi'>('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')

  async function load() {
    try {
      const res = await fetch('/api/v1/admin/cms', { cache: 'no-store' })
      if (res.ok) setBanners((await res.json()).banners ?? [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function create() {
    setBusy(true); setError('')
    try {
      const body = {
        slot, imageUrl: imageUrl.trim(),
        link: link.trim() || undefined,
        locale: locale || null,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt + 'T23:59:59').toISOString() : null,
      }
      const res = await fetch('/api/v1/admin/cms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('create_failed'))
      setImageUrl(''); setLink(''); setStartsAt(''); setEndsAt('')
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

      <div className="rounded-card border border-border bg-surface p-5 space-y-3">
        <h2 className="text-sm font-semibold">{t('new_banner')}</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">{t('slot')}
            <select value={slot} onChange={(e) => setSlot(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm">
              {SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm">{t('locale')}
            <select value={locale} onChange={(e) => setLocale(e.target.value as '' | 'en' | 'hi')} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm">
              <option value="">{t('all_locales')}</option>
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
            </select>
          </label>
          <label className="col-span-2 text-sm">{t('image_url')}
            <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" placeholder="https://…" />
          </label>
          <label className="col-span-2 text-sm">{t('link')}
            <input value={link} onChange={(e) => setLink(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" placeholder={t('optional')} />
          </label>
          <label className="text-sm">{t('starts_at')}
            <input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" />
          </label>
          <label className="text-sm">{t('ends_at')}
            <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" />
          </label>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button onClick={create} loading={busy}>{t('create')}</Button>
      </div>

      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : banners.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-10 text-center text-sm text-foreground-secondary">{t('empty')}</div>
      ) : (
        <ul className="space-y-3">
          {banners.map((b) => (
            <li key={b.id} className="flex items-center gap-4 rounded-card border border-border bg-surface p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={b.image_url} alt="" className="h-12 w-20 rounded object-cover" />
              <div className="flex-1 text-sm">
                <p className="font-medium">{b.slot} <span className="text-xs text-foreground-secondary">· {b.locale ?? t('all_locales')}</span></p>
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
