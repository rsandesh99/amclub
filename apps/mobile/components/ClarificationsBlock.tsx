import { useMemo, useState } from 'react'
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { useI18n } from '@/lib/i18n'
import { answerClarification, askClarification } from '@/lib/api'


const MAX_OPEN = 3
const Q_MIN = 10
const Q_MAX = 500
const A_MAX = 1000

const sort = (list: any[]) => [...list].sort((a, b) => {
  const ao = a.answeredAt === null ? 0 : 1
  const bo = b.answeredAt === null ? 0 : 1
  if (ao !== bo) return ao - bo
  return a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : 0
})

/**
 * S1.3 — RFQ clarification thread (mobile parity with web's ClarificationsCard).
 * provider: ask box (≤ 3 open at a time) + every provider's questions ("you asked" on mine);
 * buyer: unanswered first with an inline answer, answered ones collapsed. Read-only when closed.
 */
export function ClarificationsBlock({ rfqId, role, initial, canWrite, closed, onChanged }: {
  rfqId: string
  role: 'buyer' | 'provider'
  initial: any[]
  canWrite: boolean
  closed: boolean
  onChanged?: (list: any[]) => void
}) {
  const { t, locale } = useI18n()
  const [items, setItems] = useState<any[]>(() => sort(initial ?? []))
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const myOpen = useMemo(() => items.filter((c) => c.mine && c.answeredAt === null).length, [items])
  const capReached = role === 'provider' && myOpen >= MAX_OPEN
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }), [locale])
  const update = (next: any[]) => { const s = sort(next); setItems(s); onChanged?.(s) }

  async function ask() {
    setError('')
    const q = question.trim()
    if (q.length < Q_MIN) return
    setBusy(true)
    const res = await askClarification(rfqId, q)
    setBusy(false)
    if (!res.ok) {
      setError(res.data?.error === 'clarification_cap' ? t('rfq.clarify_cap_reached', { max: MAX_OPEN }) : res.data?.error === 'rfq_closed' ? t('rfq.clarify_closed') : t('rfq.clarify_err_generic'))
      return
    }
    update([res.data.clarification, ...items])
    setQuestion('')
  }

  return (
    <View className="rounded-xl border border-border bg-surface p-4 gap-3">
      <View>
        <Text className="text-sm font-semibold text-foreground">{role === 'buyer' ? t('rfq.clarify_title_buyer') : t('rfq.clarify_title_provider')}</Text>
        <Text className="text-xs text-foreground-secondary">{t('rfq.clarify_visible_hint')}</Text>
      </View>

      {role === 'provider' && canWrite && !closed && (
        <View className="gap-2 rounded-lg border border-border bg-background p-3">
          <TextInput
            value={question}
            onChangeText={(v) => setQuestion(v.slice(0, Q_MAX))}
            multiline
            editable={!capReached && !busy}
            placeholder={t('rfq.clarify_ask_placeholder')}
            placeholderTextColor="#9CA3AF"
            style={{ minHeight: 70 }}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
          />
          <Text className="text-[11px] text-foreground-secondary">{t('rfq.clarify_ask_hint_cap', { max: MAX_OPEN })} · {t('rfq.clarify_ask_hint_masking')} · {question.length}/{Q_MAX}</Text>
          {capReached ? (
            <Text className="text-xs text-[#b45309]">{t('rfq.clarify_cap_reached', { max: MAX_OPEN })}</Text>
          ) : (
            <TouchableOpacity onPress={ask} disabled={busy || question.trim().length < Q_MIN} className={`items-center rounded-lg py-2 ${question.trim().length < Q_MIN ? 'bg-muted' : 'bg-primary'}`}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text className={`text-sm font-semibold ${question.trim().length < Q_MIN ? 'text-foreground-secondary' : 'text-white'}`}>{t('rfq.clarify_ask_button')}</Text>}
            </TouchableOpacity>
          )}
        </View>
      )}
      {closed ? <Text className="text-xs text-foreground-secondary">{t('rfq.clarify_closed')}</Text> : null}
      {error ? <Text className="text-sm text-danger">{error}</Text> : null}

      {items.length === 0 ? (
        <Text className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-sm text-foreground-secondary">{t('rfq.clarify_empty')}</Text>
      ) : (
        items.map((c) => (
          <Item
            key={c.id}
            c={c}
            role={role}
            rfqId={rfqId}
            canAnswer={role === 'buyer' && canWrite && !closed}
            fmt={fmt}
            expanded={expanded === c.id}
            onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
            onAnswered={(u) => update(items.map((x) => (x.id === u.id ? u : x)))}
          />
        ))
      )}
    </View>
  )
}

function Item({ c, role, rfqId, canAnswer, fmt, expanded, onToggle, onAnswered }: { c: any; role: 'buyer' | 'provider'; rfqId: string; canAnswer: boolean; fmt: Intl.DateTimeFormat; expanded: boolean; onToggle: () => void; onAnswered: (c: any) => void }) {
  const { t } = useI18n()
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unanswered = c.answeredAt === null

  async function send() {
    setError('')
    const a = answer.trim()
    if (!a) return
    setBusy(true)
    const res = await answerClarification(rfqId, c.id, a)
    setBusy(false)
    if (!res.ok) {
      setError(res.data?.error === 'already_answered' ? t('rfq.clarify_err_race') : res.data?.error === 'rfq_closed' ? t('rfq.clarify_closed') : t('rfq.clarify_err_generic'))
      return
    }
    onAnswered(res.data.clarification)
  }

  return (
    <View className="rounded-lg border border-border p-3 gap-1.5">
      <View className="flex-row flex-wrap items-center gap-1.5">
        {role === 'provider' && c.mine ? <Text className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{t('rfq.clarify_you_asked')}</Text> : null}
        {role === 'buyer' && c.askedByName ? <Text className="text-[11px] text-foreground-secondary">{t('rfq.clarify_asked_by', { name: c.askedByName })}</Text> : null}
        <Text className="text-[11px] text-foreground-secondary">{fmt.format(new Date(c.askedAt))} IST</Text>
        {c.questionRedacted ? <Text className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-foreground-secondary">{t('rfq.clarify_redacted_pill')}</Text> : null}
        <Text className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${unanswered ? 'border-[#b45309]/40 bg-[#f5ebdd] text-[#b45309]' : 'border-success/40 bg-success/10 text-success'}`}>
          {unanswered ? (role === 'buyer' ? t('rfq.clarify_unanswered_label') : t('rfq.clarify_pending_label')) : t('rfq.clarify_answered_label')}
        </Text>
      </View>
      <Text className="text-sm text-foreground">{c.question}</Text>
      {unanswered ? (
        canAnswer ? (
          <View className="gap-1.5">
            <TextInput value={answer} onChangeText={(v) => setAnswer(v.slice(0, A_MAX))} multiline placeholder={t('rfq.clarify_answer_placeholder')} placeholderTextColor="#9CA3AF" style={{ minHeight: 60 }} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
            <Text className="text-[11px] text-foreground-secondary">{t('rfq.clarify_answer_hint')} · {answer.length}/{A_MAX}</Text>
            {error ? <Text className="text-sm text-danger">{error}</Text> : null}
            <TouchableOpacity onPress={send} disabled={busy || !answer.trim()} className={`items-center rounded-lg py-2 ${answer.trim() ? 'bg-primary' : 'bg-muted'}`}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text className={`text-sm font-semibold ${answer.trim() ? 'text-white' : 'text-foreground-secondary'}`}>{t('rfq.clarify_answer_button')}</Text>}
            </TouchableOpacity>
          </View>
        ) : null
      ) : (
        <TouchableOpacity onPress={onToggle}>
          {expanded ? (
            <View className="mt-1 border-t border-border pt-1.5">
              <Text className="text-[11px] text-foreground-secondary">{t('rfq.clarify_answer_label')} · {c.answeredAt ? fmt.format(new Date(c.answeredAt)) : ''} IST{c.answerRedacted ? ` · ${t('rfq.clarify_redacted_pill')}` : ''}</Text>
              <Text className="mt-0.5 text-sm text-foreground">{c.answer}</Text>
            </View>
          ) : (
            <Text className="text-xs text-primary" numberOfLines={1}>{t('rfq.clarify_answer_label')}: {c.answer}</Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  )
}
