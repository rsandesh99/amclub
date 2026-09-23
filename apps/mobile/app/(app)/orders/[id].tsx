import { ScrollView, Text, View, ActivityIndicator, TouchableOpacity, Alert, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState, useEffect, useCallback } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { ORDER_TRANSITIONS, DISPUTABLE_STATUSES, REFUND_POLICY_BPS, type OrderStatus } from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { fetchOrder, transitionOrder, uploadOrderDocument, fetchOrderReview, submitReview, replyReview, fetchDisputeStatements, submitDisputeStatement, type OrderTransitionExtra } from '@/lib/api'
import { formatINR } from '@/lib/format'
import { confirmHaptic } from '@/lib/haptics'
import * as DocumentPicker from 'expo-document-picker'
import { currentMobileRole } from '@/lib/role'
import { track } from '@/lib/analytics'

type ActionKey =
  | 'accept' | 'start' | 'deliver' | 'resume'
  | 'submit_requirements' | 'accept_delivery' | 'request_revision' | 'cancel' | 'raise_dispute'

// Mirror of apps/web/components/orders/order-actions.ts — offered actions are
// derived from the shared §3.7 machine (ORDER_TRANSITIONS + DISPUTABLE_STATUSES),
// the same inputs the server's ACTION_RULES check. The server stays the authority.
const IN_PROGRESS: OrderStatus = 'in_progress'
const DISPUTED: OrderStatus = 'disputed'
const DELIVERED: OrderStatus = 'delivered'
const COMPLETED: OrderStatus = 'completed'
const REVIEWED: OrderStatus = 'reviewed'
const ACTION_DEFS: readonly { action: ActionKey; role: 'msme' | 'provider'; to: OrderStatus; from?: OrderStatus }[] = [
  { action: 'accept', role: 'provider', to: 'accepted' },
  { action: 'start', role: 'provider', to: IN_PROGRESS, from: 'requirements_submitted' },
  { action: 'deliver', role: 'provider', to: DELIVERED },
  { action: 'resume', role: 'provider', to: IN_PROGRESS, from: 'revision_requested' },
  { action: 'submit_requirements', role: 'msme', to: 'requirements_submitted' },
  { action: 'accept_delivery', role: 'msme', to: COMPLETED },
  { action: 'request_revision', role: 'msme', to: 'revision_requested' },
  { action: 'cancel', role: 'msme', to: 'cancelled_by_buyer' },
]

// Returns action keys; labels come from t(`order_actions.${action}`).
function actionsFor(role: string, status: string, revisionsLeft: number, disputeWindowEndsAt: string | null): ActionKey[] {
  const s = status as OrderStatus
  const next = ORDER_TRANSITIONS[s] ?? []
  const out = ACTION_DEFS.filter((d) => d.role === role && next.includes(d.to) && (!d.from || d.from === s))
    .map((d) => d.action)
    // The server rejects a revision once revision_used >= revision_max.
    .filter((a) => a !== 'request_revision' || revisionsLeft > 0)
  // Buyer "report a problem": the server checks DISPUTABLE_STATUSES AND the machine.
  // After completion the server also requires the post-completion window (ADR-014 H2);
  // the deadline comes from the server (GET /orders/[id].disputeWindowEndsAt).
  const windowOpen = s !== COMPLETED || (!!disputeWindowEndsAt && Date.now() < Date.parse(disputeWindowEndsAt))
  if (role === 'msme' && DISPUTABLE_STATUSES.includes(s) && next.includes(DISPUTED) && windowOpen) out.push('raise_dispute')
  return out
}

/** Actions that collect text first (requirements / reason), then confirm. */
const NEEDS_TEXT: ReadonlySet<ActionKey> = new Set<ActionKey>(['submit_requirements', 'request_revision', 'raise_dispute'])
/** Irreversible or money-moving actions → a translated Alert confirmation. */
const CONFIRM: ReadonlySet<ActionKey> = new Set<ActionKey>(['accept', 'deliver', 'accept_delivery', 'request_revision', 'cancel', 'raise_dispute'])
const TEXT_MIN: Partial<Record<ActionKey, number>> = { submit_requirements: 20, request_revision: 10, raise_dispute: 10 }
const TEXT_MAX: Partial<Record<ActionKey, number>> = { submit_requirements: 4000, request_revision: 1000, raise_dispute: 1000 }

// Timeline event → translation key (never the raw event name).
const EVENT_LABEL: Record<string, string> = {
  placed: 'orders.status_placed', accept: 'orders.status_accepted',
  submit_requirements: 'orders.status_requirements_submitted', requirements_submitted: 'orders.status_requirements_submitted',
  start: 'orders.status_in_progress', resume: 'orders.status_in_progress', deliver: 'orders.status_delivered',
  accept_delivery: 'orders.status_completed', auto_accepted: 'orders.event_auto_accepted',
  request_revision: 'orders.status_revision_requested', cancel: 'orders.status_cancelled_by_buyer',
  auto_cancelled: 'orders.status_auto_cancelled', refunded: 'orders.status_refunded', manual_refund: 'orders.event_manual_refund',
  raise_dispute: 'orders.status_disputed', dispute_statement: 'orders.event_dispute_statement',
  resolved_refund: 'orders.status_resolved_refund', resolved_release: 'orders.status_resolved_release', resolved_partial: 'orders.status_resolved_partial',
  document_uploaded: 'orders.event_document', milestone_added: 'orders.event_milestone_added', nudged: 'orders.event_nudged',
  external_wait: 'orders.event_external_wait', external_resume: 'orders.event_external_resume',
  payout_held: 'orders.event_payout_held', payout_scheduled: 'orders.event_payout_scheduled', payout_released: 'orders.event_payout_released',
  payout_paid: 'orders.event_payout_paid', payout_failed: 'orders.event_payout_failed', payout_voided: 'orders.event_payout_voided',
}
const HIDDEN_EVENTS = new Set(['placed_side_effects', 'requirements_data'])
const PROVIDER_ONLY_EVENTS = new Set(['payout_held', 'payout_scheduled', 'payout_released', 'payout_paid', 'payout_failed', 'payout_voided'])

function istDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export default function OrderScreen() {
  const { t } = useI18n()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [compose, setCompose] = useState<ActionKey | null>(null)
  const [text, setText] = useState('')
  // E13 FR-13.2 — deliver with upload (the web's documents route, kind 'deliverable'); only while `mobile` is on.
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState<string | null>(null)

  const load = useCallback(async () => {
    const d = await fetchOrder(id)
    setData(d)
    setLoading(false)
  }, [id])

  // Deferred so load()'s setState stays off the effect's synchronous path
  // (react-hooks/set-state-in-effect); load also refreshes after actions.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  async function act(action: ActionKey, extra?: OrderTransitionExtra) {
    setBusy(true)
    confirmHaptic()
    const { ok, data: res } = await transitionOrder(id, action, extra)
    setBusy(false)
    if (!ok) { Alert.alert(t('common.error'), res.error === 'dispute_window_closed' ? t('orders.dispute_window_closed') : typeof res.error === 'string' ? res.error : t('order_actions.failed')); return }
    setCompose(null); setText('')
    load()
  }

  async function attachDeliverable() {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false })
    if (picked.canceled || !picked.assets?.[0]) return
    const f = picked.assets[0]
    setUploading(true)
    const r = await uploadOrderDocument(id, 'deliverable', { uri: f.uri, name: f.name, mimeType: f.mimeType ?? 'application/octet-stream' })
    setUploading(false)
    if (!r.ok) { Alert.alert(t('common.error'), t('orders_v3.upload_failed')); return }
    setUploaded(f.name)
    track('deliverable_uploaded', { platform: 'android' })
    load()
  }

  if (loading) return <SafeAreaView className="flex-1 items-center justify-center bg-background"><ActivityIndicator size="large" color="#1B4D3E" /></SafeAreaView>
  if (!data?.order) return <SafeAreaView className="flex-1 items-center justify-center bg-background"><Text className="text-foreground-secondary">{t('common.not_found')}</Text></SafeAreaView>

  const o = data.order
  const role: 'msme' | 'provider' = data.viewerRole === 'provider' ? 'provider' : 'msme'
  const orderStatus = o.status as OrderStatus
  const revisionUsed = Number(o.revision_used ?? 0)
  const revisionMax = o.revision_max == null ? null : Number(o.revision_max)
  const revisionsLeft = Math.max(0, (revisionMax ?? 0) - revisionUsed)
  const disputeEndsAt: string | null = typeof data.disputeWindowEndsAt === 'string' ? data.disputeWindowEndsAt : null
  const actions = actionsFor(role, o.status, revisionsLeft, disputeEndsAt)
  const disputeDeadline = role === 'msme' && o.status === COMPLETED && disputeEndsAt && actions.includes('raise_dispute') ? istDateTime(disputeEndsAt) : null
  const nextKey = `orders.next_${role}_${o.status}`
  const nextLine = t(nextKey)
  const statusKey = `orders.status_${o.status}`
  const statusLabel = t(statusKey)

  /** Server money only: the order total / provider earning as stored on the order. */
  function confirmCopy(a: ActionKey): { title: string; body: string; cta: string; destructive?: boolean } {
    switch (a) {
      case 'accept_delivery':
        return { title: t('orders.confirm_accept_delivery_title'), body: t('orders.confirm_accept_delivery_body', { amount: formatINR(Number(o.total_paise)) }), cta: t('orders.confirm_accept_delivery_cta') }
      case 'cancel': {
        // Policy line from the shared refund matrix — a percentage, never a computed amount.
        const bps = REFUND_POLICY_BPS[orderStatus] ?? 0
        const body = bps >= 10000 ? t('orders.cancel_policy_full') : bps > 0 ? t('orders.cancel_policy_partial', { pct: bps / 100 }) : t('orders.cancel_policy_none')
        return { title: t('orders.confirm_cancel_title'), body, cta: t('orders.confirm_cancel_cta'), destructive: true }
      }
      case 'request_revision':
        return { title: t('orders.confirm_request_revision_title'), body: t('orders.confirm_request_revision_body', { left: Math.max(0, revisionsLeft - 1) }), cta: t('orders.confirm_request_revision_cta') }
      case 'raise_dispute':
        return { title: t('orders.confirm_raise_dispute_title'), body: t('orders.confirm_raise_dispute_body'), cta: t('orders.confirm_raise_dispute_cta'), destructive: true }
      case 'accept':
        return {
          title: t('orders.confirm_accept_title'),
          body: o.delivery_days != null
            ? t('orders.confirm_accept_body', { days: Number(o.delivery_days), amount: formatINR(Number(o.provider_earning_paise)) })
            : t('orders.confirm_accept_body_nodays', { amount: formatINR(Number(o.provider_earning_paise)) }),
          cta: t('orders.confirm_accept_cta'),
        }
      case 'deliver':
        return { title: t('orders.confirm_deliver_title'), body: t('orders.confirm_deliver_body'), cta: t('orders.confirm_deliver_cta') }
      default:
        return { title: t(`order_actions.${a}`), body: '', cta: t(`order_actions.${a}`) }
    }
  }

  function extraFor(a: ActionKey, value: string): OrderTransitionExtra | undefined {
    // Same shape as web's RequirementsForm free-text fallback ({ details }).
    if (a === 'submit_requirements') return { requirementsData: { details: value } }
    if (a === 'request_revision') return { revisionNote: value }
    if (a === 'raise_dispute') return { disputeReason: value }
    return undefined
  }

  function run(a: ActionKey, value?: string) {
    const extra = value !== undefined ? extraFor(a, value) : undefined
    if (!CONFIRM.has(a)) { void act(a, extra); return }
    const c = confirmCopy(a)
    Alert.alert(c.title, c.body, [
      { text: t('orders.confirm_back'), style: 'cancel' },
      { text: c.cta, style: c.destructive ? 'destructive' : 'default', onPress: () => { void act(a, extra) } },
    ])
  }

  function onAction(a: ActionKey) {
    if (NEEDS_TEXT.has(a)) { setText(''); setCompose(a); return }
    run(a)
  }

  function onComposeContinue() {
    if (!compose) return
    const value = text.trim()
    const min = TEXT_MIN[compose] ?? 0
    if (value.length < min) { Alert.alert(t('orders.reason_min', { min })); return }
    run(compose, value)
  }

  const composeMin = compose ? TEXT_MIN[compose] ?? 0 : 0
  const composeMax = compose ? TEXT_MAX[compose] ?? 1000 : 1000
  const events = (data.events ?? []).filter((e: any) => !HIDDEN_EVENTS.has(e.event) && (role === 'provider' || !PROVIDER_ONLY_EVENTS.has(e.event)))

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center gap-2 border-b border-gray-200 bg-surface px-4 py-3">
        <TouchableOpacity onPress={() => router.back()}><Ionicons name="arrow-back" size={22} color="#1A1D1A" /></TouchableOpacity>
        <Text className="flex-1 text-lg font-bold text-foreground" numberOfLines={1}>{o.title}</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 py-4 gap-4">
        <View className="rounded-xl border border-gray-200 bg-surface p-4">
          <Text className="text-xs text-foreground-secondary">{o.order_number}</Text>
          <View className="mt-1 flex-row items-center justify-between">
            <Text className="text-base font-bold text-foreground">{formatINR(Number(o.total_paise))}</Text>
            <View className="rounded-full bg-primary/10 px-3 py-1"><Text className="text-xs font-semibold text-primary">{statusLabel}</Text></View>
          </View>
          {nextLine !== nextKey && <Text className="mt-3 rounded-lg bg-primary/5 px-3 py-2 text-sm font-medium text-foreground">{nextLine}</Text>}
          {disputeDeadline && <Text className="mt-2 text-xs text-foreground-secondary">{t('orders.dispute_window_until', { date: disputeDeadline })}</Text>}
          {orderStatus === DELIVERED && o.auto_accept_at ? (
            <Text className="mt-2 text-sm text-foreground-secondary">
              {role === 'msme' ? t('orders.auto_accept_buyer', { when: istDateTime(o.auto_accept_at) }) : t('orders.auto_accept_provider', { when: istDateTime(o.auto_accept_at) })}
            </Text>
          ) : null}
          {revisionMax != null && (
            <Text className="mt-2 text-sm text-foreground-secondary">{t('orders.revisions')}: {t('orders.revisions_used', { used: revisionUsed, max: revisionMax })}</Text>
          )}
        </View>

        {role === 'provider' && orderStatus === IN_PROGRESS && currentMobileRole() !== null && (
          <View className="gap-2 rounded-xl border border-gray-200 bg-surface p-4" testID="deliverable-upload">
            <Text className="text-sm font-semibold text-foreground">{t('orders_v3.deliverable_title')}</Text>
            <Text className="text-xs text-foreground-secondary">{t('orders_v3.deliverable_hint')}</Text>
            <TouchableOpacity onPress={() => void attachDeliverable()} disabled={uploading} className="items-center rounded-lg border border-gray-200 py-3" accessibilityRole="button">
              {uploading ? <ActivityIndicator color="#1B4D3E" /> : <Text className="text-sm font-semibold text-primary">{t('orders_v3.attach_deliverable')}</Text>}
            </TouchableOpacity>
            {uploaded ? <Text className="text-xs text-success">{t('orders_v3.uploaded', { name: uploaded })}</Text> : null}
          </View>
        )}

        {actions.length > 0 && (
          <View className="rounded-xl border border-gray-200 bg-surface p-4 gap-2">
            <Text className="text-sm font-semibold text-foreground">{t('orders.actions')}</Text>
            {compose ? (
              <View className="gap-2">
                <Text className="text-sm font-medium text-foreground">
                  {compose === 'submit_requirements' ? t('orders.requirements_free_text_label') : compose === 'raise_dispute' ? t('orders.dispute_reason_label') : t('orders.revision_reason_label')}
                </Text>
                {compose === 'submit_requirements' && <Text className="text-xs text-foreground-secondary">{t('orders.requirements_form_intro')}</Text>}
                <TextInput
                  value={text}
                  onChangeText={(v) => setText(v.slice(0, composeMax))}
                  multiline
                  className="min-h-[96px] rounded-lg border border-gray-200 bg-background p-3 text-sm text-foreground"
                />
                <Text className="text-xs text-foreground-secondary">{t('orders.reason_hint', { min: composeMin, max: composeMax, n: text.trim().length })}</Text>
                <TouchableOpacity onPress={onComposeContinue} disabled={busy} className={`items-center rounded-lg py-3 ${busy ? 'bg-primary/60' : 'bg-primary'}`}>
                  <Text className="text-sm font-semibold text-white">{t(`order_actions.${compose}`)}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setCompose(null); setText('') }} disabled={busy} className="items-center rounded-lg border border-gray-200 py-3">
                  <Text className="text-sm font-semibold text-foreground">{t('orders.confirm_back')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              actions.map((action) => {
                const danger = action === 'cancel' || action === 'raise_dispute'
                return (
                  <TouchableOpacity key={action} onPress={() => onAction(action)} disabled={busy} className={`items-center rounded-lg py-3 ${danger ? 'border border-red-300 bg-surface' : busy ? 'bg-primary/60' : 'bg-primary'}`}>
                    <Text className={`text-sm font-semibold ${danger ? 'text-red-700' : 'text-white'}`}>{t(`order_actions.${action}`)}</Text>
                  </TouchableOpacity>
                )
              })
            )}
          </View>
        )}

        {orderStatus === DISPUTED && <DisputeStatementBlock orderId={id} />}

        {(orderStatus === COMPLETED || orderStatus === REVIEWED) && <ReviewBlock orderId={id} />}

        <View className="rounded-xl border border-gray-200 bg-surface p-4">
          <Text className="mb-2 text-sm font-semibold text-foreground">{t('orders.timeline')}</Text>
          {events.map((e: any) => (
            <View key={e.id} className="mb-2 flex-row gap-2">
              <View className="mt-1.5 h-2 w-2 rounded-full bg-primary" />
              <View>
                <Text className="text-sm text-foreground">{t(EVENT_LABEL[e.event] ?? 'orders.event_other')}</Text>
                <Text className="text-xs text-foreground-secondary">{new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

/** S1.7 — "Your statement" on an open dispute (parity with web's DisputeStatementCard; text only, no attachments on mobile). */
function DisputeStatementBlock({ orderId }: { orderId: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<any>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const d = await fetchDisputeStatements(orderId)
    if (!d) return
    setState(d)
    const mine = (d.statements ?? []).find((s: any) => s.role === d.role)
    if (mine) setBody(mine.body)
  }, [orderId])
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  if (!state) return null
  const mine = (state.statements ?? []).find((s: any) => s.role === state.role)
  const other = (state.statements ?? []).find((s: any) => s.role !== state.role)

  async function save() {
    setBusy(true); setNotice('')
    const { ok, data } = await submitDisputeStatement(orderId, body.trim(), !!mine)
    setBusy(false)
    if (!ok) { Alert.alert(t('common.error'), data.error === 'triage_exists' ? t('orders.dispute_statement_locked') : t('orders.dispute_statement_failed')); load(); return }
    setNotice(t('orders.dispute_statement_saved'))
    load()
  }

  return (
    <View className="rounded-xl border border-gray-200 bg-surface p-4 gap-2">
      <Text className="text-sm font-semibold text-foreground">{t('orders.dispute_statement_title')}</Text>
      <Text className="text-xs text-foreground-secondary">{t('orders.dispute_statement_intro')}</Text>
      {state.editable ? (
        <View className="gap-2">
          <TextInput value={body} onChangeText={(v) => setBody(v.slice(0, 2000))} multiline placeholder={t('orders.dispute_statement_placeholder')} placeholderTextColor="#9CA3AF" className="min-h-[96px] rounded-lg border border-gray-200 bg-background p-3 text-sm text-foreground" />
          <Text className="text-[11px] text-foreground-secondary">{body.length}/2000</Text>
          <TouchableOpacity onPress={save} disabled={busy || body.trim().length < 20} className={`items-center rounded-lg py-3 ${busy || body.trim().length < 20 ? 'bg-primary/60' : 'bg-primary'}`}>
            <Text className="text-sm font-semibold text-white">{mine ? t('orders.dispute_statement_update') : t('orders.dispute_statement_submit')}</Text>
          </TouchableOpacity>
        </View>
      ) : mine ? (
        <View className="rounded-lg border border-gray-200 p-3"><Text className="text-xs font-medium text-foreground-secondary">{t('orders.dispute_statement_yours')}{state.triageExists ? ` · ${t('orders.dispute_statement_locked')}` : ''}</Text><Text className="mt-1 text-sm text-foreground">{mine.body}</Text></View>
      ) : null}
      {notice ? <Text className="text-xs text-success">{notice}</Text> : null}
      <View className="rounded-lg border border-gray-200 bg-background p-3">
        <Text className="text-xs font-medium text-foreground-secondary">{t('orders.dispute_statement_other_title')}</Text>
        <Text className="mt-1 text-sm text-foreground">{other ? other.body : t('orders.dispute_statement_other_none')}</Text>
      </View>
    </View>
  )
}

function Stars({ value, onSelect }: { value: number; onSelect?: (n: number) => void }) {
  return (
    <View className="flex-row gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <TouchableOpacity key={n} disabled={!onSelect} onPress={() => onSelect?.(n)}>
          <Text className={`text-2xl ${n <= value ? 'text-amber-500' : 'text-gray-300'}`}>★</Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}

/** Review prompt/form for the buyer; posted review + provider reply for both. */
function ReviewBlock({ orderId }: { orderId: string }) {
  const { t } = useI18n()
  const [review, setReview] = useState<any>(null)
  const [canReview, setCanReview] = useState(false)
  const [isProvider, setIsProvider] = useState(false)
  const [rating, setRating] = useState(0)
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const d = await fetchOrderReview(orderId)
    setReview(d.review); setCanReview(!!d.canReview); setIsProvider(!!d.isProvider)
  }, [orderId])
  // Deferred: keeps setState off the effect's synchronous path.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  async function send() {
    if (rating < 1) { Alert.alert(t('reviews.pick_rating')); return }
    setBusy(true)
    const { ok, data } = await submitReview(orderId, rating, text.trim() || undefined)
    setBusy(false)
    if (!ok) { Alert.alert(t('common.error'), data.error ?? t('reviews.failed')); return }
    load()
  }

  async function sendReply() {
    if (!reply.trim()) return
    setBusy(true)
    const { ok, data } = await replyReview(review.id, reply.trim())
    setBusy(false)
    if (!ok) { Alert.alert(t('common.error'), data.error ?? t('reviews.failed')); return }
    load()
  }

  if (!review && !canReview) return null

  return (
    <View className="rounded-xl border border-gray-200 bg-surface p-4 gap-2">
      <Text className="text-sm font-semibold text-foreground">{t('reviews.heading')}</Text>

      {!review && canReview && (
        <View className="gap-2">
          <Text className="text-sm text-foreground-secondary">{t('reviews.prompt')}</Text>
          <Stars value={rating} onSelect={setRating} />
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={t('reviews.text_placeholder')}
            placeholderTextColor="#9CA3AF"
            className="min-h-[64px] rounded-lg border border-gray-200 bg-background p-3 text-sm text-foreground"
          />
          <TouchableOpacity onPress={send} disabled={busy} className={`items-center rounded-lg py-3 ${busy ? 'bg-primary/60' : 'bg-primary'}`}>
            <Text className="text-sm font-semibold text-white">{t('reviews.submit')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {review && (
        <View className="gap-2">
          {review.status !== 'published' && <Text className="text-xs text-yellow-700">{t('reviews.status_flagged')}</Text>}
          <Stars value={review.rating} />
          {review.text ? <Text className="text-sm text-foreground">{review.text}</Text> : null}
          {review.provider_reply ? (
            <View className="rounded-lg border-l-2 border-primary/40 bg-primary/5 px-3 py-2">
              <Text className="text-xs font-medium text-primary">{t('reviews.provider_reply')}</Text>
              <Text className="text-sm text-foreground">{review.provider_reply}</Text>
            </View>
          ) : isProvider ? (
            <View className="gap-2">
              <TextInput
                value={reply}
                onChangeText={setReply}
                multiline
                placeholder={t('reviews.reply_placeholder')}
                placeholderTextColor="#9CA3AF"
                className="min-h-[48px] rounded-lg border border-gray-200 bg-background p-3 text-sm text-foreground"
              />
              <TouchableOpacity onPress={sendReply} disabled={busy} className="items-center rounded-lg border border-primary py-2.5">
                <Text className="text-sm font-semibold text-primary">{t('reviews.reply_submit')}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      )}
    </View>
  )
}
 
