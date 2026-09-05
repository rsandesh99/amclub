'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

type HoldReason = 'no_delivery_photo' | 'awaiting_receipt' | 'return_window_open' | 'return_open'

interface LineItem {
  name: string
  unit: string
  qty: number
  hsn_code: string
  gst_rate_bps: number
  tier_unit_price_paise: number
  line_taxable_paise: number
  line_gst_paise: number
}

interface Dossier {
  gate: { ok: boolean; reasons: HoldReason[]; returnWindowEndsAt: string | null; autoReceiptAt: string | null }
  returnWindowHours: number
  dispatchedAt: string | null
  deliveredPhotoAt: string | null
  buyerReceivedAt: string | null
  autoAcceptedAt: string | null
  returnOpenedAt: string | null
  returnResolvedAt: string | null
  evidenceDocIds: string[]
  lineItems: LineItem[]
}

interface Evidence {
  id: string
  kind: string
  fileName: string
  signedUrl: string | null
}

interface Payout {
  id: string
  status: string
  amount_paise: number | string
  tds_section: string | null
  tds_bps: number | null
  tds_paise: number | string | null
}

interface DeliverySnapshot {
  contact_name?: string
  contact_phone?: string
  address?: string
  city?: string
  state?: string
  pincode?: string
}

interface DossierResponse {
  dossier: Dossier
  evidence: Evidence[]
  payout: Payout | null
  order: {
    id: string
    order_number: string
    status: string
    total_paise: number | string
    provider_earning_paise: number | string
    delivery_snapshot: DeliverySnapshot | null
  }
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i

const fmtIST = (v: string | null | undefined) =>
  v ? `${new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST` : '—'

/**
 * Payout-evidence dossier (MART_DESIGN.md §4.3/§5): the founder's one-tap
 * release sees exactly what the gate sees — the four gate facts, evidence
 * documents, frozen line items and the payout/TDS row. "Release payout" goes
 * through the EXISTING /api/v1/admin/payouts/{id} retry action (RULES.md #5:
 * runPayouts is the only money-out path); a 409 goods_release_gate lists why.
 */
export function MartOrderDossierClient({ id }: { id: string }) {
  const t = useTranslations('admin_mart')
  const { toast } = useToast()
  const [data, setData] = useState<DossierResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState(false)
  const [gateReasons, setGateReasons] = useState<HoldReason[]>([])

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/mart/admin/orders/${id}/dossier`, { cache: 'no-store' })
    const d = await res.json().catch(() => null)
    if (res.ok && d) setData(d as DossierResponse)
    else setNotFound(true)
    setLoading(false)
  }, [id])
  useEffect(() => { load() }, [load])

  async function release(payoutId: string) {
    setBusy(true)
    setGateReasons([])
    try {
      const res = await fetch(`/api/v1/admin/payouts/${payoutId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      })
      const d: { error?: unknown; reasons?: unknown } = await res.json().catch(() => ({}))
      if (res.ok) {
        toast(t('release_done'), 'success')
        await load()
        return
      }
      if (res.status === 409 && d.error === 'goods_release_gate' && Array.isArray(d.reasons)) {
        setGateReasons(d.reasons as HoldReason[])
        toast(t('release_blocked'), 'error')
        return
      }
      toast(typeof d.error === 'string' ? d.error : t('action_failed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
  if (notFound || !data) {
    return (
      <div className="space-y-4">
        <Link href={'/admin/mart' as '/admin/verifications'} className="text-sm text-trust">← {t('back')}</Link>
        <div className="rounded-card border border-border bg-surface p-10 text-center text-sm text-foreground-secondary">{t('dossier_not_found')}</div>
      </div>
    )
  }

  const { dossier, evidence, payout, order } = data
  const receiptAt = dossier.buyerReceivedAt ?? dossier.autoAcceptedAt
  const returnWindowClear = !dossier.gate.reasons.includes('return_window_open')
  const returnOpen = dossier.gate.reasons.includes('return_open')
  const canRelease = payout !== null && (payout.status === 'held' || payout.status === 'failed')
  const snap = order.delivery_snapshot

  const checks: { key: string; ok: boolean; label: string; detail: string }[] = [
    { key: 'photo', ok: !!dossier.deliveredPhotoAt, label: t('check_photo'), detail: fmtIST(dossier.deliveredPhotoAt) },
    {
      key: 'receipt',
      // Receipt counts when the buyer tapped, the cron auto-accepted, or the
      // 72h auto-receipt moment has passed (gate no longer says awaiting_receipt).
      ok: !!receiptAt || (!!dossier.deliveredPhotoAt && !dossier.gate.reasons.includes('awaiting_receipt')),
      label: t('check_receipt'),
      detail: dossier.buyerReceivedAt
        ? `${t('receipt_by_buyer')} · ${fmtIST(dossier.buyerReceivedAt)}`
        : dossier.autoAcceptedAt
          ? `${t('receipt_auto')} · ${fmtIST(dossier.autoAcceptedAt)}`
          : dossier.gate.autoReceiptAt
            ? `${t('auto_receipt_at')} ${fmtIST(dossier.gate.autoReceiptAt)}`
            : '—',
    },
    {
      key: 'window',
      ok: returnWindowClear && !!dossier.deliveredPhotoAt,
      label: t('check_return_window', { hours: dossier.returnWindowHours }),
      detail: dossier.gate.returnWindowEndsAt ? `${t('window_ends_at')} ${fmtIST(dossier.gate.returnWindowEndsAt)}` : '—',
    },
    {
      key: 'return',
      ok: !returnOpen,
      label: t('check_no_return'),
      detail: dossier.returnOpenedAt
        ? `${t('return_opened_at')} ${fmtIST(dossier.returnOpenedAt)}${dossier.returnResolvedAt ? ` · ${t('return_resolved_at')} ${fmtIST(dossier.returnResolvedAt)}` : ''}`
        : t('no_return_opened'),
    },
  ]

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={'/admin/mart' as '/admin/verifications'} className="text-sm text-trust">← {t('back')}</Link>
        <Link href={`/admin/orders/${order.id}` as '/admin/orders'} className="text-sm text-trust hover:underline">{t('open_standard_order')} →</Link>
      </div>

      {/* Order header */}
      <div className="rounded-card border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="font-display text-xl font-bold">{order.order_number}</h1>
            <p className="text-sm text-foreground-secondary">{t('goods_order')} · {order.status}</p>
          </div>
          <Badge variant={dossier.gate.ok ? 'success' : 'warning'}>{dossier.gate.ok ? t('gate_ok') : t('gate_held')}</Badge>
        </div>
        <dl className="mt-3 space-y-1 text-sm">
          <Row label={t('total')} value={formatINR(Number(order.total_paise))} />
          <Row label={t('seller_earning')} value={formatINR(Number(order.provider_earning_paise))} />
          <Row label={t('dispatched_at')} value={fmtIST(dossier.dispatchedAt)} />
          {snap && (
            <Row
              label={t('deliver_to')}
              value={[snap.contact_name, snap.address, snap.city, snap.state, snap.pincode].filter(Boolean).join(', ') || '—'}
            />
          )}
        </dl>
      </div>

      {/* Gate checklist */}
      <div className="rounded-card border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{t('gate_title')}</h2>
        <ul className="space-y-2">
          {checks.map((c) => (
            <li key={c.key} className="flex gap-3 text-sm">
              <span className={`mt-0.5 font-bold ${c.ok ? 'text-success' : 'text-danger'}`} aria-label={c.ok ? t('check_pass') : t('check_fail')}>
                {c.ok ? '✓' : '✗'}
              </span>
              <div>
                <p className="font-medium">{c.label}</p>
                <p className="text-xs text-foreground-secondary">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Evidence */}
      <div className="rounded-card border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{t('evidence_title')}</h2>
        {evidence.length === 0 ? (
          <p className="text-sm text-foreground-secondary">{t('evidence_empty')}</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {evidence.map((e) => (
              <li key={e.id} className="w-32">
                {e.signedUrl ? (
                  <a href={e.signedUrl} target="_blank" rel="noopener noreferrer" className="block">
                    {IMAGE_RE.test(e.fileName) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={e.signedUrl} alt={e.fileName} className="h-24 w-32 rounded-[8px] border border-border object-cover" />
                    ) : (
                      <div className="flex h-24 w-32 items-center justify-center rounded-[8px] border border-border bg-muted text-xs text-foreground-secondary">
                        {t('open_file')}
                      </div>
                    )}
                  </a>
                ) : (
                  <div className="flex h-24 w-32 items-center justify-center rounded-[8px] border border-border bg-muted text-xs text-foreground-secondary">
                    {t('link_unavailable')}
                  </div>
                )}
                <p className="mt-1 truncate text-xs" title={e.fileName}>{e.fileName}</p>
                <p className="text-[11px] text-foreground-secondary">{e.kind.replace(/_/g, ' ')}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Line items */}
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-foreground-secondary">
            <tr>
              <th className="p-3">{t('item')}</th>
              <th className="p-3">{t('hsn')}</th>
              <th className="p-3">{t('qty')}</th>
              <th className="p-3">{t('unit_price')}</th>
              <th className="p-3">{t('gst_rate')}</th>
              <th className="p-3">{t('taxable')}</th>
              <th className="p-3">{t('gst_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {dossier.lineItems.length === 0 ? (
              <tr><td colSpan={7} className="p-6 text-center text-foreground-secondary">{t('no_line_items')}</td></tr>
            ) : (
              dossier.lineItems.map((li, i) => (
                <tr key={`${li.hsn_code}-${i}`} className="border-b border-border last:border-0">
                  <td className="p-3 font-medium">{li.name}</td>
                  <td className="p-3 font-mono text-xs">{li.hsn_code}</td>
                  <td className="p-3 tabular-nums">{li.qty} {li.unit}</td>
                  <td className="p-3 tabular-nums">{formatINR(li.tier_unit_price_paise)}</td>
                  <td className="p-3 tabular-nums">{li.gst_rate_bps / 100}%</td>
                  <td className="p-3 tabular-nums">{formatINR(li.line_taxable_paise)}</td>
                  <td className="p-3 tabular-nums">{formatINR(li.line_gst_paise)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Payout + release */}
      <div className="rounded-card border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{t('payout_title')}</h2>
        {payout ? (
          <>
            <dl className="space-y-1 text-sm">
              <Row label={t('payout_status')} value={payout.status} />
              <Row label={t('payout_amount')} value={formatINR(Number(payout.amount_paise))} />
              <Row label={t('tds_section')} value={payout.tds_section ?? '—'} />
              <Row label={t('tds_rate')} value={payout.tds_bps == null ? '—' : `${payout.tds_bps / 100}%`} />
              <Row label={t('tds_amount')} value={payout.tds_paise == null ? '—' : formatINR(Number(payout.tds_paise))} />
            </dl>
            {canRelease && (
              <div className="mt-4 border-t border-border pt-4">
                <Button onClick={() => release(payout.id)} loading={busy}>{t('release_payout')}</Button>
                <p className="mt-2 text-xs text-foreground-secondary">{t('release_hint')}</p>
              </div>
            )}
            {gateReasons.length > 0 && (
              <div className="mt-3 rounded-[8px] border border-danger/40 bg-danger/10 p-3">
                <p className="text-sm font-semibold text-danger">{t('release_blocked')}</p>
                <ul className="mt-1 list-disc pl-5 text-sm text-danger">
                  {gateReasons.map((r) => <li key={r}>{t(`reason_${r}`)}</li>)}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-foreground-secondary">{t('payout_none')}</p>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-foreground-secondary">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  )
}
