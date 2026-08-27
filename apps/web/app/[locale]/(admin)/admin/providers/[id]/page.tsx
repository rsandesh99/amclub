'use client'

import { useEffect, useState, useCallback, use } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('admin_ops')
  const router = useRouter()
  const { toast } = useToast()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [badgeKind, setBadgeKind] = useState('')

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/admin/providers/${id}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [id])
  useEffect(() => { load() }, [load])

  async function act(body: any) {
    setBusy(true)
    const res = await fetch(`/api/v1/admin/providers/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setBusy(false)
    if (res.ok) { await load(); toast(t('action_done'), 'success') }
    else { const d = await res.json().catch(() => ({})); toast(typeof d.error === 'string' ? d.error : t('action_failed'), 'error') }
  }

  function suspend() {
    const reason = window.prompt(t('suspend_reason'))
    if (reason && reason.trim()) act({ action: 'suspend', reason: reason.trim() })
  }

  function setBankVerified(verified: boolean) {
    const reason = window.prompt(t('bank_override_reason'))
    if (reason && reason.trim().length >= 5) act({ action: 'set_bank_verified', verified, reason: reason.trim() })
  }

  if (loading || !data) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
  const p = data.provider

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <button onClick={() => router.push('/admin/providers')} className="text-sm text-trust">← {t('back')}</button>

      <div className="flex items-start justify-between rounded-card border border-border bg-surface p-4">
        <div>
          <h1 className="font-display text-xl font-bold">{p.display_name}</h1>
          <p className="text-sm text-foreground-secondary">{p.legal_name} · {p.state} · {p.status}{p.capacity_paused ? ` · ${t('paused')}` : ''}</p>
          <p className="mt-1 text-sm">★ {p.avg_rating} ({p.review_count}) · {t('earnings')}: {formatINR(data.earningsPaise)}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="rounded-card border border-border bg-surface p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {p.status === 'suspended'
            ? <Button onClick={() => act({ action: 'reactivate' })} loading={busy}>{t('reactivate')}</Button>
            : <Button variant="danger" onClick={suspend} loading={busy}>{t('suspend')}</Button>}
          <Button variant="outline" onClick={() => act({ action: 'set_capacity_pause', paused: !p.capacity_paused })} loading={busy}>
            {p.capacity_paused ? t('unpause') : t('pause')}
          </Button>
        </div>
        {/* Bank verification — manual override until the real penny-drop vendor is live (Phase 1g). */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-sm">
            {t('bank_label')}:{' '}
            <span className={data.bank?.pennyDropVerified ? 'font-medium text-success' : 'font-medium text-warning'}>
              {!data.bank?.onFile ? t('bank_none') : data.bank.pennyDropVerified ? t('bank_verified') : t('bank_unverified')}
            </span>
            {data.bank?.onFile && !data.bank.hasRouteAccount && (
              <span className="ml-2 text-xs text-foreground-secondary">{t('bank_no_route')}</span>
            )}
          </span>
          {data.bank?.onFile && (
            data.bank.pennyDropVerified
              ? <Button variant="outline" onClick={() => setBankVerified(false)} loading={busy}>{t('bank_revoke')}</Button>
              : <Button variant="outline" onClick={() => setBankVerified(true)} loading={busy}>{t('bank_mark_verified')}</Button>
          )}
        </div>
        <div className="flex items-end gap-2 border-t border-border pt-3">
          <label className="flex-1 text-xs">{t('badge')}
            <input value={badgeKind} onChange={(e) => setBadgeKind(e.target.value)} placeholder="icai / gstin / msme_cert" className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" />
          </label>
          <Button variant="outline" onClick={() => badgeKind && act({ action: 'set_badge', kind: badgeKind, grant: true })} loading={busy} disabled={!badgeKind}>{t('grant')}</Button>
          <Button variant="outline" onClick={() => badgeKind && act({ action: 'set_badge', kind: badgeKind, grant: false })} loading={busy} disabled={!badgeKind}>{t('revoke')}</Button>
        </div>
      </div>

      {/* Verifications */}
      <Section title={t('verifications')}>
        {data.verifications.length === 0 ? <Empty label={t('none')} /> : data.verifications.map((v: any) => (
          <div key={v.id} className="flex justify-between text-sm"><span>{v.kind}</span><span className="text-foreground-secondary">{v.status}</span></div>
        ))}
      </Section>

      {/* Listings */}
      <Section title={t('listings')}>
        {data.listings.length === 0 ? <Empty label={t('none')} /> : data.listings.map((l: any) => (
          <div key={l.id} className="flex justify-between text-sm"><span>{l.title_i18n?.en ?? l.slug}</span><span className="text-foreground-secondary">{formatINR(Number(l.price_paise))} · {l.status}</span></div>
        ))}
      </Section>

      {/* Recent orders */}
      <Section title={t('orders_title')}>
        {data.orders.length === 0 ? <Empty label={t('none')} /> : data.orders.slice(0, 10).map((o: any) => (
          <div key={o.id} className="flex justify-between text-sm"><span>{o.order_number}</span><span className="text-foreground-secondary">{o.status} · {formatINR(Number(o.total_paise))}</span></div>
        ))}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-card border border-border bg-surface p-4"><h2 className="mb-2 text-sm font-semibold">{title}</h2><div className="space-y-1.5">{children}</div></div>
}
function Empty({ label }: { label: string }) { return <p className="text-sm text-foreground-secondary">{label}</p> }
/* eslint-enable @typescript-eslint/no-explicit-any */
