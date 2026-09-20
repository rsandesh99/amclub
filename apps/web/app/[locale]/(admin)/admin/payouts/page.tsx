'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { PAYOUT_STATUSES } from '@amclub/shared'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { ReadinessBadge } from '@/components/admin/ReadinessBadge'
import { DossierPanel } from '@/components/admin/DossierPanel'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Phase 8 §7 — payout monitor queue (the unmet P7 claim): every payout by
 *  state with order/provider context; failed|held rows get a retry action.
 *  Phase 3a/3c: readiness badge on rows whose provider cannot be paid yet,
 *  days-pending (oldest first for open statuses) + hold reasons. Default view
 *  is 'held' — with PAYOUT_AUTO_RELEASE off that is the founder's worklist.
 *  S1.4: rows with a payout dossier get a Dossier button (the list route only
 *  returns `dossier` while AGENT_ENABLED); `?dossier=<id>&action=approve|hold`
 *  opens that dossier with the action focused — never auto-submitted. */
export default function AdminPayoutsPage() {
  const t = useTranslations('admin_ops')
  const { toast } = useToast()
  const [status, setStatus] = useState<string>('held')
  const [payouts, setPayouts] = useState<any[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [openDossier, setOpenDossier] = useState<{ id: string; action: 'approve' | 'hold' | null } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/v1/admin/payouts${status ? `?status=${status}` : ''}`, { cache: 'no-store' })
      // Drain the body on every status — an unread response never finishes.
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        return r.ok && d ? d : { payouts: [], counts: {} }
      })
      .then((d) => { setPayouts(d.payouts ?? []); setCounts(d.counts ?? {}) })
      .finally(() => setLoading(false))
  }, [status])

  useEffect(() => { load() }, [load])

  // Deep link from the founder notification: /admin/payouts?dossier=<id>&action=approve|hold
  useEffect(() => {
    if (typeof window === 'undefined') return
    const sp = new URLSearchParams(window.location.search)
    const id = sp.get('dossier')
    if (!id) return
    const a = sp.get('action')
    setOpenDossier({ id, action: a === 'approve' || a === 'hold' ? a : null })
  }, [])

  async function retry(id: string) {
    setBusy(id)
    const res = await fetch(`/api/v1/admin/payouts/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    })
    setBusy(null)
    if (res.ok) {
      toast(t('payout_retried'), 'success')
      load()
    } else {
      const d = await res.json().catch(() => ({}))
      toast(typeof d.error === 'string' ? d.error : t('action_failed'), 'error')
    }
  }

  const fmtIST = (v: string | null) =>
    v ? new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-bold">{t('payouts_title')}</h1>

      <div className="flex flex-wrap gap-1">
        {['', ...PAYOUT_STATUSES].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStatus(s)}
            className={`rounded-button px-3 py-1.5 text-sm ${status === s ? 'bg-primary text-white' : 'border border-border'}`}
          >
            {s ? t(`payout_${s}` as 'payout_failed') : t('all')}
            {s ? ` (${counts[s] ?? 0})` : ''}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : payouts.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-10 text-center text-sm text-foreground-secondary">{t('payouts_empty')}</div>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-foreground-secondary">
              <tr>
                <th className="p-3">{t('order')}</th>
                <th className="p-3">{t('provider')}</th>
                <th className="p-3">{t('amount')}</th>
                <th className="p-3">{t('status')}</th>
                <th className="p-3">{t('days_pending')}</th>
                <th className="p-3">{t('scheduled_for')}</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="p-3">
                    <Link href={`/admin/orders/${p.order?.id}` as '/admin/orders'} className="font-medium text-trust hover:underline">
                      {p.order?.order_number}
                    </Link>
                    <p className="max-w-[16rem] truncate text-xs text-foreground-secondary">{p.order?.title}</p>
                  </td>
                  <td className="p-3">
                    <Link href={`/admin/providers/${p.provider?.id}` as '/admin/providers'} className="hover:underline">{p.provider?.display_name}</Link>
                    {p.provider?.status !== 'active' && (
                      <span className="ml-1.5 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">{p.provider?.status}</span>
                    )}
                    {/* Phase 3a — a release tap on this row would FAIL: say so before the tap. */}
                    {p.readiness !== 'ready' && (
                      <p className="mt-1"><ReadinessBadge readiness={p.readiness} /></p>
                    )}
                  </td>
                  <td className="p-3 font-semibold">{formatINR(Number(p.amount_paise))}</td>
                  <td className="p-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        p.status === 'paid'
                          ? 'bg-success-soft text-success'
                          : p.status === 'failed'
                            ? 'bg-danger-soft text-danger'
                            : p.status === 'held'
                              ? 'bg-warning-soft text-warning'
                              : 'bg-muted text-foreground-secondary'
                      }`}
                    >
                      {t(`payout_${p.status}` as 'payout_failed')}
                    </span>
                    {/* Phase 3c — why it is held (from the payout_held order_event). */}
                    {p.hold_reasons?.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {p.hold_reasons.map((r: string) => (
                          <span key={r} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground-secondary">{t(`hold_${r}` as 'hold_approval_gate')}</span>
                        ))}
                      </p>
                    )}
                  </td>
                  <td className="p-3 text-sm">
                    {p.days_pending == null ? '—' : (
                      <span className={p.days_pending >= 7 ? 'font-semibold text-danger' : p.days_pending >= 3 ? 'font-semibold text-warning' : ''}>
                        {t('days_n', { n: p.days_pending })}
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-xs text-foreground-secondary">
                    {p.status === 'paid' ? fmtIST(p.paid_at) : fmtIST(p.scheduled_for)}
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {/* S1.4 — the agent's dossier for this payout (only present while AGENT_ENABLED). */}
                      {p.dossier && (
                        <Button size="sm" variant={p.dossier.decision ? 'ghost' : 'outline'} onClick={() => setOpenDossier({ id: p.dossier.id, action: null })}>
                          {p.dossier.decision
                            ? t('dossier_row_decided', { decision: t(p.dossier.decision === 'approve' ? 'dossier_rec_approve' : 'dossier_rec_hold') })
                            : t('dossier_row_label', { rec: t(p.dossier.recommendation === 'approve' ? 'dossier_rec_approve' : 'dossier_rec_hold') })}
                        </Button>
                      )}
                      {(p.status === 'failed' || p.status === 'held') && (
                        <Button size="sm" variant="outline" onClick={() => retry(p.id)} loading={busy === p.id}>
                          {t('retry_payout')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openDossier && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t('dossier_title')}>
          <div className="my-8 w-full max-w-3xl rounded-card border border-border bg-surface p-4 shadow-card">
            <DossierPanel
              dossierId={openDossier.id}
              initialAction={openDossier.action}
              onClose={() => setOpenDossier(null)}
              onChanged={load}
            />
          </div>
        </div>
      )}
    </div>
  )
}
