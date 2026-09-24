'use client'

import { useState, useRef, useEffect, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { addonSnapshotSchema, nextAction, nextStepTarget, orderIsActive, parseOrderTab, pickI18n, providerMoneyLine, REFUND_POLICY_BPS, visibleOrderTabs, type OrderStatus, type OrderTab } from '@amclub/shared'
import { NudgeButton } from '@/components/orders/NudgeButton'
import { Link, useRouter } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmSheet } from '@/components/ui/confirm-sheet'
import { useToast } from '@/components/ui/toast'
import { ReviewSection } from './ReviewSection'
import { MilestonesCard } from './MilestonesCard'
import { DisputeStatementCard } from './DisputeStatementCard'
import { RequirementsForm, RequirementsCard } from './RequirementsForm'
import { actionsFor, CONFIRM_ACTIONS, REASON_ACTIONS, REASON_MIN, REASON_MAX, type OrderActionKey } from './order-actions'
import { GoodsOrderWorkspace } from '@/components/mart/GoodsOrderWorkspace'
import type { GoodsOrderExtras } from '@/lib/mart/order-extras'
import type { ServicesOrderExtras } from '@/lib/orders/queries'
import { useAnalytics } from '@/components/providers/posthog'
import { NextStepBar, type BarAction } from '@/components/orders-v3/NextStepBar'
import { SectionTabs } from '@/components/orders-v3/SectionTabs'
import { GoldThread } from '@/components/orders-v3/GoldThread'
import { BuyerMoneyLine, ProviderMoneyLineView } from '@/components/orders-v3/MoneyLine'
import { OrderMessages } from '@/components/orders-v3/OrderMessages'

/** E8b — order messaging for this viewer (server-decided: `orders` experience + order_messaging_enabled) and the unread count. */
export interface OrderMessagingProp { on: boolean; unread: number }
const MESSAGING_OFF: OrderMessagingProp = { on: false, unread: 0 }

interface OrderEvent {
  id: string
  event: string
  created_at: string
  actor_id: string | null
}

const STATUS_VARIANT: Partial<Record<OrderStatus, 'default' | 'success' | 'warning' | 'danger' | 'info'>> = {
  placed: 'info', accepted: 'info', requirements_submitted: 'info', in_progress: 'warning',
  delivered: 'warning', revision_requested: 'warning', completed: 'success', reviewed: 'success',
  disputed: 'danger', refunded: 'default', auto_cancelled: 'default', cancelled_by_buyer: 'default',
  resolved_refund: 'default', resolved_release: 'success', resolved_partial: 'default',
  cancelled_duplicate: 'default',
}

const ACTION_VARIANT: Partial<Record<OrderActionKey, 'primary' | 'danger' | 'outline'>> = {
  request_revision: 'outline',
  cancel: 'danger',
  raise_dispute: 'outline',
}

interface DocItem { id: string; file_name: string; kind: string; signedUrl: string | null }

// Timeline event → translation key. Every event name written by addEvent /
// order_events inserts on the services spine has an entry; anything else falls
// back to the generic `event_other` (never the raw event name).
const EVENT_LABEL: Record<string, string> = {
  placed: 'status_placed',
  accept: 'status_accepted',
  submit_requirements: 'status_requirements_submitted',
  requirements_submitted: 'status_requirements_submitted',
  start: 'status_in_progress',
  deliver: 'status_delivered',
  document_uploaded: 'event_document',
  accept_delivery: 'status_completed',
  auto_accepted: 'event_auto_accepted',
  request_revision: 'status_revision_requested',
  resume: 'status_in_progress',
  cancel: 'status_cancelled_by_buyer',
  auto_cancelled: 'status_auto_cancelled',
  cancelled_duplicate: 'status_cancelled_duplicate',
  refunded: 'status_refunded',
  manual_refund: 'event_manual_refund',
  raise_dispute: 'status_disputed',
  dispute_statement: 'event_dispute_statement',
  resolved_refund: 'status_resolved_refund',
  resolved_release: 'status_resolved_release',
  resolved_partial: 'status_resolved_partial',
  external_wait: 'event_external_wait',
  external_resume: 'event_external_resume',
  milestone_added: 'event_milestone_added',
  nudged: 'event_nudged',
  payout_held: 'event_payout_held',
  payout_scheduled: 'event_payout_scheduled',
  payout_released: 'event_payout_released',
  payout_paid: 'event_payout_paid',
  payout_failed: 'event_payout_failed',
  payout_voided: 'event_payout_voided',
}

// Internal markers (and the requirements payload, which submit_requirements
// already represents) never appear in the timeline. The two ops flags written by
// finalizeQuoteAcceptance are for the admin queue; the buyer gets a notification.
// ADR 026: refund_failed / invoice_failed / payout_unconfirmed are ops markers
// (the sweepers finish the work); the parties see the outcome, not the retries.
const HIDDEN_EVENTS = new Set([
  'placed_side_effects', 'requirements_data', 'duplicate_rfq_order', 'quote_not_live_at_payment', 'refund_failed', 'invoice_failed', 'payout_unconfirmed',
  // ADR 027: gateway truth recorded for ops (a second capture, a closed RFQ at payment, refund / transfer / chargeback webhooks).
  'duplicate_capture', 'rfq_not_live_at_payment', 'refund_confirmed', 'payout_partially_reversed', 'chargeback_opened', 'chargeback_lost', 'chargeback_won', 'chargeback_closed',
])
// Provider-money events are shown to the provider only.
const PROVIDER_ONLY_EVENTS = new Set(['payout_held', 'payout_scheduled', 'payout_released', 'payout_paid', 'payout_failed', 'payout_voided'])

// Events that represent EXTERNAL (government/portal) time, not provider time.
const EXTERNAL_EVENTS = new Set(['external_wait', 'external_resume'])

const EMPTY_EXTRAS: ServicesOrderExtras = { requirementsTemplate: [], requirements: null, lastRevisionNote: null, refund: null, disputeWindowEndsAt: null, payout: null }

function istDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export function OrderWorkspace({
  order,
  events,
  viewerRole,
  documents,
  goods,
  firstView,
  extras,
  v3,
  initialTab,
  messaging,
}: {
  order: Record<string, unknown>
  events: OrderEvent[]
  viewerRole: 'msme' | 'provider'
  documents: DocItem[]
  /** E8b — order messaging (only with v3). */
  messaging?: OrderMessagingProp | undefined
  /** AMC Mart only — extra facts for goods orders (undefined for services). */
  goods?: GoodsOrderExtras | undefined
  firstView?: boolean | undefined
  /** Services only — requirements, revision note, refund (server-derived). */
  extras?: ServicesOrderExtras | undefined
  /** PRD Experience v3 E8 (flag `orders`) — NextStepBar + section tabs. Services only. */
  v3?: boolean | undefined
  /** `?tab=` from the URL (E8). */
  initialTab?: string | undefined
}) {
  // AMC Mart: goods orders render their own workspace (kind-parameterised
  // shared page, FRONTEND.md §8). Services orders (kind='service') never
  // take this branch.
  if (order['kind'] === 'goods') {
    return <GoodsOrderWorkspace order={order} events={events} viewerRole={viewerRole} documents={documents} goods={goods} firstView={firstView ?? false} />
  }
  return (
    <ServicesOrderWorkspace
      order={order}
      events={events}
      viewerRole={viewerRole}
      documents={documents}
      firstView={firstView ?? false}
      extras={extras ?? EMPTY_EXTRAS}
      v3={v3 ?? false}
      initialTab={initialTab}
      messaging={v3 ? (messaging ?? MESSAGING_OFF) : MESSAGING_OFF}
    />
  )
}

function ServicesOrderWorkspace({
  order,
  events,
  viewerRole,
  documents,
  firstView,
  extras,
  v3,
  initialTab,
  messaging,
}: {
  order: Record<string, unknown>
  events: OrderEvent[]
  viewerRole: 'msme' | 'provider'
  documents: DocItem[]
  firstView: boolean
  extras: ServicesOrderExtras
  v3: boolean
  initialTab: string | undefined
  messaging: OrderMessagingProp
}) {
  const t = useTranslations('orders')
  const to = useTranslations('orders_v3')
  const posthog = useAnalytics()
  // E8 — the tab lives in the URL (?tab=), so a link or a refresh opens the same section.
  const messagesOn = messaging.on
  const [tab, setTab] = useState<OrderTab>(parseOrderTab(initialTab, { messagesOn }))
  const [unread, setUnread] = useState(messaging.unread)
  const viewedRef = useRef(false)
  const router = useRouter()
  const { toast } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<OrderActionKey | null>(null)
  const [reason, setReason] = useState('')
  const [sheetError, setSheetError] = useState<string | null>(null)
  const [showWelcome, setShowWelcome] = useState(firstView && viewerRole === 'msme')
  const fileRef = useRef<HTMLInputElement>(null)

  const id = order['id'] as string
  const status = order['status'] as string
  useEffect(() => {
    if (!v3 || viewedRef.current) return
    viewedRef.current = true
    posthog.capture('order_viewed', { status, role: viewerRole, device: 'web' })
  }, [v3, status, viewerRole, posthog])
  const totalPaise = Number(order['total_paise'])
  const earningPaise = Number(order['provider_earning_paise'])
  const revisionUsed = Number(order['revision_used'] ?? 0)
  const revisionMax = order['revision_max'] == null ? null : Number(order['revision_max'])
  // Server rule (applyTransition): revision_used >= (revision_max ?? 0) is rejected.
  const revisionsLeft = Math.max(0, (revisionMax ?? 0) - revisionUsed)
  const autoAcceptAt = typeof order['auto_accept_at'] === 'string' ? (order['auto_accept_at'] as string) : null
  const deliveryDays = order['delivery_days'] == null ? null : Number(order['delivery_days'])
  const hasDeliverable = documents.some((d) => d.kind === 'deliverable')
  // E12a / ADR 019 — the add-ons this order was bought with (frozen snapshot; absent = none).
  const locale = useLocale()
  const addonSnap = addonSnapshotSchema.safeParse(order['addons'] ?? [])
  const boughtAddons = addonSnap.success ? addonSnap.data : []
  // E12c — a milestone of a plan: its number, and when it becomes actionable (absent = not a plan).
  const bundleSeq = order['bundle_seq'] == null ? null : Number(order['bundle_seq'])
  const startsAt = typeof order['available_at'] === 'string' && new Date(order['available_at'] as string).getTime() > Date.now() ? (order['available_at'] as string) : null

  const disputeEndsAt = extras.disputeWindowEndsAt
  const actions = actionsFor(viewerRole, status, { revisionsLeft, disputeWindowEndsAt: disputeEndsAt })
  // ADR-014 (H2) — the buyer sees how long they can still report a problem on a completed order.
  const disputeDeadline = viewerRole === 'msme' && status === ('completed' satisfies OrderStatus) && disputeEndsAt && actions.includes('raise_dispute') ? istDateTime(disputeEndsAt) : null
  const showRequirementsForm = actions.includes('submit_requirements')
  const buttonActions = actions.filter((a) => a !== 'submit_requirements')
  // External/government wait is a DISPLAY sub-state on in_progress (LOCK 5).
  const isInProgress = status === ('in_progress' satisfies OrderStatus)
  const isDelivered = status === ('delivered' satisfies OrderStatus)
  const isDisputed = status === ('disputed' satisfies OrderStatus)
  const externalWait = isInProgress && !!order['external_wait_since']
  const statusVariant = externalWait ? 'warning' : (STATUS_VARIANT[status as OrderStatus] ?? 'default')
  const statusKey = `status_${status}`
  const statusLabel = externalWait ? t('status_external_wait') : t.has(statusKey as 'status_placed') ? t(statusKey as 'status_placed') : status
  const nextKey = `next_${viewerRole}_${status}`
  const nextLine = t.has(nextKey as 'next_msme_placed') ? t(nextKey as 'next_msme_placed') : null

  const visibleEvents = events.filter(
    (e) => !HIDDEN_EVENTS.has(e.event) && (viewerRole === 'provider' || !PROVIDER_ONLY_EVENTS.has(e.event)),
  )

  async function toggleExternalWait(active: boolean) {
    setBusy('external_wait')
    setError('')
    try {
      const res = await fetch(`/api/v1/orders/${id}/external-wait`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(typeof d.error === 'string' ? d.error : t('action_failed'))
      }
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('action_failed'))
    } finally {
      setBusy(null)
    }
  }

  /** POST the action; returns an error message or null. */
  async function postAction(action: OrderActionKey, note?: string): Promise<string | null> {
    const body: Record<string, unknown> = { action }
    if (note && action === 'request_revision') body['revisionNote'] = note
    if (note && action === 'raise_dispute') body['disputeReason'] = note
    try {
      const res = await fetch(`/api/v1/orders/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) return d.error === 'dispute_window_closed' ? t('dispute_window_closed') : typeof d.error === 'string' ? d.error : t('action_failed')
      return null
    } catch {
      return t('action_failed')
    }
  }

  async function doAction(action: OrderActionKey) {
    if (CONFIRM_ACTIONS.has(action)) {
      setReason('')
      setSheetError(null)
      setPending(action)
      return
    }
    setBusy(action)
    setError('')
    const err = await postAction(action)
    setBusy(null)
    if (err) { setError(err); return }
    toast(t(`done_${action}` as 'done_start'), 'success')
    router.refresh()
  }

  async function confirmPending() {
    if (!pending) return
    const note = reason.trim()
    if (REASON_ACTIONS.has(pending) && note.length < REASON_MIN) {
      setSheetError(t('reason_min', { min: REASON_MIN }))
      return
    }
    setBusy(pending)
    setSheetError(null)
    const err = await postAction(pending, REASON_ACTIONS.has(pending) ? note : undefined)
    setBusy(null)
    if (err) { setSheetError(err); return }
    toast(t(`done_${pending}` as 'done_start'), 'success')
    setPending(null)
    router.refresh()
  }

  async function uploadDoc(kind: string, file: File) {
    setBusy('upload')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', kind)
      const res = await fetch(`/api/v1/orders/${id}/documents`, { method: 'POST', body: fd })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(typeof d.error === 'string' ? d.error : t('upload_failed'))
      }
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('upload_failed'))
    } finally {
      setBusy(null)
    }
  }

  // Cancel consequence: the policy line from the shared refund matrix (a
  // percentage, never a computed rupee amount).
  const cancelBps = REFUND_POLICY_BPS[status as OrderStatus] ?? 0
  const cancelPolicy =
    cancelBps >= 10000 ? t('cancel_policy_full') : cancelBps > 0 ? t('cancel_policy_partial', { pct: cancelBps / 100 }) : t('cancel_policy_none')

  const sheet = pending ? confirmCopy(pending) : null
  function confirmCopy(a: OrderActionKey): { title: string; description: ReactNode; confirm: string; danger?: boolean } {
    switch (a) {
      case 'accept_delivery':
        return {
          title: t('confirm_accept_delivery_title'),
          description: t('confirm_accept_delivery_body', { amount: formatINR(totalPaise) }),
          confirm: t('confirm_accept_delivery_cta'),
        }
      case 'cancel':
        return { title: t('confirm_cancel_title'), description: cancelPolicy, confirm: t('confirm_cancel_cta'), danger: true }
      case 'request_revision':
        return {
          title: t('confirm_request_revision_title'),
          description: t('confirm_request_revision_body', { left: Math.max(0, revisionsLeft - 1) }),
          confirm: t('confirm_request_revision_cta'),
        }
      case 'raise_dispute':
        return { title: t('confirm_raise_dispute_title'), description: t('confirm_raise_dispute_body'), confirm: t('confirm_raise_dispute_cta'), danger: true }
      case 'accept':
        return {
          title: t('confirm_accept_title'),
          description: deliveryDays != null
            ? t('confirm_accept_body', { days: deliveryDays, amount: formatINR(earningPaise) })
            : t('confirm_accept_body_nodays', { amount: formatINR(earningPaise) }),
          confirm: t('confirm_accept_cta'),
        }
      case 'deliver':
        return { title: t('confirm_deliver_title'), description: t('confirm_deliver_body'), confirm: t('confirm_deliver_cta') }
      default:
        return { title: t(`action_${a}` as 'action_accept'), description: null, confirm: t(`action_${a}` as 'action_accept') }
    }
  }

  // ── Blocks shared by the v2 page and the v3 tabs (E8); v2 renders them in its original order. ──
  const welcomeBlock = (<>
      {/* First view after payment (?first=1) — the "money is safe" moment. */}
      {showWelcome && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-card border border-success/30 bg-success/10 p-4 text-sm">
          <div>
            <p className="font-semibold text-success">{t('first_view_title')}</p>
            <p className="mt-1 text-foreground">{t('first_view_body')}</p>
          </div>
          <button
            type="button"
            onClick={() => setShowWelcome(false)}
            className="min-h-[44px] shrink-0 px-2 text-sm font-medium text-foreground-secondary underline-offset-2 hover:underline"
          >
            {t('dismiss')}
          </button>
        </div>
      )}
    </>)
  const refundBlock = (<>
      {/* Refund (buyer) — server paise from the refunds row. */}
      {viewerRole === 'msme' && extras.refund && (
        <div className="rounded-card border border-border bg-surface p-5 shadow-card text-sm">
          <h2 className="text-sm font-semibold">{t('refund_title')}</h2>
          <p className="mt-2">
            <span className="font-medium">{formatINR(extras.refund.amountPaise)}</span>
            {' · '}
            {t.has(`refund_status_${extras.refund.status}` as 'refund_status_pending')
              ? t(`refund_status_${extras.refund.status}` as 'refund_status_pending')
              : t('refund_status_pending')}
          </p>
          <p className="mt-1 text-xs text-foreground-secondary">{t('refund_note')}</p>
        </div>
      )}
    </>)
  const revisionNoteBlock = (<>
      {/* Latest revision note (both parties see what was asked). */}
      {extras.lastRevisionNote && revisionUsed > 0 && (
        <div className="rounded-card border border-warning/30 bg-warning/5 p-5 text-sm">
          <h2 className="text-sm font-semibold">{t('revision_note_title')}</h2>
          <p className="mt-1 whitespace-pre-wrap">{extras.lastRevisionNote}</p>
        </div>
      )}
    </>)
  const requirementsCardBlock = (<>
      {/* Submitted requirements — both parties (the "Next:" line tells the provider when they're still awaited). */}
      {extras.requirements && <RequirementsCard requirements={extras.requirements} />}
    </>)
  const disputeBlock = (<>
      {/* S1.7 — party statements while the dispute is open (spine; one per party; editable until a triage exists) */}
      {isDisputed && <DisputeStatementCard orderId={id} documents={documents.map((d) => ({ id: d.id, file_name: d.file_name }))} />}
    </>)
  const milestonesBlock = (<>
      {/* Services evidence engine (S0.3): staged milestones with photo proof. */}
      <MilestonesCard orderId={id} role={viewerRole} orderStatus={status} />
    </>)
  const reviewBlock = (<>
      {/* Reviews — prompt/form for the buyer on completion; reply box for the provider */}
      {(status === ('completed' satisfies OrderStatus) || status === ('reviewed' satisfies OrderStatus)) && <ReviewSection orderId={id} />}
    </>)
  const documentsBlock = (<>
      {/* Documents */}
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold">{t('documents')}</h2>
        {documents.length === 0 ? (
          <p className="text-sm text-foreground-secondary">{t('no_documents')}</p>
        ) : (
          <ul className="space-y-2">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between text-sm">
                <span>📎 {d.file_name} <span className="text-xs text-foreground-secondary">({t.has(`doc_kind_${d.kind}` as 'doc_kind_other') ? t(`doc_kind_${d.kind}` as 'doc_kind_other') : t('doc_kind_other')})</span></span>
                {d.signedUrl && <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="text-trust underline">{t('download')}</a>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>)
  const timelineBlock = (<>
      {/* Timeline */}
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold">{t('timeline')}</h2>
        <ol className="space-y-3">
          {visibleEvents.map((e) => {
            const isExternal = EXTERNAL_EVENTS.has(e.event)
            const key = EVENT_LABEL[e.event]
            return (
              <li key={e.id} className="flex gap-3 text-sm">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${isExternal ? 'bg-warning' : 'bg-primary'}`} />
                <div>
                  <p className="font-medium">
                    {key ? t(key as 'status_placed') : t('event_other')}
                    {isExternal && (
                      <span className="ml-2 rounded-chip bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                        {t('external_time_tag')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-foreground-secondary">
                    {new Date(e.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </>)
  const confirmBlock = (<>
      {/* D2 — confirm + consequence for every irreversible / money-moving action. */}
      {sheet && pending && (
        <ConfirmSheet
          open
          title={sheet.title}
          description={sheet.description}
          confirmLabel={sheet.confirm}
          cancelLabel={t('confirm_back')}
          onConfirm={confirmPending}
          onClose={() => { if (!busy) setPending(null) }}
          busy={busy === pending}
          error={sheetError}
          variant={sheet.danger ? 'danger' : 'primary'}
          confirmDisabled={REASON_ACTIONS.has(pending) && reason.trim().length < REASON_MIN}
        >
          {REASON_ACTIONS.has(pending) && (
            <div>
              <label htmlFor="order-action-reason" className="block text-sm font-medium">
                {pending === 'raise_dispute' ? t('dispute_reason_label') : t('revision_reason_label')}
              </label>
              <textarea
                id="order-action-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
                rows={4}
                className="mt-1 w-full rounded-button border border-border bg-background p-3 text-sm"
              />
              <p className="mt-1 text-xs text-foreground-secondary">{t('reason_hint', { min: REASON_MIN, max: REASON_MAX, n: reason.trim().length })}</p>
            </div>
          )}
          {pending === 'deliver' && !hasDeliverable && (
            <p className="rounded-button bg-warning/10 px-3 py-2 text-sm text-warning">{t('confirm_deliver_no_file')}</p>
          )}
        </ConfirmSheet>
      )}
    </>)

  // ── E8 v3: NextStepBar + section tabs (flag `orders`). Same actions, same routes, same confirm sheets. ──
  function renderV3() {
    const role = viewerRole === 'msme' ? 'buyer' : 'provider'
    const next = nextAction(status, role, {
      createdAt: String(order['created_at'] ?? ''),
      dueAt: typeof order['due_at'] === 'string' ? (order['due_at'] as string) : null,
      autoAcceptAt,
      externalWaitSince: typeof order['external_wait_since'] === 'string' ? (order['external_wait_since'] as string) : null,
      kind: 'service',
    })
    const target = next && next.actor === 'self' ? nextStepTarget(next.action) : null
    const tabs = visibleOrderTabs({ messagesOn })
    const selectTab = (v: OrderTab) => {
      setTab(v)
      posthog.capture('order_tab_viewed', { tab: v, device: 'web' })
      try {
        const u = new URL(window.location.href)
        if (v === 'overview') u.searchParams.delete('tab')
        else u.searchParams.set('tab', v)
        window.history.replaceState(null, '', u.toString())
      } catch { /* history unavailable — the tab still switches */ }
    }
    const clicked = (action: string) => posthog.capture('order_next_action_clicked', { action, device: 'web' })

    let primary: BarAction | null = null
    if (next && target?.kind === 'action' && actions.includes(target.action)) {
      const a = target.action
      primary = { key: a, label: t(`action_${a}` as 'action_accept'), loading: busy === a, onSelect: () => { clicked(next.action); void doAction(a) } }
    } else if (next && target?.kind === 'tab') {
      const tabTarget = target.tab
      primary = { key: `tab_${tabTarget}`, label: to(`go_${next.action}` as 'go_share_requirements'), onSelect: () => { clicked(next.action); selectTab(tabTarget) } }
    }
    const secondary: BarAction[] = buttonActions
      .filter((a) => a !== primary?.key)
      .map((a) => ({
        key: a,
        label: a === 'raise_dispute' ? to('report_problem') : t(`action_${a}` as 'action_accept'),
        danger: a === 'cancel',
        onSelect: () => { void doAction(a) },
      }))
    if (viewerRole === 'provider' && isInProgress) {
      secondary.push({ key: 'external_wait', label: externalWait ? t('action_resume_external') : t('action_mark_external_wait'), onSelect: () => { void toggleExternalWait(!externalWait) } })
    }

    const moneyLine = viewerRole === 'provider'
      ? <ProviderMoneyLineView line={providerMoneyLine({ status, totalPaise, payout: extras.payout })} />
      : <BuyerMoneyLine totalPaise={totalPaise} active={orderIsActive(status)} />
    const panel = (v: OrderTab, children: ReactNode) => (
      <div role="tabpanel" id={`order-panel-${v}`} aria-labelledby={`order-tab-${v}`} hidden={tab !== v} className="space-y-4 pt-4" data-panel={v}>
        {children}
      </div>
    )
    const deliverables = documents.filter((d) => d.kind === 'deliverable')

    return (
      <div className="mx-auto max-w-3xl px-4 py-6" data-testid="order-v3">
        {welcomeBlock}
        <div className="pb-3 pt-2">
          <p className="text-xs text-foreground-secondary">{String(order['order_number'])}</p>
          <h1 className="font-display text-xl font-bold">{String(order['title'])}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant}>{statusLabel}</Badge>
            {typeof order['due_at'] === 'string' && orderIsActive(status) && (
              <span className="t-footnote text-foreground-secondary">{to('due_on', { when: istDateTime(order['due_at'] as string) })}</span>
            )}
          </div>
        </div>

        <NextStepBar next={next} primary={primary} secondary={secondary} />
        {error && <p role="alert" className="pt-2 text-sm text-danger">{error}</p>}

        <div className="pt-3">
          <SectionTabs idPrefix="order" label={to('sections_label')} value={tab} onChange={selectTab} tabs={tabs.map((v) => ({ value: v, label: to(`tab_${v}`), ...(v === 'messages' && unread > 0 ? { badge: unread } : {}) }))} />
        </div>

        {panel('overview', (
          <>
            <div className="space-y-3 rounded-card bg-surface p-5 shadow-card" data-testid="order-overview">
              {moneyLine}
              {externalWait && <p className="rounded-button bg-warning/10 px-3 py-2 text-xs text-warning">{t('external_wait_banner')}</p>}
              {isDelivered && autoAcceptAt && (
                <p className="text-sm text-foreground-secondary">
                  {viewerRole === 'msme' ? t('auto_accept_buyer', { when: istDateTime(autoAcceptAt) }) : t('auto_accept_provider', { when: istDateTime(autoAcceptAt) })}
                </p>
              )}
              <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                <div><dt className="text-foreground-secondary">{t('total')}</dt><dd className="font-medium tabular-nums">{formatINR(totalPaise)}</dd></div>
                {viewerRole === 'provider' && <div><dt className="text-foreground-secondary">{t('you_earn')}</dt><dd className="font-medium tabular-nums">{formatINR(earningPaise)}</dd></div>}
                {revisionMax != null && <div><dt className="text-foreground-secondary">{t('revisions')}</dt><dd className="font-medium">{t('revisions_used', { used: revisionUsed, max: revisionMax })}</dd></div>}
              </dl>
              {bundleSeq != null && (
                <p className="border-t border-border pt-3 text-sm" data-testid="order-milestone">
                  {to('milestone_line', { seq: bundleSeq })}
                  {startsAt && <span className="text-foreground-secondary"> · {to('milestone_starts', { date: istDateTime(startsAt) })}</span>}
                  {viewerRole === 'msme' && <> · <Link href="/app/plans" className="font-medium text-primary hover:underline">{to('milestone_view_plan')}</Link></>}
                </p>
              )}
              {boughtAddons.length > 0 && (
                <div className="border-t border-border pt-3 text-sm" data-testid="order-addons">
                  <p className="text-foreground-secondary">{to('addons_title')}</p>
                  <ul className="mt-1 space-y-1">
                    {boughtAddons.map((a) => (
                      <li key={a.id} className="flex justify-between gap-3">
                        <span>{pickI18n(a.label, locale)}</span>
                        <span className="tabular-nums">{formatINR(a.pricePaise)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {disputeDeadline && <p className="text-xs text-foreground-secondary" data-testid="order-dispute-deadline">{t('dispute_window_until', { date: disputeDeadline })}</p>}
              {orderIsActive(status) && <div><NudgeButton subjectKind="order" subjectId={id} /></div>}
            </div>
            {refundBlock}
            {revisionNoteBlock}
            {disputeBlock}
            {reviewBlock}
          </>
        ))}
        {panel('requirements', (
          <>
            {showRequirementsForm && (
              <div className="rounded-card bg-surface p-5 shadow-card"><RequirementsForm orderId={id} template={extras.requirementsTemplate} /></div>
            )}
            {requirementsCardBlock}
            {!showRequirementsForm && !extras.requirements && <p className="text-sm text-foreground-secondary">{to('requirements_none')}</p>}
          </>
        ))}
        {panel('work', (
          <>
            {viewerRole === 'provider' && isInProgress && (
              <div className="space-y-3 rounded-card bg-surface p-5 shadow-card">
                <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadDoc('deliverable', f) }} />
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => fileRef.current?.click()} loading={busy === 'upload'}>{t('attach_deliverable')}</Button>
                  {actions.includes('deliver') && <Button onClick={() => { void doAction('deliver') }} loading={busy === 'deliver'}>{t('action_deliver')}</Button>}
                </div>
              </div>
            )}
            {deliverables.length > 0 && (
              <div className="rounded-card bg-surface p-5 shadow-card">
                <h2 className="mb-2 text-sm font-semibold">{to('deliverables')}</h2>
                <ul className="space-y-2">
                  {deliverables.map((d) => (
                    <li key={d.id} className="flex items-center justify-between text-sm">
                      <span>📎 {d.file_name}</span>
                      {d.signedUrl && <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="text-trust underline">{t('download')}</a>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {milestonesBlock}
          </>
        ))}
        {messagesOn && panel('messages', (
          <OrderMessages orderId={id} active={tab === 'messages'} documents={documents.map((d) => ({ id: d.id, file_name: d.file_name }))} onUnreadChange={setUnread} />
        ))}
        {panel('documents', documentsBlock)}
        {panel('timeline', (
          <>
            <div className="rounded-card bg-surface p-5 shadow-card"><GoldThread status={status} eventNames={events.map((e) => e.event)} /></div>
            {timelineBlock}
          </>
        ))}

        {confirmBlock}
      </div>
    )
  }

  if (v3) return renderV3()

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      {welcomeBlock}

      {/* Header */}
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-foreground-secondary">{String(order['order_number'])}</p>
            <h1 className="font-display text-xl font-bold">{String(order['title'])}</h1>
          </div>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>
        {nextLine && (
          <p className="mt-3 rounded-button bg-primary/5 px-3 py-2 text-sm font-medium" data-testid="order-next-step">{nextLine}</p>
        )}
        {disputeDeadline && (
          <p className="mt-2 text-xs text-foreground-secondary" data-testid="order-dispute-deadline">{t('dispute_window_until', { date: disputeDeadline })}</p>
        )}
        {externalWait && (
          <p className="mt-3 rounded-button bg-warning/10 px-3 py-2 text-xs text-warning">
            {t('external_wait_banner')}
          </p>
        )}
        {isDelivered && autoAcceptAt && (
          <p className="mt-3 text-sm text-foreground-secondary">
            {viewerRole === 'msme' ? t('auto_accept_buyer', { when: istDateTime(autoAcceptAt) }) : t('auto_accept_provider', { when: istDateTime(autoAcceptAt) })}
          </p>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-4 text-sm">
          <div><dt className="text-foreground-secondary">{t('total')}</dt><dd className="font-medium">{formatINR(totalPaise)}</dd></div>
          {viewerRole === 'provider' && (
            <div><dt className="text-foreground-secondary">{t('you_earn')}</dt><dd className="font-medium">{formatINR(earningPaise)}</dd></div>
          )}
          {revisionMax != null && (
            <div>
              <dt className="text-foreground-secondary">{t('revisions')}</dt>
              <dd className="font-medium">{t('revisions_used', { used: revisionUsed, max: revisionMax })}</dd>
            </div>
          )}
        </dl>
      </div>

      {refundBlock}

      {revisionNoteBlock}

      {/* Actions */}
      {(actions.length > 0 || (viewerRole === 'provider' && isInProgress)) && (
        <div className="rounded-card border border-border bg-surface p-5 shadow-card space-y-3">
          <h2 className="text-sm font-semibold">{t('actions')}</h2>
          {showRequirementsForm && <RequirementsForm orderId={id} template={extras.requirementsTemplate} />}
          {/* Provider deliver flow: attach a deliverable */}
          {viewerRole === 'provider' && isInProgress && (
            <div>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadDoc('deliverable', f) }}
              />
              <Button variant="secondary" onClick={() => fileRef.current?.click()} loading={busy === 'upload'}>
                {t('attach_deliverable')}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {/* S2.3 — a fixed-template reminder to the other party (spine; once per 24 h). */}
            {orderIsActive(status) && <NudgeButton subjectKind="order" subjectId={id} />}
            {buttonActions.map((a) => (
              <Button key={a} variant={ACTION_VARIANT[a] ?? 'primary'} onClick={() => doAction(a)} loading={busy === a}>
                {t(`action_${a}` as 'action_accept')}
              </Button>
            ))}
            {/* Provider: flag/clear government-portal wait (display sub-state, LOCK 5) */}
            {viewerRole === 'provider' && isInProgress && (
              <Button
                variant="outline"
                onClick={() => toggleExternalWait(!externalWait)}
                loading={busy === 'external_wait'}
              >
                {externalWait ? t('action_resume_external') : t('action_mark_external_wait')}
              </Button>
            )}
          </div>
          {viewerRole === 'msme' && isDelivered && revisionMax != null && revisionsLeft === 0 && (
            <p className="text-xs text-foreground-secondary">{t('no_revisions_left')}</p>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      )}

      {requirementsCardBlock}

      {disputeBlock}

      {milestonesBlock}

      {reviewBlock}

      {documentsBlock}

      {timelineBlock}

      {confirmBlock}
    </div>
  )
}
