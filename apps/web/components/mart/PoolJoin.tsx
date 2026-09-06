'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { formatINR, formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import type { DeliveryDefaults } from '@/lib/mart/delivery-defaults'
import { SheetCard, GoldStamp } from './primitives'
import { istDateTime } from './PoolProgress'

type Progress = { pct: number; metPct: number; met: boolean; remainingToMin: number }
interface PoolView { id: string; status: string; unit: string; unit_price_paise: number; target_qty: number; min_qty: number; committed_qty: number; member_count: number; closes_at: string; progress: Progress }
interface Member { id: string; qty: number; payment_state: 'blocked' | 'captured' | 'released' | 'failed'; pay_by: string | null; order_id: string | null }

/**
 * Join / update / leave a pool, and the member's state after close (pay now,
 * paid, lapsed, released). Membership is fetched client-side so the pool page
 * itself stays cacheable. Pay-on-close: joining moves no money.
 */
export function PoolJoin({ poolId, states, minOrderQty }: { poolId: string; states: { value: string; label: string }[]; minOrderQty: number }) {
  const t = useTranslations('mart')
  const [pool, setPool] = useState<PoolView | null>(null)
  const [member, setMember] = useState<Member | null>(null)
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [defaults, setDefaults] = useState<DeliveryDefaults | null>(null)
  const [qty, setQty] = useState(String(minOrderQty))
  const [form, setForm] = useState({ contact_name: '', contact_phone: '', address: '', city: '', state: 'AP', pincode: '', pickup: false })
  const [gstin, setGstin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    let active = true
    fetch(`/api/v1/mart/pools/${poolId}`, { cache: 'no-store' })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active || !d) return
        setPool(d.pool)
        setMember(d.member)
        if (d.member) setQty(String(d.member.qty))
      })
    fetch('/api/v1/mart/delivery-defaults', { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401) { setAuthed(false); return null }
        setAuthed(true)
        return r.ok ? r.json() : null
      })
      .then((d) => {
        if (!active || !d?.defaults) return
        setDefaults(d.defaults)
        setForm({ contact_name: d.defaults.contact_name, contact_phone: d.defaults.contact_phone, address: d.defaults.address, city: d.defaults.city, state: d.defaults.state || 'AP', pincode: d.defaults.pincode, pickup: d.defaults.pickup })
      })
    return () => { active = false }
  }, [poolId])

  const errKey = (code: string) => {
    const k = `pool_err_${code}`
    return (t.has(k as 'pool_err_pool_closed') ? t(k as 'pool_err_pool_closed') : t('failed'))
  }

  async function join() {
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/v1/mart/pools/${poolId}/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qty: Number(qty), delivery: form, ...(gstin.trim() ? { gstInvoice: { gstin: gstin.trim() } } : {}) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(typeof d.error === 'string' ? errKey(d.error) : t('failed')); return }
      setPool(d.pool); setMember({ ...d.member, pay_by: null, order_id: null }); setOpen(false)
    } finally { setBusy(false) }
  }
  async function leave() {
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/v1/mart/pools/${poolId}/leave`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(typeof d.error === 'string' ? errKey(d.error) : t('failed')); return }
      setPool(d.pool); setMember(null); setQty(String(minOrderQty))
    } finally { setBusy(false) }
  }

  if (!pool) return null
  const live = pool.status === 'open'
  const qtyN = Number(qty)
  const formValid = qtyN >= 1 && form.contact_name.trim().length >= 2 && /^(?:\+91)?[6-9]\d{9}$/.test(form.contact_phone) && form.address.trim().length >= 5 && form.city.trim().length >= 2 && /^\d{6}$/.test(form.pincode)

  return (
    <div className="space-y-3">
      {member && member.payment_state === 'blocked' && live && (
        <SheetCard gold className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body font-semibold text-emerald-ink"><GoldStamp className="mr-2">✓</GoldStamp>{t('pool_joined', { qty: member.qty, unit: pool.unit })}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>{t('pool_change')}</Button>
            <Button variant="ghost" size="sm" onClick={leave} loading={busy}>{t('pool_leave')}</Button>
          </div>
        </SheetCard>
      )}
      {member && pool.status === 'closed_met' && member.payment_state === 'blocked' && (
        <SheetCard gold>
          <p className="text-body font-semibold text-emerald-ink">{t('pool_met_line')}</p>
          {member.pay_by && <p className="mt-1 text-meta text-foreground-secondary">{t('pool_pay_by', { date: istDateTime(member.pay_by) })}</p>}
          <Link href={`/app/mart/pools/${poolId}/pay` as '/app'} className="mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-button bg-gold-metal px-5 text-base font-semibold text-emerald-ink">
            {t('pool_pay_now', { amount: formatINR(member.qty * pool.unit_price_paise) })}
          </Link>
        </SheetCard>
      )}
      {member && member.payment_state === 'captured' && (
        <SheetCard gold className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body font-semibold text-emerald-ink"><GoldStamp className="mr-2">✓</GoldStamp>{t('pool_paid')}</p>
          {member.order_id && <Link href={`/app/orders/${member.order_id}` as '/app'} className="text-meta font-medium text-emerald underline underline-offset-2">{t('view_order')}</Link>}
        </SheetCard>
      )}
      {member && member.payment_state === 'failed' && <p className="text-meta text-stamp">{t('pool_lapsed')}</p>}
      {member && member.payment_state === 'released' && live && <p className="text-meta text-foreground-secondary">{t('pool_released')}</p>}

      {live && authed === false && (
        <Link href={`/login?next=/mart/pools/${poolId}` as '/login'} className="inline-flex min-h-12 w-full items-center justify-center rounded-button bg-emerald px-5 text-base font-semibold text-ivory">
          {t('pool_login_to_join')}
        </Link>
      )}
      {live && authed && (!member || member.payment_state === 'released' || open) && (
        <SheetCard className="space-y-3">
          <div>
            <Label htmlFor="pq">{t('pool_join_qty', { unit: pool.unit })}</Label>
            <Input id="pq" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
            {qtyN >= 1 && <p className="mt-1 text-meta text-foreground-secondary">{t('pool_pay_line', { qty: qtyN, unit: pool.unit, price: formatINRExact(pool.unit_price_paise) })} = <span className="font-semibold text-emerald-ink">{formatINR(qtyN * pool.unit_price_paise)}</span> + GST</p>}
          </div>
          <h3 className="text-meta font-semibold text-emerald-ink">{t('pool_delivery_title')}</h3>
          {defaults && <p className="text-xs text-foreground-secondary">{t('address_prefilled')}</p>}
          <div><Label htmlFor="cn">{t('contact_name')}</Label><Input id="cn" value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></div>
          <div><Label htmlFor="cp">{t('contact_phone')}</Label><Input id="cp" inputMode="tel" value={form.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} /></div>
          <div><Label htmlFor="ad">{t('address')}</Label><Input id="ad" value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="ci">{t('city')}</Label><Input id="ci" value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
            <div><Label htmlFor="pc">{t('pincode')}</Label><Input id="pc" inputMode="numeric" value={form.pincode} onChange={(e) => set('pincode', e.target.value)} /></div>
          </div>
          <div>
            <Label htmlFor="st">{t('state')}</Label>
            <Select id="st" value={form.state} onChange={(e) => set('state', e.target.value)}>
              {states.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </div>
          <label className="flex min-h-12 items-start gap-3 text-meta text-emerald-ink">
            <input type="checkbox" checked={form.pickup} onChange={(e) => set('pickup', e.target.checked)} className="mt-0.5 h-6 w-6 shrink-0 accent-emerald" />
            <span>{t('pickup')}</span>
          </label>
          <div><Label htmlFor="gstin">{t('gstin')} ({t('gst_invoice')})</Label><Input id="gstin" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="37AAPFU0939F1ZV" /></div>
          <p className="text-xs text-foreground-secondary">{t('pool_join_note')}</p>
          {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
          <Button onClick={join} loading={busy} disabled={!formValid} size="lg" className="w-full bg-emerald text-ivory">
            {member && member.payment_state === 'blocked' ? t('pool_change') : t('pool_join')}
          </Button>
        </SheetCard>
      )}
      {error && !open && !(live && authed && !member) && <p className="text-sm text-stamp" role="alert">{error}</p>}
    </div>
  )
}
