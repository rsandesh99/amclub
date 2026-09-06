'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { PRODUCT_STATUSES, type ProductStatus } from '@amclub/shared'
import { formatINR, formatINRExact } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { PoolsAdmin } from './PoolsAdmin'

interface Tier {
  min_qty: number
  unit_price_paise: number
  unit_gst_paise: number
  unit_incl_gst_paise: number
  unit_after_itc_paise: number
}

interface AdminProduct {
  id: string
  name: string
  description: string | null
  categorySlug: string
  hsnCode: string
  gstRateBps: number
  unit: string
  imageUrls: string[]
  minOrderQty: number
  countryOfOrigin: string
  status: ProductStatus
  seller: { id: string; displayName: string; slug: string; city: string | null; state: string }
  sellerGstin: string | null
  sellerSellsGoods: boolean
  tiers: Tier[]
  createdAt: string
  approvedAt: string | null
}

interface GoodsOrder {
  id: string
  order_number: string
  title: string | null
  status: string
  kind: string
  total_paise: number | string
  provider_earning_paise: number | string
  created_at: string
}

type ReviewAction = 'approve' | 'reject' | 'suspend'

/** Minimum reason length mirrors productReviewSchema (@amclub/shared). */
const REASON_MIN = 5

const STATUS_BADGE: Record<ProductStatus, 'warning' | 'success' | 'danger' | 'outline'> = {
  pending_approval: 'warning',
  active: 'success',
  suspended: 'danger',
  draft: 'outline',
}

const fmtIST = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '—'

/**
 * AMC Mart admin surface (MART_DESIGN.md §3 / §4.3) — Linear-fast, no motion.
 * Section 1: listing review queue by status (approve / reject / suspend).
 * Section 2: goods orders, each linking to its payout-evidence dossier.
 */
export function MartAdminClient() {
  const t = useTranslations('admin_mart')
  const { toast } = useToast()

  const [status, setStatus] = useState<ProductStatus>('pending_approval')
  const [products, setProducts] = useState<AdminProduct[]>([])
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const [orders, setOrders] = useState<GoodsOrder[]>([])
  const [loadingOrders, setLoadingOrders] = useState(true)

  const loadProducts = useCallback(() => {
    setLoadingProducts(true)
    fetch(`/api/v1/mart/admin/products?status=${status}`, { cache: 'no-store' })
      // Drain the body on every status — an unread response never finishes.
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        return r.ok && d ? (d.products as AdminProduct[]) : []
      })
      .then(setProducts)
      .finally(() => setLoadingProducts(false))
  }, [status])

  const loadOrders = useCallback(() => {
    setLoadingOrders(true)
    fetch('/api/v1/admin/orders?kind=goods', { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        return r.ok && d ? (d.orders as GoodsOrder[]) : []
      })
      .then(setOrders)
      .finally(() => setLoadingOrders(false))
  }, [])

  useEffect(() => { loadProducts() }, [loadProducts])
  useEffect(() => { loadOrders() }, [loadOrders])

  async function review(id: string, action: ReviewAction) {
    let reason: string | undefined
    if (action !== 'approve') {
      const r = window.prompt(action === 'reject' ? t('reject_reason_prompt') : t('suspend_reason_prompt'))
      if (r === null) return
      reason = r.trim()
      if (reason.length < REASON_MIN) {
        toast(t('reason_too_short', { n: REASON_MIN }), 'error')
        return
      }
    }
    setBusy(id)
    try {
      const res = await fetch(`/api/v1/mart/admin/products/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'approve' ? { action } : { action, reason }),
      })
      const d: { error?: unknown } = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(typeof d.error === 'string' ? d.error : t('action_failed'), 'error')
        return
      }
      toast(t(`${action}_done`), 'success')
      loadProducts()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>

      {/* ── Section 1: listing queue ─────────────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{t('listings_title')}</h2>
        <div className="flex flex-wrap gap-1">
          {PRODUCT_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-button px-3 py-1.5 text-sm ${status === s ? 'bg-primary text-white' : 'border border-border'}`}
            >
              {t(`status_${s}`)}
            </button>
          ))}
        </div>

        {loadingProducts ? (
          <p className="text-sm text-foreground-secondary">{t('loading')}</p>
        ) : products.length === 0 ? (
          <div className="rounded-card border border-border bg-surface p-10 text-center text-sm text-foreground-secondary">
            {t('listings_empty')}
          </div>
        ) : (
          <div className="space-y-4">
            {products.map((p) => (
              <article key={p.id} className="rounded-card border border-border bg-surface p-5 shadow-card">
                <div className="flex items-start gap-4">
                  {/* Thumbnails */}
                  <div className="flex shrink-0 gap-1">
                    {p.imageUrls.length === 0 ? (
                      <div className="flex h-20 w-20 items-center justify-center rounded-[8px] border border-border bg-muted text-[11px] text-foreground-secondary">
                        {t('no_image')}
                      </div>
                    ) : (
                      p.imageUrls.slice(0, 3).map((u) => (
                        <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="block">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={u} alt={p.name} className="h-20 w-20 rounded-[8px] border border-border object-cover" />
                        </a>
                      ))
                    )}
                  </div>

                  {/* Header */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-lg font-semibold">{p.name}</h3>
                        <p className="text-sm text-foreground-secondary">
                          <Link href={`/admin/providers/${p.seller.id}` as '/admin/providers'} className="text-trust hover:underline">
                            {p.seller.displayName}
                          </Link>
                          {' · '}
                          {[p.seller.city, p.seller.state].filter(Boolean).join(', ')}
                        </p>
                        <p className="mt-0.5 text-xs text-foreground-secondary">
                          {t('gstin')}: <span className="font-mono">{p.sellerGstin ?? '—'}</span>
                          {!p.sellerSellsGoods && (
                            <Badge variant="warning" className="ml-2">{t('seller_not_goods')}</Badge>
                          )}
                        </p>
                      </div>
                      <Badge variant={STATUS_BADGE[p.status]}>{t(`status_${p.status}`)}</Badge>
                    </div>
                    {p.description && <p className="mt-2 line-clamp-3 text-sm text-foreground-secondary">{p.description}</p>}
                  </div>
                </div>

                {/* Details grid */}
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                  <Fact label={t('category')} value={p.categorySlug} />
                  <Fact label={t('hsn')} value={p.hsnCode} mono />
                  <Fact label={t('gst_rate')} value={`${p.gstRateBps / 100}%`} />
                  <Fact label={t('min_order_qty')} value={`${p.minOrderQty} ${p.unit}`} />
                  <Fact label={t('country_of_origin')} value={p.countryOfOrigin} />
                  <Fact label={t('created_at')} value={fmtIST(p.createdAt)} />
                  <Fact label={t('approved_at')} value={fmtIST(p.approvedAt)} />
                </dl>

                {/* Tiers */}
                <div className="mt-4 overflow-x-auto rounded-[8px] border border-border">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-muted/40 text-left text-xs text-foreground-secondary">
                      <tr>
                        <th className="p-2">{t('tier_min_qty')}</th>
                        <th className="p-2">{t('tier_unit_price')}</th>
                        <th className="p-2">{t('tier_gst')}</th>
                        <th className="p-2">{t('tier_incl_gst')}</th>
                        <th className="p-2">{t('tier_after_itc')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.tiers.length === 0 ? (
                        <tr><td colSpan={5} className="p-3 text-center text-foreground-secondary">{t('no_tiers')}</td></tr>
                      ) : (
                        p.tiers.map((tier) => (
                          <tr key={tier.min_qty} className="border-b border-border last:border-0">
                            <td className="p-2 tabular-nums">{tier.min_qty}+ {p.unit}</td>
                            <td className="p-2 tabular-nums">{formatINRExact(tier.unit_price_paise)}</td>
                            <td className="p-2 tabular-nums">{formatINRExact(tier.unit_gst_paise)}</td>
                            <td className="p-2 tabular-nums font-semibold">{formatINRExact(tier.unit_incl_gst_paise)}</td>
                            <td className="p-2 tabular-nums">{formatINRExact(tier.unit_after_itc_paise)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Actions — legal transitions only (PRODUCT_TRANSITIONS in @amclub/shared). */}
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                  {p.status === 'pending_approval' && (
                    <>
                      <Button size="sm" onClick={() => review(p.id, 'approve')} loading={busy === p.id}>{t('approve')}</Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-danger text-danger hover:bg-danger/10"
                        onClick={() => review(p.id, 'reject')}
                        loading={busy === p.id}
                      >
                        {t('reject')}
                      </Button>
                    </>
                  )}
                  {p.status === 'active' && (
                    <Button size="sm" variant="danger" onClick={() => review(p.id, 'suspend')} loading={busy === p.id}>{t('suspend')}</Button>
                  )}
                  {p.status === 'suspended' && (
                    <Button size="sm" onClick={() => review(p.id, 'approve')} loading={busy === p.id}>{t('reinstate')}</Button>
                  )}
                  {p.status === 'draft' && <p className="text-xs text-foreground-secondary">{t('draft_hint')}</p>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ── Section 2: goods orders ──────────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{t('orders_title')}</h2>
          <p className="text-sm text-foreground-secondary">{t('orders_subtitle')}</p>
        </div>
        {loadingOrders ? (
          <p className="text-sm text-foreground-secondary">{t('loading')}</p>
        ) : orders.length === 0 ? (
          <div className="rounded-card border border-border bg-surface p-10 text-center text-sm text-foreground-secondary">
            {t('orders_empty')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-card border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-foreground-secondary">
                <tr>
                  <th className="p-3">{t('order')}</th>
                  <th className="p-3">{t('order_status')}</th>
                  <th className="p-3">{t('total')}</th>
                  <th className="p-3">{t('seller_earning')}</th>
                  <th className="p-3">{t('placed_at')}</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-border last:border-0">
                    <td className="p-3">
                      <Link href={`/admin/mart/orders/${o.id}` as '/admin/orders'} className="font-medium text-trust hover:underline">
                        {o.order_number}
                      </Link>
                      {o.title && <p className="max-w-[16rem] truncate text-xs text-foreground-secondary">{o.title}</p>}
                    </td>
                    <td className="p-3"><Badge variant="outline">{o.status}</Badge></td>
                    <td className="p-3 tabular-nums font-semibold">{formatINR(Number(o.total_paise))}</td>
                    <td className="p-3 tabular-nums">{formatINR(Number(o.provider_earning_paise))}</td>
                    <td className="p-3 text-xs text-foreground-secondary">{fmtIST(o.created_at)}</td>
                    <td className="p-3 text-right">
                      <Link href={`/admin/mart/orders/${o.id}` as '/admin/orders'} className="text-xs font-medium text-primary hover:underline">
                        {t('open_dossier')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Section 3: group-buy pools (M1) ─────────────────────────────── */}
      <PoolsAdmin />
    </div>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-foreground-secondary">{label}</dt>
      <dd className={`mt-0.5 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}
