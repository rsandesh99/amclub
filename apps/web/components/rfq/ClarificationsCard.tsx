'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { MessageCircleQuestion } from 'lucide-react'
import {
  CLARIFICATION_ANSWER_MAX,
  CLARIFICATION_MAX_OPEN_PER_PROVIDER,
  CLARIFICATION_QUESTION_MAX,
  CLARIFICATION_QUESTION_MIN,
  openQuestionCount,
  sortClarifications,
  type ClarificationView,
} from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export interface ClarificationsCardProps {
  rfqId: string
  role: 'buyer' | 'provider'
  initial: ClarificationView[]
  /** Provider: matched, not declined, RFQ active. Buyer: RFQ active (answers allowed). */
  canWrite: boolean
  /** RFQ closed → the thread is read-only (§3.8 state). */
  closed: boolean
}

/**
 * S1.3 — the RFQ-level clarification thread. One component, two readings:
 *   provider → "Ask before quoting" (≤ 3 open at a time, contact masking hint)
 *              plus every provider's questions with "you asked" on mine;
 *   buyer    → "Questions from providers": unanswered first with an inline
 *              answer box, answered ones collapsed with Q/A and IST times.
 * No status text changes anywhere: "in clarification" is derived on the page.
 */
export function ClarificationsCard({ rfqId, role, initial, canWrite, closed }: ClarificationsCardProps) {
  const t = useTranslations('rfq')
  const locale = useLocale()
  const router = useRouter()
  const [items, setItems] = useState<ClarificationView[]>(() => sortClarifications(initial))
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const myOpen = useMemo(() => items.filter((c) => c.mine && c.answeredAt === null).length, [items])
  const capReached = role === 'provider' && myOpen >= CLARIFICATION_MAX_OPEN_PER_PROVIDER
  const fmt = useMemo(
    () => new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
    [locale],
  )

  async function ask() {
    setError('')
    const q = question.trim()
    if (q.length < CLARIFICATION_QUESTION_MIN) { setError(t('clarify_err_short', { min: CLARIFICATION_QUESTION_MIN })); return }
    setBusy(true)
    try {
      const res = await fetch(`/api/v1/rfq/${rfqId}/clarifications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (d.error === 'clarification_cap') throw new Error(t('clarify_cap_reached', { max: CLARIFICATION_MAX_OPEN_PER_PROVIDER }))
        if (d.error === 'rfq_closed') throw new Error(t('clarify_closed'))
        throw new Error(t('clarify_err_generic'))
      }
      setItems((cur) => sortClarifications([d.clarification as ClarificationView, ...cur]))
      setQuestion('')
      if ((d.clarification as ClarificationView).questionRedacted) setNotice(t('clarify_redacted_notice'))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('clarify_err_generic'))
    } finally {
      setBusy(false)
    }
  }

  const open = openQuestionCount(items)

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card space-y-4" aria-labelledby="clarify-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="clarify-heading" className="flex items-center gap-2 text-sm font-semibold">
            <MessageCircleQuestion className="h-4 w-4 text-primary" aria-hidden />
            {role === 'buyer' ? t('clarify_title_buyer') : t('clarify_title_provider')}
          </h2>
          <p className="mt-1 text-xs text-foreground-secondary">{t('clarify_visible_hint')}</p>
        </div>
        {role === 'buyer' && open > 0 && !closed && (
          <span className="rounded-chip border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">{t('clarify_waiting_badge', { n: open })}</span>
        )}
      </div>

      {role === 'provider' && !closed && canWrite && (
        <div className="space-y-2 rounded-button border border-border bg-muted/30 p-3">
          <Textarea
            id="clarify-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value.slice(0, CLARIFICATION_QUESTION_MAX))}
            rows={3}
            maxLength={CLARIFICATION_QUESTION_MAX}
            placeholder={t('clarify_ask_placeholder')}
            disabled={capReached || busy}
            aria-label={t('clarify_title_provider')}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-foreground-secondary">
            <span>{t('clarify_ask_hint_cap', { max: CLARIFICATION_MAX_OPEN_PER_PROVIDER })} · {t('clarify_ask_hint_masking')}</span>
            <span className="tabular-nums">{question.length}/{CLARIFICATION_QUESTION_MAX}</span>
          </div>
          {capReached ? (
            <p className="text-xs text-warning" role="status">{t('clarify_cap_reached', { max: CLARIFICATION_MAX_OPEN_PER_PROVIDER })}</p>
          ) : (
            <Button size="sm" onClick={ask} loading={busy} disabled={question.trim().length < CLARIFICATION_QUESTION_MIN}>{t('clarify_ask_button')}</Button>
          )}
        </div>
      )}
      {closed && <p className="text-xs text-foreground-secondary">{t('clarify_closed')}</p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {notice && <p className="text-xs text-foreground-secondary" role="status">{notice}</p>}

      {items.length === 0 ? (
        <p className="rounded-button border border-dashed border-border px-4 py-6 text-center text-sm text-foreground-secondary">{t('clarify_empty')}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((c) => (
            <li key={c.id}>
              <ClarificationItem
                c={c}
                role={role}
                rfqId={rfqId}
                canAnswer={role === 'buyer' && canWrite && !closed}
                fmt={fmt}
                onAnswered={(updated) => setItems((cur) => sortClarifications(cur.map((x) => (x.id === updated.id ? updated : x))))}
                onRace={() => { setNotice(t('clarify_err_race')); router.refresh() }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ClarificationItem({ c, role, rfqId, canAnswer, fmt, onAnswered, onRace }: {
  c: ClarificationView
  role: 'buyer' | 'provider'
  rfqId: string
  canAnswer: boolean
  fmt: Intl.DateTimeFormat
  onAnswered: (c: ClarificationView) => void
  onRace: () => void
}) {
  const t = useTranslations('rfq')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unanswered = c.answeredAt === null

  async function send() {
    setError('')
    const a = answer.trim()
    if (!a) return
    setBusy(true)
    try {
      const res = await fetch(`/api/v1/rfq/${rfqId}/clarifications/${c.id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: a }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (d.error === 'already_answered') { onRace(); return }
        if (d.error === 'rfq_closed') throw new Error(t('clarify_closed'))
        throw new Error(t('clarify_err_generic'))
      }
      onAnswered(d.clarification as ClarificationView)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('clarify_err_generic'))
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-foreground-secondary">
      {role === 'provider' && c.mine && <span className="rounded-chip border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary">{t('clarify_you_asked')}</span>}
      {role === 'buyer' && c.askedByName && <span>{t('clarify_asked_by', { name: c.askedByName })}</span>}
      <time dateTime={c.askedAt}>{fmt.format(new Date(c.askedAt))} IST</time>
      {c.questionRedacted && <span className="rounded-chip border border-border bg-muted px-2 py-0.5">{t('clarify_redacted_pill')}</span>}
      {unanswered ? (
        <span className="rounded-chip border border-warning/40 bg-warning/10 px-2 py-0.5 font-medium text-warning">{role === 'buyer' ? t('clarify_unanswered_label') : t('clarify_pending_label')}</span>
      ) : (
        <span className="rounded-chip border border-success/40 bg-success/10 px-2 py-0.5 font-medium text-success">{t('clarify_answered_label')}</span>
      )}
    </div>
  )

  if (unanswered) {
    return (
      <div className="rounded-button border border-border p-3 space-y-2">
        {header}
        <p className="whitespace-pre-wrap text-sm">{c.question}</p>
        {canAnswer && (
          <div className="space-y-1.5">
            <Textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value.slice(0, CLARIFICATION_ANSWER_MAX))}
              rows={3}
              maxLength={CLARIFICATION_ANSWER_MAX}
              placeholder={t('clarify_answer_placeholder')}
              aria-label={t('clarify_answer_placeholder')}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-foreground-secondary">
              <span>{t('clarify_answer_hint')}</span>
              <span className="tabular-nums">{answer.length}/{CLARIFICATION_ANSWER_MAX}</span>
            </div>
            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
            <Button size="sm" onClick={send} loading={busy} disabled={!answer.trim()}>{t('clarify_answer_button')}</Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <details className="rounded-button border border-border p-3">
      <summary className="cursor-pointer space-y-1">
        {header}
        <p className="whitespace-pre-wrap text-sm">{c.question}</p>
      </summary>
      <div className="mt-2 border-t border-border pt-2">
        <p className="text-[11px] text-foreground-secondary">
          {t('clarify_answer_label')} · <time dateTime={c.answeredAt ?? undefined}>{c.answeredAt ? fmt.format(new Date(c.answeredAt)) : ''} IST</time>
          {c.answerRedacted && <span className="ml-2 rounded-chip border border-border bg-muted px-2 py-0.5">{t('clarify_redacted_pill')}</span>}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm">{c.answer}</p>
      </div>
    </details>
  )
}
