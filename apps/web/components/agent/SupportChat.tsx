'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { HOW_TO_TOPICS } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'

interface Message {
  id: string
  role: string
  body: string
  intent: string | null
  reply_key: string | null
  created_at: string
}

interface Action {
  tool: 'nudge_counterparty'
  subject: { kind: 'order' | 'rfq'; id: string }
  support_message_id: string
}

/** The quick chips: four how-to topics the templates answer without any lookup. */
const CHIPS = ['refund', 'payout_timing', 'fees', 'contact_human'] as const

/**
 * The support chat (S2.3). Every reply is a server-rendered template — the
 * model only classifies — so this component never formats money or dates. An
 * offered nudge is a confirm button that calls the SPINE route directly
 * (`/orders/[id]/nudge` or `/rfq/[id]/nudge`) with the assistant message id,
 * which is what records the ai_decisions row.
 */
export function SupportChat({ role: _role }: { role: 'buyer' | 'provider' }) {
  void _role
  const t = useTranslations('support')
  const locale = useLocale()
  const { toast } = useToast()
  const [messages, setMessages] = useState<Message[]>([])
  const [ticketRef, setTicketRef] = useState<string | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [text, setText] = useState('')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const r = await fetch('/api/v1/agent/support/thread', { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
    if (r) {
      setThreadId(r.thread_id)
      setMessages(r.messages ?? [])
      setTicketRef(r.ticket_ref ?? null)
    }
    setLoading(false)
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length])

  async function send(body: string) {
    if (!body.trim() || busy) return
    setBusy(true)
    setAction(null)
    const optimistic: Message = { id: `local-${Date.now()}`, role: 'user', body, intent: null, reply_key: null, created_at: new Date().toISOString() }
    setMessages((m) => [...m, optimistic])
    setText('')
    const res = await fetch('/api/v1/agent/support/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-amc-locale': locale }, body: JSON.stringify({ text: body, ...(threadId ? { thread_id: threadId } : {}) }) })
    setBusy(false)
    if (!res.ok) {
      toast(res.status === 429 ? t('too_fast') : t('error'))
      return
    }
    const d = (await res.json()) as { thread_id: string; reply: { key: string; text: string }; action?: Action; ticket_ref?: string }
    setThreadId(d.thread_id)
    setMessages((m) => [...m, { id: `reply-${Date.now()}`, role: 'assistant', body: d.reply.text, intent: null, reply_key: d.reply.key, created_at: new Date().toISOString() }])
    setAction(d.action ?? null)
    if (d.ticket_ref) setTicketRef(d.ticket_ref)
    void load()
  }

  async function confirmNudge() {
    if (!action) return
    setBusy(true)
    const path = action.subject.kind === 'order' ? `/api/v1/orders/${action.subject.id}/nudge` : `/api/v1/rfq/${action.subject.id}/nudge`
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ support_message_id: action.support_message_id, via: 'web' }) })
    setBusy(false)
    setAction(null)
    // quote the configured cooldown the route returns (never a constant); a plain rate-limit 429 carries none
    const capped = res.status === 429 ? Number(((await res.json().catch(() => null)) as { cooldown_hours?: unknown } | null)?.cooldown_hours) : NaN
    toast(res.ok ? t('nudge_sent') : res.status === 429 ? (Number.isInteger(capped) && capped > 0 ? t('nudge_capped', { hours: capped }) : t('nudge_capped_recent')) : t('error'))
    void load()
  }

  if (loading) return <p className="text-sm text-foreground-secondary">{t('loading')}</p>

  return (
    <div className="flex flex-col gap-4" data-testid="support-chat">
      {ticketRef && (
        <div className="rounded-card border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="support-escalated-banner">
          <p className="font-medium">{t('escalated_title', { ref: ticketRef })}</p>
          <p className="mt-1 text-xs text-foreground-secondary">{t('escalated_body')}</p>
        </div>
      )}
      <div ref={listRef} className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-card border border-border bg-surface p-4">
        {messages.length === 0 && <p className="text-sm text-foreground-secondary">{t('empty')}</p>}
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'self-end max-w-[85%] rounded-card bg-primary/10 px-3 py-2 text-sm' : 'self-start max-w-[85%] rounded-card bg-muted px-3 py-2 text-sm'} data-role={m.role}>
            {m.body}
          </div>
        ))}
      </div>
      {action && (
        <div className="rounded-card border border-border bg-surface p-3" data-testid="support-nudge-confirm">
          <p className="text-sm">{t('nudge_question')}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={confirmNudge} disabled={busy}>{t('nudge_yes')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setAction(null)} disabled={busy}>{t('nudge_no')}</Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {CHIPS.filter((c) => (HOW_TO_TOPICS as readonly string[]).includes(c)).map((c) => (
          <button key={c} type="button" onClick={() => void send(t(`chip_${c}`))} disabled={busy} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-muted">
            {t(`chip_${c}`)}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send(text)
        }}
      >
        <input className="field flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('placeholder')} maxLength={1000} aria-label={t('placeholder')} data-testid="support-input" />
        <Button type="submit" disabled={busy || !text.trim()} data-testid="support-send">{t('send')}</Button>
      </form>
      <p className="text-xs text-foreground-secondary">{t('footer')}</p>
    </div>
  )
}
