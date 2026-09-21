'use client'

import { useEffect, useState, useCallback, use } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Dispute console (§5.4 / §9.2) + the S1.7 triage card. The card sits ABOVE the
 * resolution controls, names a recommendation CLASS with confidence and never
 * pre-selects a button or prefills a rupee value; the founder's click on the
 * existing resolve route (now carrying the triage id) is the decision.
 */
export default function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('admin_ops')
  const router = useRouter()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [partialRupees, setPartialRupees] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showThread, setShowThread] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/admin/disputes/${id}`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [id])
  useEffect(() => { load() }, [load])

  async function resolve(resolution: string) {
    setBusy(true); setError('')
    const body: any = { resolution }
    if (resolution === 'refund_partial') body.amountPaise = Math.round(Number(partialRupees) * 100)
    // S1.7 — link the click to the card the founder had open (after settlement; never a precondition).
    if (data?.triage?.id) body.triage_id = data.triage.id
    const res = await fetch(`/api/v1/admin/disputes/${id}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d = await res.json()
    setBusy(false)
    if (!res.ok) { setError(typeof d.error === 'string' ? d.error : t('action_failed')); return }
    await load()
  }

  if (loading || !data) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>
  const { dispute, order, events, payment, payout, refund } = data
  const statements: any[] = data.statements ?? []
  const thread: any[] = data.thread ?? []
  const documents: any[] = data.documents ?? []
  const triage: any = data.triage ?? null
  const history: any[] = data.triage_history ?? []
  const agentSurface = 'triage' in data
  const resolved = dispute.status === 'resolved'
  const total = Number(order?.total_paise ?? 0)
  const docName = (docId: string) => documents.find((d) => d.id === docId)?.file_name ?? docId.slice(0, 8)
  const refLabel = (ref: string) => {
    const [kind, rest] = ref.split(':', 2)
    if (kind === 'doc') return `📎 ${docName(rest ?? '')}`
    if (kind === 'statement') return `🗣 ${t(statements.find((s) => s.id === rest)?.role === 'provider' ? 'triage_party_provider' : 'triage_party_buyer')}`
    if (kind === 'event') return `⏱ ${String(events.find((e: any) => e.id === rest)?.event ?? rest).replace(/_/g, ' ')}`
    if (kind === 'milestone') return `📍 ${String(rest).replace(/_/g, ' ')}`
    if (kind === 'message') return `💬 ${t('thread_title')}`
    return ref
  }
  const refHref = (ref: string) => {
    const [kind, rest] = ref.split(':', 2)
    return kind === 'doc' ? `#doc-${rest}` : kind === 'statement' ? `#stmt-${rest}` : kind === 'event' ? `#ev-${rest}` : kind === 'message' ? '#thread' : '#timeline'
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button onClick={() => router.push('/admin/disputes')} className="text-sm text-trust">← {t('back')}</button>
      <h1 className="font-display text-xl font-bold">{t('order')} {order?.order_number}</h1>

      {/* Amounts */}
      <div className="rounded-card border border-border bg-surface p-4 text-sm">
        <Row label={t('total')} value={formatINR(total)} />
        <Row label={t('provider')} value={formatINR(Number(order?.provider_earning_paise ?? 0))} />
        <Row label={t('payment')} value={payment ? `${payment.status} · ${formatINR(Number(payment.amount_paise))}` : '—'} />
        <Row label={t('payout')} value={payout ? `${payout.status} · ${formatINR(Number(payout.amount_paise))}` : '—'} />
        <Row label={t('manual_refund')} value={refund ? `${refund.status} · ${formatINR(Number(refund.amount_paise))}` : '—'} />
      </div>

      {/* S1.7 — Triage card (recommendation only; never a pre-selected resolution) */}
      {triage ? (
        <div className="rounded-card border border-primary/30 bg-primary/5 p-4 space-y-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('triage_title')}</h2>
            <span className="text-xs text-foreground-secondary">
              {t('triage_generated_from', { n: statements.length })} · {t('triage_cost', { amount: formatINR(Number(triage.model_cost_paise ?? 0)) })}{triage.stub ? ` · ${t('triage_stub')}` : ''}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-primary/40 bg-surface px-3 py-1 text-sm font-medium text-primary">
              {t('triage_recommendation')}: {t(`triage_rec_${triage.triage.recommendation}` as 'triage_rec_release')}
            </span>
            <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs">{t(`triage_confidence_${triage.triage.confidence}` as 'triage_confidence_low')}</span>
            {triage.triage.partial_band && <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning">{t('triage_band', { band: String(triage.triage.partial_band).replace('_', '–') + ' %' })}</span>}
            {triage.decision && <span className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs text-success">{t('triage_decided', { decision: t(triage.decision as 'release') })}</span>}
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground-secondary">{t('triage_rationale')}</p>
            <ul className="list-disc pl-5">{triage.triage.rationale.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
          </div>
          {triage.triage.timeline.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-foreground-secondary">{t('triage_timeline')}</p>
              <ol className="space-y-1">{triage.triage.timeline.map((e: any, i: number) => (
                <li key={i} className="flex gap-2"><span className="shrink-0 text-xs text-foreground-secondary">{new Date(e.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span><a href={refHref(e.ref)} className="underline-offset-2 hover:underline">{e.what}</a></li>
              ))}</ol>
            </div>
          )}
          {(['buyer', 'provider'] as const).map((party) => {
            const claims = triage.triage.claims.filter((c: any) => c.party === party)
            if (claims.length === 0) return null
            return (
              <div key={party}>
                <p className="text-xs font-semibold text-foreground-secondary">{t('triage_claims')} · {t(`triage_party_${party}`)}</p>
                <ul className="space-y-1.5">{claims.map((c: any, i: number) => (
                  <li key={i} className="rounded-button border border-border bg-surface p-2">
                    <p>{c.claim} <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${c.assessment === 'supported' ? 'bg-success/10 text-success' : c.assessment === 'contradicted' ? 'bg-danger/10 text-danger' : 'bg-muted text-foreground-secondary'}`}>{t(`triage_assessment_${c.assessment}` as 'triage_assessment_supported')}</span></p>
                    {c.evidence.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1">{c.evidence.map((ev: any, j: number) => (
                        <a key={j} href={refHref(ev.ref)} className={`rounded-full border px-2 py-0.5 text-[11px] ${ev.supports === 'supports' ? 'border-success/40' : ev.supports === 'contradicts' ? 'border-danger/40' : 'border-border'}`} title={t(`triage_supports_${ev.supports}` as 'triage_supports_supports')}>{refLabel(ev.ref)}</a>
                      ))}</p>
                    )}
                  </li>
                ))}</ul>
              </div>
            )
          })}
          {triage.triage.gaps.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-foreground-secondary">{t('triage_gaps')}</p>
              <ul className="list-disc pl-5">{triage.triage.gaps.map((g: string, i: number) => <li key={i}>{g}</li>)}</ul>
            </div>
          )}
          <div>
            <p className="text-xs font-semibold text-foreground-secondary">{t('triage_checks')}</p>
            <p className="flex flex-wrap gap-1 pt-1">{(triage.checks ?? []).map((c: any) => (
              <span key={c.name} className={`rounded-full border px-2 py-0.5 text-[11px] ${c.ok ? 'border-border text-foreground-secondary' : 'border-warning/40 bg-warning/10 text-warning'}`} title={c.detail ?? ''}>{c.ok ? '✓' : '!'} {String(c.name).replace(/_/g, ' ')}</span>
            ))}</p>
          </div>
          {history.length > 1 && (
            <div>
              <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-xs text-primary underline underline-offset-2">{t('triage_history', { n: history.length - 1 })}</button>
              {showHistory && <ul className="mt-1 text-xs text-foreground-secondary">{history.filter((h) => h.id !== triage.id).map((h) => <li key={h.id}>{new Date(h.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · {t(`triage_rec_${h.recommendation}` as 'triage_rec_release')}{h.decision ? ` · ${t(h.decision as 'release')}` : ''}</li>)}</ul>}
            </div>
          )}
        </div>
      ) : agentSurface && !resolved ? (
        <p className="text-xs text-foreground-secondary">{t('triage_pending')}</p>
      ) : null}

      {/* Resolution — unchanged controls; never pre-selected, never prefilled */}
      {resolved ? (
        <div className="rounded-card border border-success/30 bg-success/10 p-4 text-sm">
          <p className="font-medium text-success">{t('resolved_ok')}</p>
          <p className="mt-1">{t(dispute.resolution as 'refund_full')} · {t('buyer_refund')}: {formatINR(Number(dispute.resolution_amount_paise ?? 0))}</p>
        </div>
      ) : (
        <div className="rounded-card border border-border bg-surface p-4 space-y-3">
          <h2 className="text-sm font-semibold">{t('resolve')}</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => resolve('refund_full')} loading={busy}>{t('refund_full')}</Button>
            <Button onClick={() => resolve('release')} loading={busy}>{t('release')}</Button>
          </div>
          <div className="flex items-end gap-2 border-t border-border pt-3">
            <label className="flex-1 text-xs">{t('partial_amount')}
              <input type="number" value={partialRupees} onChange={(e) => setPartialRupees(e.target.value)} className="mt-1 w-full rounded-button border border-border bg-background p-2 text-sm" placeholder={`≤ ${formatINR(total)}`} />
            </label>
            <Button variant="outline" onClick={() => resolve('refund_partial')} loading={busy} disabled={!partialRupees}>{t('refund_partial')}</Button>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}

      {/* S1.7 — Party statements (verbatim, redacted) */}
      <div className="rounded-card border border-border bg-surface p-4 space-y-3">
        <h2 className="text-sm font-semibold">{t('statements_title')}</h2>
        {(['buyer', 'provider'] as const).map((party) => {
          const s = statements.find((x) => x.role === party)
          return (
            <div key={party} id={s ? `stmt-${s.id}` : undefined} className="rounded-button border border-border p-3 text-sm">
              <p className="text-xs font-semibold text-foreground-secondary">{t(`statement_by_${party}`)}{s?.redacted ? ` · ${t('statement_masked')}` : ''}{s ? ` · ${new Date(s.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}</p>
              {s ? <p className="mt-1 whitespace-pre-wrap">{s.body}</p> : <p className="mt-1 text-foreground-secondary">{t('statement_none')}</p>}
              {s && s.document_ids?.length > 0 && <p className="mt-1 text-xs">{t('statement_docs')}: {s.document_ids.map((d: string) => <a key={d} href={`#doc-${d}`} className="mr-2 underline underline-offset-2">📎 {docName(d)}</a>)}</p>}
            </div>
          )
        })}
        {thread.length > 0 && (
          <div id="thread">
            <button type="button" onClick={() => setShowThread((v) => !v)} className="text-xs text-primary underline underline-offset-2">{t('thread_title')} ({thread.length})</button>
            {showThread && <ul className="mt-1 space-y-1 text-xs">{thread.map((m: any) => <li key={m.id}><span className="text-foreground-secondary">{t(`triage_party_${m.sender_role === 'provider' ? 'provider' : 'buyer'}`)} · {new Date(m.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}:</span> {m.body}</li>)}</ul>}
          </div>
        )}
      </div>

      {/* Documents */}
      {documents.length > 0 && (
        <div className="rounded-card border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold">{t('documents')}</h2>
          <ul className="space-y-1 text-sm">{documents.map((d: any) => <li key={d.id} id={`doc-${d.id}`}>📎 {d.file_name} <span className="text-xs text-foreground-secondary">({d.kind})</span></li>)}</ul>
        </div>
      )}

      {/* Timeline */}
      <div id="timeline" className="rounded-card border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold">{t('timeline')}</h2>
        <ol className="space-y-2">
          {events.map((e: any) => (
            <li key={e.id} id={`ev-${e.id}`} className="flex gap-2 text-sm">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
              <div>
                <p className="capitalize">{String(e.event).replace(/_/g, ' ')}</p>
                <p className="text-xs text-foreground-secondary">{new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between border-b border-border py-1.5 last:border-0"><span className="text-foreground-secondary">{label}</span><span className="tabular-nums">{value}</span></div>
}
/* eslint-enable @typescript-eslint/no-explicit-any */
