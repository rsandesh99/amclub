'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ThreadMsg { id: string; mine: boolean; body: string; redacted: boolean; createdAt: string }

/**
 * The provider's side of a quote's message thread (the buyer's lives in
 * QuoteCompare). Same GET/POST route; contact masking happens server-side
 * before storage, so what comes back is already safe to render. Read-only once
 * the quote is no longer live (`canSend` false).
 */
export function QuoteThread({ quoteId, canSend }: { quoteId: string; canSend: boolean }) {
  const t = useTranslations('rfq')
  const [messages, setMessages] = useState<ThreadMsg[]>([])
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(`/api/v1/quotes/${quoteId}/messages`, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        if (cancelled) return
        if (!r.ok || !d) { setLoadError(true); return }
        setMessages(d.messages ?? [])
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [quoteId])

  async function send() {
    const text = body.trim()
    if (!text || sending) return
    setSending(true)
    setError('')
    try {
      const res = await fetch(`/api/v1/quotes/${quoteId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }) })
      if (!res.ok) { setError(t('quote_thread_send_failed')); return }
      const m = (await res.json()) as ThreadMsg
      setMessages((prev) => [...prev, m])
      setBody('')
    } catch {
      setError(t('quote_thread_send_failed'))
    } finally {
      setSending(false)
    }
  }

  return (
    <section aria-labelledby={`thread-${quoteId}`} className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h2 id={`thread-${quoteId}`} className="text-sm font-semibold">{t('quote_thread_title')}</h2>
      <p className="mt-1 flex items-center gap-1 text-xs text-foreground-secondary"><ShieldCheck className="h-3 w-3" />{t('quote_thread_masked')}</p>
      <div className="mt-3 max-h-64 space-y-2 overflow-y-auto" aria-live="polite">
        {!loaded && <p className="text-xs text-foreground-secondary">{t('quote_thread_loading')}</p>}
        {loaded && loadError && <p className="text-xs text-danger">{t('quote_thread_load_failed')}</p>}
        {loaded && !loadError && messages.length === 0 && <p className="text-xs text-foreground-secondary">{t('quote_thread_empty')}</p>}
        {messages.map((m) => (
          <div key={m.id} className={`max-w-[80%] whitespace-pre-wrap rounded-card px-3 py-1.5 text-sm ${m.mine ? 'ml-auto bg-primary text-white' : 'bg-muted'}`}>
            <span className="sr-only">{m.mine ? t('quote_thread_you') : t('quote_thread_buyer')}: </span>
            {m.body}
          </div>
        ))}
      </div>
      {canSend ? (
        <div className="mt-3">
          <div className="flex gap-2">
            <input
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
              maxLength={1000}
              aria-label={t('quote_thread_placeholder')}
              placeholder={t('quote_thread_placeholder')}
              className="min-w-0 flex-1 rounded-button border border-border bg-surface px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
            <Button onClick={() => void send()} loading={sending} disabled={!body.trim()}>{t('send')}</Button>
          </div>
          {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
        </div>
      ) : (
        <p className="mt-3 text-xs text-foreground-secondary">{t('quote_thread_closed')}</p>
      )}
    </section>
  )
}
