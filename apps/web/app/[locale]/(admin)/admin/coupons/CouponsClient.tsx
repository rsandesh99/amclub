'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

interface Coupon {
  id: string
  code: string
  kind: string
  value_bps: number
  max_discount_paise: number | null
  valid_from: string
  valid_to: string
  usage_limit: number | null
  used_count: number
  is_active: boolean
  category: { slug: string } | null
}

const todayPlus = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)

export function CouponsClient() {
  const t = useTranslations('admin_coupons')
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [code, setCode] = useState('')
  const [kind, setKind] = useState<'percent' | 'fixed'>('percent')
  const [value, setValue] = useState('')
  const [maxDiscount, setMaxDiscount] = useState('')
  const [validFrom, setValidFrom] = useState(todayPlus(0))
  const [validTo, setValidTo] = useState(todayPlus(30))
  const [usageLimit, setUsageLimit] = useState('')

  async function load() {
    try {
      const res = await fetch('/api/v1/admin/coupons', { cache: 'no-store' })
      if (res.ok) setCoupons((await res.json()).coupons ?? [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function create() {
    setBusy(true); setError('')
    try {
      const body = {
        code: code.trim(),
        kind,
        value: Number(value),
        maxDiscountRupees: maxDiscount ? Number(maxDiscount) : undefined,
        validFrom: new Date(validFrom).toISOString(),
        validTo: new Date(validTo + 'T23:59:59').toISOString(),
        usageLimit: usageLimit ? Number(usageLimit) : undefined,
      }
      const res = await fetch('/api/v1/admin/coupons', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('create_failed'))
      setCode(''); setValue(''); setMaxDiscount(''); setUsageLimit('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('create_failed'))
    } finally { setBusy(false) }
  }

  const fmtValue = (c: Coupon) => c.kind === 'percent' ? `${c.value_bps / 100}%` : `₹${c.value_bps / 100}`

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>

      {/* Create form */}
      <div className="rounded-card border border-border bg-surface p-5 space-y-3">
        <h2 className="text-sm font-semibold">{t('new_coupon')}</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">{t('code')}
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" placeholder="WELCOME10" />
          </label>
          <label className="text-sm">{t('kind')}
            <select value={kind} onChange={(e) => setKind(e.target.value as 'percent' | 'fixed')} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm">
              <option value="percent">{t('percent')}</option>
              <option value="fixed">{t('fixed')}</option>
            </select>
          </label>
          <label className="text-sm">{kind === 'percent' ? t('value_percent') : t('value_rupees')}
            <input type="number" value={value} onChange={(e) => setValue(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" />
          </label>
          <label className="text-sm">{t('max_discount')}
            <input type="number" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" placeholder={t('optional')} />
          </label>
          <label className="text-sm">{t('valid_from')}
            <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" />
          </label>
          <label className="text-sm">{t('valid_to')}
            <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" />
          </label>
          <label className="text-sm">{t('usage_limit')}
            <input type="number" value={usageLimit} onChange={(e) => setUsageLimit(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" placeholder={t('optional')} />
          </label>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button onClick={create} loading={busy}>{t('create')}</Button>
      </div>

      {/* List */}
      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-foreground-secondary">
              <tr>
                <th className="p-3">{t('code')}</th><th className="p-3">{t('value')}</th>
                <th className="p-3">{t('used')}</th><th className="p-3">{t('valid_to')}</th><th className="p-3">{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="p-3 font-mono font-medium">{c.code}</td>
                  <td className="p-3">{fmtValue(c)}{c.max_discount_paise ? ` (≤₹${c.max_discount_paise / 100})` : ''}</td>
                  <td className="p-3">{c.used_count}{c.usage_limit ? `/${c.usage_limit}` : ''}</td>
                  <td className="p-3">{new Date(c.valid_to).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                  <td className="p-3">{c.is_active ? '🟢' : '⚪'}</td>
                </tr>
              ))}
              {coupons.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-foreground-secondary">{t('empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
