'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function AdminCategoriesPage() {
  const t = useTranslations('admin_ops')
  const [cats, setCats] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({}) // id → commission %
  const [error, setError] = useState('')

  // create form
  const [slug, setSlug] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [nameHi, setNameHi] = useState('')
  const [commission, setCommission] = useState('10')
  const [creds, setCreds] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/v1/admin/categories', { cache: 'no-store' })
    if (res.ok) setCats((await res.json()).categories ?? [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  async function saveCommission(id: string) {
    const pct = Number(edits[id])
    if (isNaN(pct)) return
    setBusy(id)
    await fetch('/api/v1/admin/categories', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, commissionBps: Math.round(pct * 100) }) })
    setBusy(null); await load()
  }
  async function toggleActive(id: string, isActive: boolean) {
    setBusy(id)
    await fetch('/api/v1/admin/categories', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, isActive }) })
    setBusy(null); await load()
  }
  async function create() {
    setBusy('new'); setError('')
    const body = { slug: slug.trim(), nameI18n: { en: nameEn.trim(), hi: nameHi.trim() || nameEn.trim() }, commissionBps: Math.round(Number(commission) * 100), requiredCredentials: creds.split(',').map((s) => s.trim()).filter(Boolean) }
    const res = await fetch('/api/v1/admin/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setBusy(null)
    if (res.ok) { setSlug(''); setNameEn(''); setNameHi(''); setCreds(''); await load() }
    else { const d = await res.json().catch(() => ({})); setError(typeof d.error === 'string' ? d.error : 'Failed') }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-bold">{t('categories_title')}</h1>
        <p className="mt-1 rounded-button bg-warning/10 px-3 py-2 text-xs text-warning">⚠ {t('commission_note')}</p>
      </div>

      {/* Create */}
      <div className="rounded-card border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold">{t('new_category')}</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">{t('slug')}<input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="legal-services" className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" /></label>
          <label className="text-sm">{t('commission_pct')}<input type="number" value={commission} onChange={(e) => setCommission(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" /></label>
          <label className="text-sm">{t('name_en')}<input value={nameEn} onChange={(e) => setNameEn(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" /></label>
          <label className="text-sm">{t('name_hi')}<input value={nameHi} onChange={(e) => setNameHi(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" /></label>
          <label className="col-span-2 text-sm">{t('required_creds')}<input value={creds} onChange={(e) => setCreds(e.target.value)} placeholder="icai, gstin" className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" /></label>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button onClick={create} loading={busy === 'new'} disabled={!slug || !nameEn}>{t('create')}</Button>
      </div>

      {/* List with inline commission edit */}
      {loading ? <p className="text-sm text-foreground-secondary">{t('loading')}</p> : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-foreground-secondary">
              <tr><th className="p-3">{t('slug')}</th><th className="p-3">{t('commission_pct')}</th><th className="p-3">{t('active')}</th></tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="p-3"><p className="font-medium">{c.name_i18n?.en}</p><p className="text-xs text-foreground-secondary">{c.slug}</p></td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        defaultValue={(c.commission_bps / 100).toString()}
                        onChange={(e) => setEdits((p) => ({ ...p, [c.id]: e.target.value }))}
                        className="w-20 rounded-button border border-border bg-background p-1.5 text-sm"
                      />
                      <Button size="sm" variant="outline" onClick={() => saveCommission(c.id)} loading={busy === c.id} disabled={edits[c.id] === undefined}>{t('save')}</Button>
                    </div>
                  </td>
                  <td className="p-3"><button onClick={() => toggleActive(c.id, !c.is_active)} disabled={busy === c.id}>{c.is_active ? '🟢' : '⚪'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
