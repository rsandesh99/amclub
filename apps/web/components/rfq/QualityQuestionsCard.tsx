'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { ClipboardCheck } from 'lucide-react'
import type { RfqQualityReport } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { VoiceDictation } from '@/components/mart/VoiceDictation'
import { useAnalytics } from '@/components/providers/posthog'

export interface QualityQuestionsCardProps {
  rfqId: string
  report: RfqQualityReport
  /** When the cron guard will send it as is (ISO). */
  deadlineAt: string | null
  /** false → the model was unavailable and these are the rule-only questions. */
  modelUsed?: boolean
  /** Called after a successful answer / send-as-is instead of the default redirect to the RFQ page. */
  onSent?: (rfqId: string, matched: number) => void
}

/**
 * S1.5 — "Before we send this": the ≤ 3 quality questions for a DEFERRED RFQ,
 * shared by the create form (right after POST) and the buyer detail page.
 * Primary: Send with answers (only filled fields); secondary: Send as is.
 * Nothing is held hostage: the countdown shows when the cron guard sends it
 * regardless, and a 409 already_sent just refreshes.
 */
export function QualityQuestionsCard({ rfqId, report, deadlineAt, modelUsed = true, onSent }: QualityQuestionsCardProps) {
  const t = useTranslations('rfq')
  const locale = useLocale()
  const router = useRouter()
  const posthog = useAnalytics()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'answer' | 'send' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const deadlineLabel = useMemo(() => {
    if (!deadlineAt) return null
    const fmt = new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    return fmt.format(new Date(deadlineAt))
  }, [deadlineAt, locale])
  const minutesLeft = deadlineAt ? Math.max(0, Math.round((new Date(deadlineAt).getTime() - now) / 60_000)) : null
  const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim().length > 0).map(([k, v]) => [k, v.trim()]))
  const filledCount = Object.keys(filled).length

  async function post(kind: 'answer' | 'send') {
    setError('')
    setBusy(kind)
    try {
      const res = await fetch(`/api/v1/rfq/${rfqId}/quality/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: kind === 'answer' ? JSON.stringify({ answers: filled }) : '{}',
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (d.error === 'already_sent') {
          setNotice(t('quality_err_already_sent'))
          router.push(`/app/rfq/${rfqId}`)
          router.refresh()
          return
        }
        throw new Error(t('quality_err_generic'))
      }
      if (Array.isArray(d.redacted_fields) && d.redacted_fields.length > 0) setNotice(t('quality_redacted_notice'))
      if (onSent) onSent(rfqId, Number(d.matched ?? 0))
      else router.push(`/app/rfq/${rfqId}`)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('quality_err_generic'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card space-y-4" aria-labelledby="quality-heading">
      <div>
        <h2 id="quality-heading" className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden />
          {t('quality_title')}
        </h2>
        <p className="mt-1 text-xs text-foreground-secondary">{t('quality_intro')}</p>
        {!modelUsed && <p className="mt-1 text-xs text-foreground-secondary">{t('quality_rule_only_hint')}</p>}
        {deadlineLabel && (
          <p className="mt-1 text-xs text-warning" role="status">
            {t('quality_auto_send_at', { time: deadlineLabel })}{minutesLeft !== null ? ` · ${t('quality_minutes_left', { n: minutesLeft })}` : ''}
          </p>
        )}
      </div>

      <ol className="space-y-4">
        {report.missing.map((m, i) => (
          <li key={m.field} className="rounded-button border border-border p-3 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-sm font-medium">{i + 1}. {m.question}</p>
              <span className={`rounded-chip border px-2 py-0.5 text-[10px] font-medium ${m.source === 'rule' ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border bg-muted text-foreground-secondary'}`}>
                {m.source === 'rule' ? t('quality_source_rule') : t('quality_source_model')}
              </span>
            </div>
            {m.why && <p className="text-xs text-foreground-secondary">{m.why}</p>}
            <Textarea
              id={`quality-${m.field}`}
              value={answers[m.field] ?? ''}
              onChange={(e) => setAnswers((a) => ({ ...a, [m.field]: e.target.value.slice(0, 1000) }))}
              rows={2}
              maxLength={1000}
              placeholder={t('quality_answer_placeholder')}
              aria-label={m.question}
            />
            <VoiceDictation
              surface="rfq_quality"
              onText={(text) => {
                setAnswers((a) => ({ ...a, [m.field]: `${(a[m.field] ?? '').trim()} ${text}`.trim().slice(0, 1000) }))
                posthog.capture('rfq_quality_answer_dictated', { rfq_id: rfqId, field: m.field, locale, role: 'msme' })
              }}
            />
          </li>
        ))}
      </ol>

      {report.risk_flags.length > 0 && (
        <ul className="space-y-1 text-xs text-foreground-secondary">
          {report.risk_flags.map((f) =>
            f === 'contact_info_in_text' ? <li key={f}>· {t('quality_risk_contact_info_in_text')}</li>
            : f === 'duplicate_recent' ? <li key={f}>· {t('quality_risk_duplicate_recent')} <Link href="/app/rfq" className="underline">{t('quality_risk_duplicate_link')}</Link></li>
            : f === 'title_too_vague' ? <li key={f}>· {t('quality_risk_title_too_vague')}</li>
            : f === 'description_too_short' ? <li key={f}>· {t('quality_risk_description_too_short')}</li>
            : null,
          )}
        </ul>
      )}

      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {notice && <p className="text-xs text-foreground-secondary" role="status">{notice}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={() => post('answer')} loading={busy === 'answer'} disabled={busy !== null || filledCount === 0} className="flex-1">
          {busy === 'answer' ? t('quality_sending') : t('quality_send_with_answers')}
        </Button>
        <Button variant="outline" onClick={() => post('send')} loading={busy === 'send'} disabled={busy !== null}>
          {t('quality_send_as_is')}
        </Button>
      </div>
    </section>
  )
}

/** S1.5 — after release: a one-line, collapsed summary of what happened (buyer only). */
export function QualitySummary({ report, decision, answeredCount }: { report: RfqQualityReport | null; decision: string | null; answeredCount: number }) {
  const t = useTranslations('rfq')
  if (!decision) return null
  const total = report?.missing.length ?? 0
  const text =
    decision === 'answered' ? t('quality_summary_answered', { n: answeredCount, total })
    : decision === 'sent_as_is' ? t('quality_summary_sent_as_is')
    : decision === 'auto_released' ? t('quality_summary_auto_released')
    : t('quality_summary_skipped')
  return (
    <details className="rounded-card border border-border bg-surface px-4 py-3 text-xs text-foreground-secondary">
      <summary className="cursor-pointer font-medium text-foreground">{t('quality_summary_title')} · {text}</summary>
      {report && report.missing.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {report.missing.map((m) => <li key={m.field}>· {m.question}</li>)}
        </ul>
      )}
    </details>
  )
}
