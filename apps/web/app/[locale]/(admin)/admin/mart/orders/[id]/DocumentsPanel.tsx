'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/toast'
import type { DocumentsDraft } from '@/lib/mart/documents-agent'

/**
 * Documents Agent v1 panel — draft on demand, correct the two transport
 * fields the e-way bill needs, confirm → ai_decisions('documents_draft').
 */
export function DocumentsPanel({ orderId }: { orderId: string }) {
  const t = useTranslations('admin_mart')
  const { toast } = useToast()
  const [draft, setDraft] = useState<DocumentsDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [transport, setTransport] = useState({ transporter_name: '', vehicle_number: '' })
  const [done, setDone] = useState(false)

  async function load() {
    setBusy(true)
    try {
      const res = await fetch(`/api/v1/mart/admin/orders/${orderId}/documents`, { cache: 'no-store' })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d) { toast(t('action_failed'), 'error'); return }
      setDraft(d.draft)
      setTransport({ transporter_name: d.draft.eway_bill.transport.transporter_name ?? '', vehicle_number: d.draft.eway_bill.transport.vehicle_number ?? '' })
    } finally { setBusy(false) }
  }
  async function confirm() {
    if (!draft) return
    setBusy(true)
    try {
      const final = { ...draft, eway_bill: { ...draft.eway_bill, transport: { ...draft.eway_bill.transport, ...transport } } }
      const finalBody = Object.fromEntries(Object.entries(final).filter(([k]) => !['order_id', 'order_number', 'warnings'].includes(k)))
      const res = await fetch(`/api/v1/mart/admin/orders/${orderId}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ final: finalBody, ...(note ? { note } : {}) }) })
      if (!res.ok) { toast(t('action_failed'), 'error'); return }
      setDone(true)
      toast(t('documents_confirmed'), 'success')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <h2 className="font-semibold">{t('documents_title')}</h2>
      <p className="mt-1 text-xs text-foreground-secondary">{t('documents_subtitle')}</p>
      {!draft ? (
        <Button className="mt-3" variant="outline" onClick={load} loading={busy}>{t('documents_load')}</Button>
      ) : (
        <div className="mt-3 space-y-4 text-sm">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('invoice_summary')}</h3>
            <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
              <div><dt className="text-foreground-secondary">{t('supplier')}</dt><dd>{draft.invoice.supplier.name} · {draft.invoice.supplier.gstin ?? '—'} · {draft.invoice.supplier.state ?? '—'}</dd></div>
              <div><dt className="text-foreground-secondary">{t('buyer')}</dt><dd>{draft.invoice.buyer.name} · {draft.invoice.buyer.gstin ?? '—'} · {draft.invoice.buyer.state ?? '—'}</dd></div>
              <div><dt className="text-foreground-secondary">{t('place_of_supply')}</dt><dd>{draft.invoice.place_of_supply ?? '—'}</dd></div>
              <div><dt className="text-foreground-secondary">{t('tax_type')}</dt><dd>{draft.invoice.tax_type}</dd></div>
            </dl>
            <table className="mt-2 w-full text-xs">
              <thead className="text-left text-foreground-secondary"><tr><th className="py-1 pr-2">HSN</th><th className="py-1 pr-2">Item</th><th className="py-1 pr-2 text-right">Qty</th><th className="py-1 pr-2 text-right">Taxable</th><th className="py-1 text-right">GST</th></tr></thead>
              <tbody>
                {draft.invoice.lines.map((l, i) => (
                  <tr key={i} className="border-t border-border"><td className="py-1 pr-2 font-mono">{l.hsn}</td><td className="py-1 pr-2">{l.description}</td><td className="py-1 pr-2 text-right tabular-nums">{l.qty} {l.unit}</td><td className="py-1 pr-2 text-right tabular-nums">{formatINR(l.taxable_paise)}</td><td className="py-1 text-right tabular-nums">{formatINR(l.gst_paise)} ({l.gst_rate_bps / 100}%)</td></tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-right font-semibold tabular-nums">{formatINR(draft.invoice.total_paise)}</p>
          </div>
          <div>
            <p className={`font-medium ${draft.eway_bill.required ? 'text-warning' : 'text-foreground-secondary'}`}>{draft.eway_bill.required ? t('eway_required') : t('eway_not_required')}</p>
            {draft.eway_bill.required && draft.eway_bill.missing.length > 0 && <p className="text-xs text-danger">{t('eway_missing', { fields: draft.eway_bill.missing.join(', ') })}</p>}
            {draft.eway_bill.required && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div><Label htmlFor="tn">Transporter</Label><Input id="tn" value={transport.transporter_name} onChange={(e) => setTransport((s) => ({ ...s, transporter_name: e.target.value }))} /></div>
                <div><Label htmlFor="vn">Vehicle number</Label><Input id="vn" value={transport.vehicle_number} onChange={(e) => setTransport((s) => ({ ...s, vehicle_number: e.target.value.toUpperCase() }))} /></div>
              </div>
            )}
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('payout_advice')}</h3>
            <p className="mt-1">{draft.payout_advice.text}</p>
          </div>
          {draft.warnings.length > 0 && <p className="text-xs text-warning">{t('documents_warnings')}: {draft.warnings.join(', ')}</p>}
          <div className="border-t border-border pt-3">
            <Label htmlFor="dn">{t('documents_note')}</Label>
            <Input id="dn" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button className="mt-2" onClick={confirm} loading={busy} disabled={done}>{done ? t('documents_confirmed') : t('documents_confirm')}</Button>
          </div>
        </div>
      )}
    </div>
  )
}
