'use client'

import { useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import type { GoodsLineItem } from '@amclub/shared'
import { formatINR, formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ReviewSection } from '@/components/orders/ReviewSection'
import { SheetCard, EmeraldCard, GoldNumeral } from './primitives'

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

/**
 * Goods order workspace (FRONTEND.md P2 + §7): title block, ONE emerald money
 * card, camera-first evidence actions, and the GOLD THREAD timeline
 * parameterised by orders.kind. Paisa Moment fires on completion (first paint).
 */
export function GoodsOrderWorkspace({
  order, events, viewerRole, documents,
}: {
  order: Record<string, unknown>
  events: OrderEvent[]
  viewerRole: 'msme' | 'provider'
  documents: DocItem[]
}) {
  const t = useTranslations('mart')
  const tOrders = useTranslations('orders')
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<'dispatch' | 'deliver' | 'return' | null>(null)
  const dispatchPhotoRef = useRef<HTMLInputElement>(null)
  const invoiceRef = useRef<HTMLInputElement>(null)
  const deliveryPhotoRef = useRef<HTMLInputElement>(null)
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

  async function upload(kind: 'dispatch_photo' | 'delivery_photo' | 'other', file: File): Promise<string | null> {
    setBusy('upload'); setError('')
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('kind', kind)
      const res = await fetch(`/api/v1/orders/${id}/documents`, { method: 'POST', body: fd })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('upload_failed'))
      return d.id as string
    } catch (e) { setError(e instanceof Error ? e.message : t('upload_failed')); return null } finally { setBusy(null) }
  }

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action); setError('')
    try {
      const res = await fetch(`/api/v1/mart/orders/${id}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error === 'eway_bill_required' ? t('eway_required_note') : typeof d.error === 'string' ? d.error : t('action_failed'))
      setPanel(null)
      router.refresh()
    } catch (e) { setError(e instanceof Error ? e.message : t('action_failed')) } finally { setBusy(null) }
  }

  const providerActions = isProvider
    ? status === 'placed' ? [{ key: 'accept', run: () => act('accept') }]
      : status === 'accepted' ? [{ key: 'dispatch', run: () => setPanel('dispatch') }]
      : status === 'in_progress' ? [{ key: 'deliver', run: () => setPanel('deliver') }]
      : []
    : []
  const buyerActions = !isProvider
    ? [
        ...(status === 'delivered' ? [{ key: 'buyer_received', run: () => act('accept_delivery') }] : []),
        ...(status === 'delivered' || status === 'completed' ? [{ key: 'open_return', run: () => setPanel('return'), outline: true }] : []),
        ...(status === 'placed' || status === 'accepted' ? [{ key: 'cancel', run: () => act('cancel'), danger: true }] : []),
      ]
    : []
  const actions = [...providerActions, ...buyerActions]
  const completed = status === 'completed' || status === 'reviewed'

  return (
    <div className="mart-enter mx-auto max-w-2xl space-y-5 px-4 py-6">
      {/* Title block */}
      <SheetCard gold={completed}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-foreground-secondary">{String(order['order_number'])} · {t('goods_order')}</p>
            <h1 className="font-display text-xl font-bold text-emerald-ink">{String(order['title'])}</h1>
          </div>
          <Badge variant={STATUS_VARIANT[status] ?? 'default'}>{tOrders(`status_${status}` as 'status_placed')}</Badge>
        </div>
        <ul className="mt-3 divide-y divide-brass/20 text-sm">
          {lines.map((l) => (
            <li key={l.product_id} className="flex justify-between py-2">
              <span className="text-emerald-ink">{t('qty_unit', { qty: l.qty, unit: l.unit })} {l.name} <span className="text-xs text-foreground-secondary">· {t('hsn')} {l.hsn_code} · {t('gst_rate', { rate: l.gst_rate_bps / 100 })}</span></span>
              <span className="tabular-nums">{formatINRExact(l.line_taxable_paise)}</span>
            </li>
          ))}
        </ul>
        {delivery && (
          <p className="mt-3 text-xs text-foreground-secondary">
            {delivery['pickup'] ? t('pickup_label') : t('delivery_to')}: {String(delivery['contact_name'] ?? '')}, {String(delivery['address'] ?? '')}, {String(delivery['city'] ?? '')} {String(delivery['pincode'] ?? '')}
          </p>
        )}
      </SheetCard>

      {/* ONE emerald money card — amount + status + next event (§5 money surfaces) */}
      <EmeraldCard>
        <p className="text-xs text-ivory/80">{isProvider ? t('seller_receives') : t('you_pay')}</p>
        <GoldNumeral className="text-4xl">{formatINR(isProvider ? earning : total)}</GoldNumeral>
        <p className="mt-2 text-xs text-ivory/80">
          {isProvider ? t('fee_story') : status === 'delivered' ? t('auto_receipt_note') : t('secure_note')}
        </p>
      </EmeraldCard>

      {/* Actions — one primary per screen; camera-first evidence */}
      {(actions.length > 0 || panel) && (
        <SheetCard className="space-y-3">
          <h2 className="text-sm font-semibold text-emerald-ink">{t('actions')}</h2>
          {!panel && (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <Button
                  key={a.key}
                  variant={'danger' in a && a.danger ? 'danger' : 'outline' in a && a.outline ? 'outline' : 'primary'}
                  className={'danger' in a && a.danger ? '' : 'outline' in a && a.outline ? 'border-emerald text-emerald' : 'bg-emerald hover:bg-emerald-ink'}
                  loading={busy === a.key}
                  onClick={a.run}
                >
                  {t(`action_${a.key}` as 'action_accept')}
                </Button>
              ))}
            </div>
          )}

          {panel === 'dispatch' && (
            <div className="space-y-3">
              <h3 className="font-medium text-emerald-ink">{t('dispatch_title')}</h3>
              <p className="text-xs text-foreground-secondary">{t('eway_required_note')}</p>
              <div>
                <Label>{t('dispatch_photo')}</Label>
                <input ref={dispatchPhotoRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const d = await upload('dispatch_photo', f); if (d) setDispatch((s) => ({ ...s, photoDocId: d })) } }} />
                <Button variant="secondary" size="sm" loading={busy === 'upload'} onClick={() => dispatchPhotoRef.current?.click()}>{dispatch.photoDocId ? '✓ ' + t('dispatch_photo') : t('add_photo')}</Button>
              </div>
              <div><Label htmlFor="inv">{t('seller_invoice_number')}</Label><Input id="inv" value={dispatch.invoiceNumber} onChange={(e) => setDispatch((s) => ({ ...s, invoiceNumber: e.target.value }))} /></div>
              <div>
                <Label>{t('seller_invoice_doc')}</Label>
                <input ref={invoiceRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const d = await upload('other', f); if (d) setDispatch((s) => ({ ...s, invoiceDocId: d })) } }} />
                <Button variant="secondary" size="sm" loading={busy === 'upload'} onClick={() => invoiceRef.current?.click()}>{dispatch.invoiceDocId ? '✓' : t('add_photo')}</Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label htmlFor="batch">{t('batch_or_lot')}</Label><Input id="batch" value={dispatch.batch} onChange={(e) => setDispatch((s) => ({ ...s, batch: e.target.value }))} /></div>
                <div><Label htmlFor="tr">{t('transporter_name')}</Label><Input id="tr" value={dispatch.transporter} onChange={(e) => setDispatch((s) => ({ ...s, transporter: e.target.value }))} /></div>
                <div><Label htmlFor="veh">{t('vehicle_number')}</Label><Input id="veh" value={dispatch.vehicle} onChange={(e) => setDispatch((s) => ({ ...s, vehicle: e.target.value.toUpperCase() }))} /></div>
                <div><Label htmlFor="eway">{t('eway_bill_number')}</Label><Input id="eway" inputMode="numeric" value={dispatch.eway} onChange={(e) => setDispatch((s) => ({ ...s, eway: e.target.value.replace(/\D/g, '').slice(0, 12) }))} /></div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setPanel(null)}>{t('back')}</Button>
                <Button
                  className="bg-emerald hover:bg-emerald-ink"
                  loading={busy === 'dispatch'}
                  disabled={!dispatch.photoDocId || !dispatch.invoiceNumber.trim()}
                  onClick={() => act('dispatch', {
                    dispatch: {
                      dispatch_photo_doc_id: dispatch.photoDocId,
                      seller_invoice_number: dispatch.invoiceNumber.trim(),
                      ...(dispatch.invoiceDocId ? { seller_invoice_doc_id: dispatch.invoiceDocId } : {}),
                      ...(dispatch.batch.trim() ? { batch_or_lot: dispatch.batch.trim() } : {}),
                      ...(dispatch.transporter.trim() ? { transporter_name: dispatch.transporter.trim() } : {}),
                      ...(dispatch.vehicle.trim() ? { vehicle_number: dispatch.vehicle.trim() } : {}),
                      ...(dispatch.eway ? { eway_bill_number: dispatch.eway } : {}),
                    },
                  })}
                >
                  {t('action_dispatch')}
                </Button>
              </div>
            </div>
          )}

          {panel === 'deliver' && (
            <div className="space-y-3">
              <Label>{t('delivery_photo')}</Label>
              <input ref={deliveryPhotoRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const d = await upload('delivery_photo', f); if (d) setDeliveryDocId(d) } }} />
              <Button variant="secondary" size="sm" loading={busy === 'upload'} onClick={() => deliveryPhotoRef.current?.click()}>{deliveryDocId ? '✓ ' + t('delivery_photo') : t('add_photo')}</Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setPanel(null)}>{t('back')}</Button>
                <Button className="bg-emerald hover:bg-emerald-ink" loading={busy === 'deliver'} disabled={!deliveryDocId} onClick={() => act('deliver', { deliver: { delivery_photo_doc_id: deliveryDocId } })}>{t('action_deliver')}</Button>
              </div>
            </div>
          )}

          {panel === 'return' && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="rr">{t('return_reason')}</Label>
                <Select id="rr" value={ret.reason} onChange={(e) => setRet((s) => ({ ...s, reason: e.target.value as (typeof RETURN_REASONS)[number] }))}>
                  {RETURN_REASONS.map((r) => <option key={r} value={r}>{t(`return_reason_${r}` as 'return_reason_damaged')}</option>)}
                </Select>
              </div>
              <div><Label htmlFor="rd">{t('return_details')}</Label><Textarea id="rd" rows={3} value={ret.details} onChange={(e) => setRet((s) => ({ ...s, details: e.target.value }))} /></div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setPanel(null)}>{t('back')}</Button>
                <Button variant="danger" loading={busy === 'open_return'} onClick={() => act('open_return', { return: { reason: ret.reason, ...(ret.details.trim() ? { details: ret.details.trim() } : {}) } })}>{t('return_submit')}</Button>
              </div>
            </div>
          )}
          {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
        </SheetCard>
      )}

      {completed && <ReviewSection orderId={id} />}

      {/* Documents */}
      <SheetCard>
        <h2 className="mb-2 text-sm font-semibold text-emerald-ink">{t('documents')}</h2>
        {documents.length === 0 ? (
          <p className="text-sm text-foreground-secondary">—</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between">
                <span className="text-emerald-ink">📎 {d.file_name} <span className="text-xs text-foreground-secondary">({d.kind})</span></span>
                {d.signedUrl && <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="text-emerald underline">{t('download')}</a>}
              </li>
            ))}
          </ul>
        )}
      </SheetCard>

      {/* Gold thread timeline */}
      <SheetCard>
        <h2 className="mb-3 text-sm font-semibold text-emerald-ink">{t('timeline')}</h2>
        <ol className="gold-thread space-y-4 pl-0">
          {events.filter((e) => e.event !== 'placed_side_effects').map((e) => (
            <li key={e.id} className="flex gap-3 text-sm">
              <span className="gold-thread-node" aria-hidden="true" />
              <div>
                <p className="font-medium text-emerald-ink">{EVENT_KEY[e.event] ? t(EVENT_KEY[e.event] as 'event_placed') : e.event.replace(/_/g, ' ')}</p>
                <p className="text-xs text-foreground-secondary">{new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
              </div>
            </li>
          ))}
        </ol>
      </SheetCard>
    </div>
  )
}
