'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX = 2000
const MIN = 20

/**
 * S1.7 — "Your statement" on an open dispute (spine, not flag-gated): one
 * statement per party (textarea with counter, attach from the order's own
 * documents, contact-masking hint), editable until a triage exists; the other
 * party's statement is shown read-only once present.
 */
export function DisputeStatementCard({ orderId, documents }: { orderId: string; documents: { id: string; file_name: string }[] }) {
  const t = useTranslations('orders')
  const [state, setState] = useState<{ statements: any[]; role: 'buyer' | 'provider'; editable: boolean; triageExists: boolean } | null>(null)
  const [body, setBody] = useState('')
  const [docIds, setDocIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/orders/${orderId}/dispute/statement`, { cache: 'no-store' })
    if (!res.ok) return
    const d = await res.json()
    setState(d)
    const mine = (d.statements ?? []).find((s: any) => s.role === d.role)
    if (mine) { setBody(mine.body); setDocIds(mine.document_ids ?? []) }
  }, [orderId])
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  if (!state) return null
  const mine = state.statements.find((s) => s.role === state.role)
  const other = state.statements.find((s) => s.role !== state.role)
  const canWrite = state.editable

  async function save() {
    setBusy(true); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/dispute/statement`, { method: mine ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: body.trim(), document_ids: docIds }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d.error === 'triage_exists' ? t('dispute_statement_locked') : d.error === 'statement_exists' ? t('dispute_statement_saved') : typeof d.error === 'string' ? d.error : t('dispute_statement_failed'))
        await load()
        return
      }
      setNotice(d.redacted ? t('dispute_statement_masked_notice') : t('dispute_statement_saved'))
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{t('dispute_statement_title')}</h2>
        <p className="text-xs text-foreground-secondary">{t('dispute_statement_intro')}</p>
      </div>
      {canWrite ? (
        <>
          <Textarea value={body} onChange={(e) => setBody(e.target.value.slice(0, MAX))} rows={5} placeholder={t('dispute_statement_placeholder')} />
          <p className="text-[11px] text-foreground-secondary">{t('dispute_statement_masking_hint')} · {body.length}/{MAX}</p>
          {documents.length > 0 && (
            <div>
              <p className="text-xs font-medium">{t('dispute_statement_attach')}</p>
              <div className="flex flex-wrap gap-2 pt-1">{documents.map((d) => {
                const on = docIds.includes(d.id)
                return <button key={d.id} type="button" onClick={() => setDocIds((cur) => (on ? cur.filter((x) => x !== d.id) : cur.length < 5 ? [...cur, d.id] : cur))} aria-pressed={on} className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-primary bg-primary text-white' : 'border-border'}`}>📎 {d.file_name}</button>
              })}</div>
            </div>
          )}
          <Button onClick={save} loading={busy} disabled={body.trim().length < MIN}>{mine ? t('dispute_statement_update') : t('dispute_statement_submit')}</Button>
          {body.trim().length > 0 && body.trim().length < MIN && <p className="text-[11px] text-foreground-secondary">{t('dispute_statement_min')}</p>}
        </>
      ) : mine ? (
        <div className="rounded-button border border-border p-3 text-sm">
          <p className="text-xs font-semibold text-foreground-secondary">{t('dispute_statement_yours')}{state.triageExists ? ` · ${t('dispute_statement_locked')}` : ''}</p>
          <p className="mt-1 whitespace-pre-wrap">{mine.body}</p>
        </div>
      ) : null}
      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-xs text-success">{notice}</p>}
      <div className="rounded-button border border-border bg-background p-3 text-sm">
        <p className="text-xs font-semibold text-foreground-secondary">{t('dispute_statement_other_title')}</p>
        {other ? <p className="mt-1 whitespace-pre-wrap">{other.body}</p> : <p className="mt-1 text-foreground-secondary">{t('dispute_statement_other_none')}</p>}
      </div>
    </div>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */
