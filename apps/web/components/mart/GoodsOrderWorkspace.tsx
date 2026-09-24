'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { ALWAYS_CLAIMABLE_RETURN_REASONS, type GoodsLineItem } from '@amclub/shared'
import { formatINR, formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ReviewSection } from '@/components/orders/ReviewSection'
import { EvidenceCapture } from '@/components/orders/EvidenceCapture'
import { useCart } from '@/lib/mart/cart-store'
import type { GoodsOrderExtras } from '@/lib/mart/order-extras'
import { SheetCard, EmeraldCard, GoldNumeral, GoldStamp } from './primitives'
import { PaisaMoment } from './PaisaMoment'

interface OrderEvent { id: string; event: string; created_at: string; actor_id: string | null }
interface DocItem { id: string; file_name: string; kind: string; signedUrl: string | null }

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  placed: 'info', accepted: 'info', requirements_submitted: 'info', in_progress: 'warning', delivered: 'warning',
  completed: 'success', reviewed: 'success', disputed: 'danger', resolved_refund: 'default', resolved_release: 'success',
  resolved_partial: 'success', refunded: 'default', auto_cancelled: 'default', cancelled_by_buyer: 'default',
}

/** Timeline vocabulary → mart.* keys. Goods events + the shared spine events. */
const EVENT_KEY: Record<string, string> = {
  placed: 'event_placed', accept: 'event_accept', requirements_submitted: 'event_requirements_auto', dispatched: 'event_dispatched',
  delivered_photo: 'event_delivered_photo', buyer_received: 'event_buyer_received', auto_accepted: 'event_auto_accepted',
  return_opened: 'event_return_opened', return_resolved: 'event_return_resolved', cancel: 'event_cancel', refunded: 'event_refunded',
  payout_held: 'event_payout_held', payout_released: 'event_payout_released', payout_paid: 'event_payout_paid', document_uploaded: 'event_document_uploaded',
}
const RETURN_REASONS = ['damaged', 'wrong_item', 'short_quantity', 'quality', 'other'] as const
/** E16 N43 — what a non-returnable order can still claim (shared ALWAYS_CLAIMABLE_RETURN_REASONS). */
const CLAIM_REASONS: readonly (typeof RETURN_REASONS)[number][] = ALWAYS_CLAIMABLE_RETURN_REASONS
const HOUR = 3600 * 1000

/** "Thu 8 Sep, 9:07 am" in IST — the mandate wants dates, not "in 72 hours". */
function fmtDate(iso: string | Date | null | undefined, withTime = true): string {
  if (!iso) return ''
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) })
}

/**
 * Goods order workspace (FRONTEND.md P2 + §7): title block, ONE emerald money
 * card with amount + status + NEXT DATE, a sticky thumb-zone action bar,
 * camera-first evidence (offline-queued), the GOLD THREAD timeline, and the
 * Paisa Moment on the first view after payment / after payout.
 */
export function GoodsOrderWorkspace({
  order, events, viewerRole, documents, goods, firstView = false,
}: {
  order: Record<string, unknown>
  events: OrderEvent[]
  viewerRole: 'msme' | 'provider'
  documents: DocItem[]
  goods?: GoodsOrderExtras | undefined
  firstView?: boolean
}) {
  const t = useTranslations('mart')
  const tOrders = useTranslations('orders')
  const router = useRouter()
  const addToCart = useCart((s) => s.add)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<'dispatch' | 'deliver' | 'return' | null>(null)
  const [stamp, setStamp] = useState<'received' | 'reordered' | null>(null)
  const [paisa, setPaisa] = useState<'paid' | 'payout' | null>(null)
  const [dispatch, setDispatch] = useState({ photoDocId: '', invoiceNumber: '', invoiceDocId: '', batch: '', transporter: '', vehicle: '', eway: '' })
  const [deliveryDocId, setDeliveryDocId] = useState('')
  const [ret, setRet] = useState<{ reason: (typeof RETURN_REASONS)[number]; details: string }>({ reason: 'damaged', details: '' })

  const id = order['id'] as string
  const status = order['status'] as string
  const lines = (order['line_items'] as GoodsLineItem[] | null) ?? []
  const delivery = (order['delivery_snapshot'] as Record<string, unknown> | null) ?? null
  const isProvider = viewerRole === 'provider'
  const total = Number(order['total_paise'])
  const earning = Number(order['provider_earning_paise'])
  const paidEvent = events.find((e) => e.event === 'payout_paid')
  const deliveredAt = events.find((e) => e.event === 'delivered_photo')?.created_at ?? null
  const returnWindowEndsAt = deliveredAt && goods ? new Date(new Date(deliveredAt).getTime() + goods.returnWindowHours * HOUR) : null

  // Paisa Moment — once per order per device (FRONTEND.md §3.1 #2).
  useEffect(() => {
    try {
      const key = `amc-paisa-${id}-${isProvider ? 'payout' : 'paid'}`
      if (localStorage.getItem(key)) return
      if (!isProvider && firstView) { localStorage.setItem(key, '1'); setPaisa('paid') }
      if (isProvider && paidEvent) { localStorage.setItem(key, '1'); setPaisa('payout') }
    } catch { /* storage unavailable */ }
  }, [id, isProvider, firstView, paidEvent])

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action); setError('')
    try {
      const res = await fetch(`/api/v1/mart/orders/${id}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error === 'eway_bill_required' ? t('eway_required_note') : d.error === 'not_returnable' ? t('not_returnable_claims_only') : typeof d.error === 'string' ? d.error : t('action_failed'))
      setPanel(null)
      if (action === 'accept_delivery') { setStamp('received'); await new Promise((r) => setTimeout(r, 900)) }
      router.refresh()
    } catch (e) { setError(e instanceof Error ? e.message : t('action_failed')) } finally { setBusy(null) }
  }

  function reorder() {
    for (const l of lines) {
      if (l.product_id) addToCart({ productId: l.product_id, name: l.name, unit: l.unit, sellerId: order['provider_id'] as string, sellerName: goods?.sellerName ?? '', minOrderQty: 1, imageUrl: null }, l.qty)
    }
    setStamp('reordered')
    setTimeout(() => router.push('/app/mart/cart' as '/app'), 700)
  }

  type Action = { key: string; run: () => void; tone?: 'danger' | 'outline' }
  const actions: Action[] = isProvider
    ? status === 'placed' ? [{ key: 'accept', run: () => act('accept') }]
      : status === 'accepted' ? [{ key: 'dispatch', run: () => setPanel('dispatch') }]
      : status === 'in_progress' ? [{ key: 'deliver', run: () => setPanel('deliver') }]
      : []
    : [
        ...(status === 'delivered' ? [{ key: 'buyer_received', run: () => act('accept_delivery') }] : []),
        ...(status === 'delivered' || status === 'completed' ? [{ key: 'open_return', run: () => setPanel('return'), tone: 'outline' as const }] : []),
        ...(status === 'placed' || status === 'accepted' ? [{ key: 'cancel', run: () => act('cancel'), tone: 'danger' as const }] : []),
        ...(['completed', 'reviewed', 'resolved_release', 'resolved_partial', 'resolved_refund', 'refunded'].includes(status) ? [{ key: 'reorder', run: reorder, tone: 'outline' as const }] : []),
      ]
  const completed = status === 'completed' || status === 'reviewed'

  // The "next event" line — always a DATE (FRONTEND.md §5 money surfaces).
  let next: string | null = null
  if (isProvider) {
    if (goods?.payout && goods.payout.status === 'paid') next = null
    else if (goods?.payout && returnWindowEndsAt && returnWindowEndsAt.getTime() > Date.now()) next = t('payout_after', { amount: formatINR(goods.payout.amountPaise), date: fmtDate(returnWindowEndsAt, false) })
    else if (goods?.payout?.scheduledFor) next = t('payout_scheduled_for', { date: fmtDate(goods.payout.scheduledFor + 'T00:00:00+05:30', false) })
    else if (order['due_at'] && ['placed', 'accepted', 'in_progress', 'requirements_submitted'].includes(status)) next = t('delivery_by', { date: fmtDate(order['due_at'] as string, false) })
  } else {
    if (status === 'delivered' && order['auto_accept_at']) next = t('auto_receipt_on', { date: fmtDate(order['auto_accept_at'] as string) })
    else if (completed && returnWindowEndsAt && returnWindowEndsAt.getTime() > Date.now()) next = t('return_window_until', { date: fmtDate(returnWindowEndsAt) })
    else if (order['due_at'] && ['placed', 'accepted', 'in_progress', 'requirements_submitted'].includes(status)) next = t('delivery_by', { date: fmtDate(order['due_at'] as string, false) })
  }

  return (
    <div className="mart-enter mx-auto max-w-2xl space-y-5 px-4 pb-28 pt-6">
      {paisa && <PaisaMoment kind={paisa} amountPaise={paisa === 'payout' ? earning : total} onDone={() => setPaisa(null)} />}

      {/* Title block */}
      <SheetCard gold={completed}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-foreground-secondary">{String(order['order_number'])} · {t('goods_order')}</p>
            <h1 className="font-display text-xl font-bold text-emerald-ink">{String(order['title'])}</h1>
          </div>
          <Badge variant={STATUS_VARIANT[status] ?? 'default'}>{tOrders(`status_${status}` as 'status_placed')}</Badge>
        </div>
        <ul className="mt-3 divide-y divide-brass/20 text-meta">
          {lines.map((l) => (
            <li key={l.product_id ?? l.name} className="flex justify-between gap-3 py-2">
              <span className="text-emerald-ink">{t('qty_unit', { qty: l.qty, unit: l.unit })} {l.name} <span className="text-xs text-foreground-secondary">· {t('hsn')} {l.hsn_code} · {t('gst_rate', { rate: l.gst_rate_bps / 100 })}</span></span>
              <span className="shrink-0 tabular-nums">{formatINRExact(l.line_taxable_paise)}</span>
            </li>
          ))}
        </ul>
        {delivery && (
          <p className="mt-3 text-meta text-foreground-secondary">
            {delivery['pickup'] ? t('pickup_label') : t('delivery_to')}: {String(delivery['contact_name'] ?? '')}, {String(delivery['address'] ?? '')}, {String(delivery['city'] ?? '')} {String(delivery['pincode'] ?? '')}
          </p>
        )}
      </SheetCard>

      {/* ONE emerald money card — amount + status + next date */}
      <EmeraldCard>
        <p className="text-xs text-ivory/80">{isProvider ? t('seller_receives') : t('you_pay')}</p>
        <GoldNumeral className="text-4xl" countUpPaise={isProvider ? earning : total} />
        {next && <p className="mt-2 text-meta font-medium text-ivory">{next}</p>}
        <p className="mt-1 text-xs text-ivory/80">{isProvider ? t('fee_story') : t('secure_note')}</p>
      </EmeraldCard>

      {stamp && (
        <div className="gold-edge-card flex items-center gap-3 p-4" role="status">
          <GoldStamp className="h-10 w-10 text-sm">✓</GoldStamp>
          <p className="text-meta font-medium text-emerald-ink">{stamp === 'received' ? t('stamp_received') : t('reordered')}</p>
        </div>
      )}

      {/* Evidence panels (inline); the buttons live in the sticky bar below */}
      {panel && (
        <SheetCard className="space-y-3">
          {panel === 'dispatch' && (
            <div className="space-y-3">
              <h3 className="font-medium text-emerald-ink">{t('dispatch_title')}</h3>
              <p className="text-xs text-foreground-secondary">{t('eway_required_note')}</p>
              <EvidenceCapture orderId={id} kind="dispatch_photo" label={t('dispatch_photo')} onUploaded={(d) => setDispatch((s) => ({ ...s, photoDocId: d }))} />
              <div><Label htmlFor="inv">{t('seller_invoice_number')}</Label><Input id="inv" value={dispatch.invoiceNumber} onChange={(e) => setDispatch((s) => ({ ...s, invoiceNumber: e.target.value }))} /></div>
              <EvidenceCapture orderId={id} kind="other" accept="image/*,application/pdf" label={t('seller_invoice_doc')} compact onUploaded={(d) => setDispatch((s) => ({ ...s, invoiceDocId: d }))} />
              <div className="grid grid-cols-2 gap-3">
                <div><Label htmlFor="batch">{t('batch_or_lot')}</Label><Input id="batch" value={dispatch.batch} onChange={(e) => setDispatch((s) => ({ ...s, batch: e.target.value }))} /></div>
                <div><Label htmlFor="tr">{t('transporter_name')}</Label><Input id="tr" value={dispatch.transporter} onChange={(e) => setDispatch((s) => ({ ...s, transporter: e.target.value }))} /></div>
                <div><Label htmlFor="veh">{t('vehicle_number')}</Label><Input id="veh" value={dispatch.vehicle} onChange={(e) => setDispatch((s) => ({ ...s, vehicle: e.target.value.toUpperCase() }))} /></div>
                <div><Label htmlFor="eway">{t('eway_bill_number')}</Label><Input id="eway" inputMode="numeric" value={dispatch.eway} onChange={(e) => setDispatch((s) => ({ ...s, eway: e.target.value.replace(/\D/g, '').slice(0, 12) }))} /></div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setPanel(null)}>{t('back')}</Button>
                <Button className="bg-emerald hover:bg-emerald-ink" loading={busy === 'dispatch'} disabled={!dispatch.photoDocId || !dispatch.invoiceNumber.trim()}
                  onClick={() => act('dispatch', { dispatch: {
                    dispatch_photo_doc_id: dispatch.photoDocId, seller_invoice_number: dispatch.invoiceNumber.trim(),
                    ...(dispatch.invoiceDocId ? { seller_invoice_doc_id: dispatch.invoiceDocId } : {}),
                    ...(dispatch.batch.trim() ? { batch_or_lot: dispatch.batch.trim() } : {}),
                    ...(dispatch.transporter.trim() ? { transporter_name: dispatch.transporter.trim() } : {}),
                    ...(dispatch.vehicle.trim() ? { vehicle_number: dispatch.vehicle.trim() } : {}),
                    ...(dispatch.eway ? { eway_bill_number: dispatch.eway } : {}),
                  } })}>
                  {t('action_dispatch')}
                </Button>
              </div>
            </div>
          )}
          {panel === 'deliver' && (
            <div className="space-y-3">
              <EvidenceCapture orderId={id} kind="delivery_photo" label={t('delivery_photo')} onUploaded={setDeliveryDocId} />
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setPanel(null)}>{t('back')}</Button>
                <Button className="bg-emerald hover:bg-emerald-ink" loading={busy === 'deliver'} disabled={!deliveryDocId} onClick={() => act('deliver', { deliver: { delivery_photo_doc_id: deliveryDocId } })}>{t('action_deliver')}</Button>
              </div>
            </div>
          )}
          {panel === 'return' && (
            <div className="space-y-3">
              {goods?.returnable === false && <p className="text-meta text-foreground-secondary" data-testid="not-returnable-claim">{t('not_returnable_claims_only')}</p>}
              <div>
                <Label htmlFor="rr">{t('return_reason')}</Label>
                <Select id="rr" value={ret.reason} onChange={(e) => setRet((s) => ({ ...s, reason: e.target.value as (typeof RETURN_REASONS)[number] }))}>
                  {(goods?.returnable === false ? CLAIM_REASONS : RETURN_REASONS).map((r) => <option key={r} value={r}>{t(`return_reason_${r}` as 'return_reason_damaged')}</option>)}
                </Select>
              </div>
              <div><Label htmlFor="rd">{t('return_details')}</Label><Textarea id="rd" rows={3} value={ret.details} onChange={(e) => setRet((s) => ({ ...s, details: e.target.value }))} /></div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setPanel(null)}>{t('back')}</Button>
                <Button variant="danger" loading={busy === 'open_return'} onClick={() => act('open_return', { return: { reason: ret.reason, ...(ret.details.trim() ? { details: ret.details.trim() } : {}) } })}>{t('return_submit')}</Button>
              </div>
            </div>
          )}
          {error && <p className="text-meta text-stamp" role="alert">{error}</p>}
        </SheetCard>
      )}
      {error && !panel && <p className="text-meta text-stamp" role="alert">{error}</p>}

      {completed && <ReviewSection orderId={id} />}

      <SheetCard>
        <h2 className="mb-2 text-meta font-semibold text-emerald-ink">{t('documents')}</h2>
        {documents.length === 0 ? (
          <p className="text-meta text-foreground-secondary">—</p>
        ) : (
          <ul className="space-y-1 text-meta">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-emerald-ink">📎 {d.file_name} <span className="text-xs text-foreground-secondary">({d.kind})</span></span>
                {d.signedUrl && <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 shrink-0 items-center text-emerald underline">{t('download')}</a>}
              </li>
            ))}
          </ul>
        )}
      </SheetCard>

      {/* Gold thread timeline */}
      <SheetCard>
        <h2 className="mb-3 text-meta font-semibold text-emerald-ink">{t('timeline')}</h2>
        <ol className="gold-thread space-y-4 pl-0">
          {events.filter((e) => e.event !== 'placed_side_effects').map((e) => (
            <li key={e.id} className="flex gap-3 text-meta">
              <span className="gold-thread-node" aria-hidden="true" />
              <div>
                <p className="font-medium text-emerald-ink">{EVENT_KEY[e.event] ? t(EVENT_KEY[e.event] as 'event_placed') : e.event.replace(/_/g, ' ')}</p>
                <p className="text-xs text-foreground-secondary">{fmtDate(e.created_at)} IST</p>
              </div>
            </li>
          ))}
        </ol>
      </SheetCard>

      {/* Sticky thumb-zone action bar — one primary action per screen (FRONTEND.md §5) */}
      {actions.length > 0 && !panel && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-brass/40 bg-ivory/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-2">
            {actions.map((a, i) => (
              <Button
                key={a.key}
                size="lg"
                variant={a.tone === 'danger' ? 'danger' : a.tone === 'outline' ? 'outline' : 'primary'}
                className={`${i === 0 && !a.tone ? 'flex-1 bg-emerald hover:bg-emerald-ink' : a.tone === 'outline' ? 'border-emerald text-emerald' : ''}`}
                loading={busy === a.key}
                onClick={a.run}
                title={a.key === 'reorder' ? t('reorder_hint') : undefined}
              >
                {a.key === 'reorder' ? t('reorder') : t(`action_${a.key}` as 'action_accept')}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
