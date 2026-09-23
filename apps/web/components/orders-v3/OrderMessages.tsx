'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ShieldCheck, Paperclip } from 'lucide-react'
import { ORDER_MESSAGE_MAX, ORDER_MESSAGE_MAX_DOCS, type OrderMessageView, type OrderThreadState } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { useAnalytics } from '@/components/providers/posthog'

interface DocOption { id: string; file_name: string }

function istTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

/**
 * PRD Experience v3 E8b FR-8.4 (N24) — the order's Messages tab. Reads and
 * writes only through /api/v1/orders/[id]/messages (the route masks phone /
 * email before storing, exactly like quote threads). Marks the other party's
 * messages read when the tab is open. Attachments are this order's documents.
 */
export function OrderMessages({ orderId, active, documents, onUnreadChange }: { orderId: string; active: boolean; documents: DocOption[]; onUnreadChange?: (n: number) => void }) {
  const t = useTranslations('orders_v3')
  const posthog = useAnalytics()
  const [messages, setMessages] = useState<OrderMessageView[]>([])
  const [state, setState] = useState<OrderThreadState>('open')
  const [loaded, setLoaded] = useState(false)
  const [body, setBody] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const readSent = useRef(false)

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/orders/${orderId}/messages`, { cache: 'no-store' }).catch(() => null)
    const d = r?.ok ? ((await r.json().catch(() => null)) as { state: OrderThreadState; messages: OrderMessageView[]; unread: number } | null) : null
    if (d) { setMessages(d.messages); setState(d.state); onUnreadChange?.(d.unread) }
    setLoaded(true)
  }, [orderId, onUnreadChange])

  useEffect(() => { if (active) void load() }, [active, load])

  // Seeing the tab = reading the other party's messages (once per mount).
  useEffect(() => {
    if (!active || readSent.current || !messages.some((m) => !m.mine && !m.readAt)) return
    readSent.current = true
    void fetch(`/api/v1/orders/${orderId}/messages/read`, { method: 'POST' }).then((r) => {
      if (r.ok) { posthog.capture('order_message_read', { device: 'web' }); onUnreadChange?.(0) }
    }).catch(() => undefined)
  }, [active, messages, orderId, posthog, onUnreadChange])

  async function send() {
    const text = body.trim()
    if (!text) return
    setSending(true)
    setError('')
    setNotice('')
    try {
      const r = await fetch(`/api/v1/orders/${orderId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, ...(picked.length ? { documentIds: picked } : {}) }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (d.code === 'thread_read_only') setState('read_only')
        setError(d.code === 'thread_read_only' ? t('msg_read_only') : t('msg_failed'))
        return
      }
      const m = d as OrderMessageView
      setMessages((prev) => [...prev, m])
      setBody('')
      setPicked([])
      if (m.redacted) setNotice(t('msg_masked_notice'))
      posthog.capture('order_message_sent', { redacted: m.redacted, docs: m.documents.length, device: 'web' })
    } catch {
      setError(t('msg_failed'))
    } finally {
      setSending(false)
    }
  }

  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= ORDER_MESSAGE_MAX_DOCS ? p : [...p, id]))

  return (
    <div className="rounded-card bg-surface p-5 shadow-card" data-testid="order-messages">
      <p className="mb-3 flex items-center gap-1.5 text-xs text-foreground-secondary"><ShieldCheck className="h-3.5 w-3.5 text-trust" aria-hidden />{t('msg_masked_note')}</p>
      <ol className="max-h-[28rem] space-y-2 overflow-y-auto" aria-live="polite">
        {loaded && messages.length === 0 && <li className="text-sm text-foreground-secondary">{t('msg_empty')}</li>}
        {messages.map((m) => (
          <li key={m.id} className={`max-w-[85%] rounded-card px-3 py-2 text-sm ${m.mine ? 'ml-auto bg-primary text-white' : 'bg-sunken'}`}>
            <p className="whitespace-pre-wrap">{m.body}</p>
            {m.documents.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {m.documents.map((d) => <li key={d.id} className="flex items-center gap-1 text-xs opacity-90"><Paperclip className="h-3 w-3" aria-hidden />{d.fileName}</li>)}
              </ul>
            )}
            <p className={`mt-1 text-[10px] ${m.mine ? 'text-white/80' : 'text-foreground-secondary'}`}>{istTime(m.createdAt)}{m.redacted ? ` · ${t('msg_masked_tag')}` : ''}</p>
          </li>
        ))}
      </ol>
      {state === 'read_only' ? (
        <p className="mt-3 rounded-button bg-sunken px-3 py-2 text-sm text-foreground-secondary" data-testid="order-messages-read-only">{t('msg_read_only')}</p>
      ) : (
        <div className="mt-3 space-y-2">
          <label htmlFor="order-message-body" className="sr-only">{t('msg_label')}</label>
          <textarea
            id="order-message-body"
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, ORDER_MESSAGE_MAX))}
            rows={3}
            placeholder={t('msg_placeholder')}
            className="w-full rounded-input border border-border bg-background p-3 text-sm"
          />
          {documents.length > 0 && (
            <fieldset>
              <legend className="text-xs text-foreground-secondary">{t('msg_attach', { max: ORDER_MESSAGE_MAX_DOCS })}</legend>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {documents.map((d) => (
                  <button key={d.id} type="button" aria-pressed={picked.includes(d.id)} onClick={() => togglePick(d.id)} className={`min-h-8 rounded-chip border px-2.5 text-xs ${picked.includes(d.id) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground-secondary'}`}>
                    {d.file_name}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-foreground-secondary">{body.length}/{ORDER_MESSAGE_MAX}</span>
            <Button onClick={send} loading={sending} disabled={!body.trim()}>{t('msg_send')}</Button>
          </div>
          {notice && <p className="text-xs text-foreground-secondary">{notice}</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </div>
  )
}
