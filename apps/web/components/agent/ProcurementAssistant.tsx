'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PROCUREMENT_CONSENT_TEXT_VERSION } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { useAnalytics } from '@/components/providers/posthog'

interface SessionItem {
  id: string
  state: string
  active: boolean
  title: string | null
  rfq_id: string | null
  surface: string
  open_run_id: string | null
  updated_at: string
}

interface Turn {
  id: string
  role: 'user' | 'agent' | 'system'
  surface: string
  body: string | null
  run_id: string | null
  proposal: { tool?: string; status?: string; edit?: boolean; labels?: string[]; key?: string; session_choice?: boolean; message_id?: string | null } | null
  created_at: string
}

interface State {
  enabled: boolean
  whatsapp: boolean
  consent_text_version: string
  sessions: SessionItem[]
}

const STATES = ['drafting', 'awaiting_create', 'quality', 'live', 'quotes_in', 'chosen', 'closed', 'expired', 'failed'] as const
const PROPOSAL_STATUSES = ['approved', 'declined', 'edited', 'cancelled', 'failed'] as const
const URL_RE = /(https?:\/\/[^\s)]+)/g
// a non-global test (a /g regex keeps lastIndex between .test calls)
const IS_URL = /^https?:\/\//

/** Agent text with its links clickable (agent bodies are rendered templates; buyer turns are shown as plain text). */
function AgentBody({ text }: { text: string }) {
  const parts = text.split(URL_RE)
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {parts.map((p, i) =>
        IS_URL.test(p) ? (
          <a key={i} href={p} className="text-primary underline underline-offset-2" rel="noopener noreferrer">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  )
}

/**
 * The buying assistant (S3.1) — the web mirror of the procurement agent. Every agent line is a template the server
 * rendered (the model never writes text the buyer reads). A proposal card's Yes / Edit / No is the buyer's tap: it
 * goes to the SAME decision path as a WhatsApp button (the runtime's decide job — one ai_decisions row). Nothing here
 * pays: an approved "go with B" posts a link to the request page, where the ordinary confirm sheet takes the payment
 * on the buyer's own tap.
 */
export function ProcurementAssistant({ initial }: { initial: State }) {
  const t = useTranslations('assistant')
  const locale = useLocale()
  const { toast } = useToast()
  const posthog = useAnalytics()
  const [state, setState] = useState<State>(initial)
  const [selected, setSelected] = useState<string | null>(initial.sessions.find((s) => s.active)?.id ?? initial.sessions[0]?.id ?? null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const loadState = useCallback(async () => {
    const r = await fetch('/api/v1/agent/procurement', { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
    if (r) setState(r as State)
  }, [])
  const loadThread = useCallback(async (id: string) => {
    const r = await fetch(`/api/v1/agent/procurement/sessions/${id}`, { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
    if (r) {
      setTurns((r as { turns: Turn[] }).turns)
      const last = (r as { turns: Turn[] }).turns.at(-1)
      if (last && last.role === 'agent') setWaiting(false)
    }
  }, [])

  useEffect(() => {
    if (selected) void loadThread(selected)
    else setTurns([])
  }, [selected, loadThread])
  // the reply comes from the runtime: poll while the tab is visible
  useEffect(() => {
    if (!state.enabled) return
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadState()
      if (selected) void loadThread(selected)
    }, 4000)
    return () => clearInterval(id)
  }, [state.enabled, selected, loadState, loadThread])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [turns.length])

  async function toggle(on: boolean) {
    setBusy(true)
    const res = await fetch(`/api/v1/agent/procurement/${on ? 'enable' : 'disable'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: on ? JSON.stringify({ locale, consent_text_version: PROCUREMENT_CONSENT_TEXT_VERSION }) : '{}' })
    setBusy(false)
    if (!res.ok) return toast(t('error'))
    setState((await res.json()) as State)
    posthog.capture(on ? 'procurement_enabled_ui' : 'procurement_disabled_ui', { device: 'web' })
    if (!on) toast(t('disabled_note'))
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    const res = await fetch('/api/v1/agent/procurement/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-amc-locale': locale }, body: JSON.stringify(body) })
    setBusy(false)
    if (!res.ok) {
      toast(res.status === 429 ? t('too_fast') : res.status === 409 ? t('not_enabled') : t('error'))
      return null
    }
    const d = (await res.json()) as { session_id: string; enqueued: boolean }
    setWaiting(true)
    if (!d.enqueued) toast(t('runtime_offline'))
    return d
  }

  async function send() {
    const body = text.trim()
    if (!body || busy) return
    setText('')
    const d = await post({ text: body, ...(selected && state.sessions.find((s) => s.id === selected)?.active ? { session_id: selected } : {}) })
    if (d) {
      setSelected(d.session_id)
      await loadState()
      await loadThread(d.session_id)
    }
  }

  async function decide(runId: string, action: 'ok' | 'edit' | 'no') {
    setPending(runId)
    const res = await fetch('/api/v1/agent/procurement/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: runId, action }) })
    setPending(null)
    if (!res.ok) {
      toast(res.status === 409 ? t('proposal_gone') : t('error'))
      if (selected) void loadThread(selected)
      return
    }
    const d = (await res.json()) as { enqueued: boolean }
    setWaiting(true)
    if (!d.enqueued) toast(t('runtime_offline'))
    posthog.capture('procurement_card_tapped', { action, device: 'web' })
  }

  if (!state.enabled) {
    return (
      <section className="rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="assistant-consent-title">
        <h2 id="assistant-consent-title" className="text-lg font-semibold">{t('consent_title')}</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm">
          <li>{t('consent_does_1')}</li>
          <li>{t('consent_does_2')}</li>
          <li>{t('consent_does_3')}</li>
        </ul>
        <p className="mt-3 rounded-button bg-primary/5 p-3 text-sm font-medium">{t('consent_never')}</p>
        <p className="mt-2 text-xs text-foreground-secondary">{t('consent_whatsapp')}</p>
        <Button className="mt-4" onClick={() => toggle(true)} disabled={busy}>
          {t('enable')}
        </Button>
      </section>
    )
  }

  const current = state.sessions.find((s) => s.id === selected) ?? null
  const stateLabel = (s: string) => ((STATES as readonly string[]).includes(s) ? t(`state_${s}` as 'state_live') : s)
  const statusLabel = (s: string) => ((PROPOSAL_STATUSES as readonly string[]).includes(s) ? t(`proposal_${s}` as 'proposal_approved') : '')

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <aside className="space-y-2" aria-label={t('sessions_title')}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('sessions_title')}</h2>
          <Button size="sm" variant="outline" onClick={() => { setSelected(null); setTurns([]) }}>
            {t('new_request')}
          </Button>
        </div>
        {state.sessions.length === 0 && <p className="text-xs text-foreground-secondary">{t('empty_sessions')}</p>}
        <ul className="space-y-1">
          {state.sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                aria-current={s.id === selected ? 'true' : undefined}
                className={`w-full rounded-button border p-2 text-left text-sm transition-colors ${s.id === selected ? 'border-primary bg-primary/5' : 'border-border bg-surface hover:border-primary/40'}`}
              >
                <span className="block truncate font-medium">{s.title ?? t('untitled')}</span>
                <span className="block text-xs text-foreground-secondary">
                  {stateLabel(s.state)}
                  {s.surface === 'whatsapp' ? ` · ${t('via_whatsapp')}` : ''}
                  {s.open_run_id ? ` · ${t('needs_you')}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="pt-2 text-xs text-foreground-secondary">{t('never_pays_line')}</p>
        <button type="button" onClick={() => toggle(false)} disabled={busy} className="text-xs text-foreground-secondary underline underline-offset-2">
          {t('disable')}
        </button>
      </aside>

      <section className="flex min-h-[28rem] flex-col rounded-card border border-border bg-surface shadow-card" aria-label={current?.title ?? t('new_request')}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <p className="truncate text-sm font-semibold">{current?.title ?? t('new_request')}</p>
          {current?.rfq_id && (
            <a href={`/${locale}/app/rfq/${current.rfq_id}`} className="shrink-0 text-xs text-primary underline underline-offset-2">
              {t('open_rfq')}
            </a>
          )}
        </div>
        <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
          {turns.length === 0 && <p className="text-sm text-foreground-secondary">{t('empty_thread')}</p>}
          {turns.map((m) => {
            const card = m.role === 'agent' && m.proposal && m.run_id && m.proposal.tool
            const open = card && m.proposal?.status === 'open' && current?.open_run_id === m.run_id
            return (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div className={`max-w-[85%] rounded-card px-3 py-2 ${m.role === 'user' ? 'bg-primary text-primary-foreground' : 'border border-border bg-background'}`}>
                  {m.role === 'user' ? <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p> : <AgentBody text={m.body ?? ''} />}
                  {m.surface === 'whatsapp' && <span className="mt-1 block text-[10px] opacity-70">{t('via_whatsapp')}</span>}
                  {open && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => decide(m.run_id!, 'ok')} disabled={pending === m.run_id}>{t('approve')}</Button>
                      {m.proposal?.edit && <Button size="sm" variant="outline" onClick={() => decide(m.run_id!, 'edit')} disabled={pending === m.run_id}>{t('edit')}</Button>}
                      <Button size="sm" variant="ghost" onClick={() => decide(m.run_id!, 'no')} disabled={pending === m.run_id}>{t('decline')}</Button>
                    </div>
                  )}
                  {card && !open && m.proposal?.status && m.proposal.status !== 'open' && <span className="mt-1 block text-xs text-foreground-secondary">{statusLabel(m.proposal.status)}</span>}
                  {m.role === 'agent' && m.proposal?.labels && m.proposal.status === 'open' && current?.active && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {m.proposal.labels.map((l) => (
                        <Button key={l} size="sm" variant="outline" onClick={() => post({ session_id: current.id, label: l })} disabled={busy}>{t('quote_label', { label: l })}</Button>
                      ))}
                    </div>
                  )}
                  {m.role === 'agent' && m.proposal?.session_choice && m.proposal.message_id && current?.active && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => post({ session_id: current.id, session_choice: 'new', message_id: m.proposal!.message_id })} disabled={busy}>{t('new_req_btn')}</Button>
                      <Button size="sm" variant="outline" onClick={() => post({ session_id: current.id, session_choice: 'current', message_id: m.proposal!.message_id })} disabled={busy}>{t('this_one_btn')}</Button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {waiting && <p className="text-xs text-foreground-secondary">{t('thinking')}</p>}
        </div>
        <form
          className="flex gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <label htmlFor="assistant-composer" className="sr-only">{t('composer_label')}</label>
          <input
            id="assistant-composer"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            placeholder={t('composer_placeholder')}
            className="field min-w-0 flex-1 rounded-button border border-border bg-background px-3 py-2 text-sm"
          />
          <Button type="submit" disabled={busy || !text.trim()}>{busy ? t('sending') : t('send')}</Button>
        </form>
      </section>
    </div>
  )
}
