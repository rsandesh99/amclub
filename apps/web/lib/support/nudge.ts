import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { orderIsActive, rfqIsActive } from '@amclub/shared'
import { createNotification, createNotificationsBulk } from '@/lib/notifications/create'
import { addEvent } from '@/lib/orders/transitions'
import { recordAiDecision } from '@/lib/mart/events'
import { captureServerEvent } from '@/lib/analytics/server'
import { getSupportSettings } from '@/lib/support/settings'

/**
 * S2.3 — the counterparty nudge (spine; no flag). A fixed-template
 * notification to the other party of an ACTIVE order or request, at most
 * once per sender per subject per `support_nudge_cooldown_hours`. No free
 * text — the body is the subject title. The Support agent is just another
 * caller of the two routes that call this.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type NudgeResult =
  | { ok: true; nudgeId: string; recipients: number }
  | { ok: false; error: 'not_found' | 'not_a_party' | 'subject_inactive' | 'nudge_cooldown' | 'no_recipient'; retryAfterSec?: number; cooldownHours?: number }

async function cooldownLeft(admin: SupabaseClient, kind: 'order' | 'rfq', subjectId: string, fromUserId: string, hours: number): Promise<number> {
  const { data } = await admin.from('nudges').select('created_at').eq('subject_kind', kind).eq('subject_id', subjectId).eq('from_user_id', fromUserId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!data) return 0
  const until = new Date((data as { created_at: string }).created_at).getTime() + hours * 3600 * 1000
  return Math.max(0, Math.ceil((until - Date.now()) / 1000))
}

/**
 * The confirm click is linked to the ledger only when `support_message_id` is an
 * assistant turn in the caller's OWN thread; anything else is a plain nudge (no
 * ai_decisions row), so a client cannot attach an arbitrary id to the ledger.
 */
async function ownSupportMessage(admin: SupabaseClient, messageId: string | null | undefined, userId: string): Promise<string | null> {
  if (!messageId) return null
  const { data } = await admin.from('support_messages').select('id, role, thread:support_threads!inner(user_id)').eq('id', messageId).maybeSingle()
  const m = data as { id: string; role: string; thread: { user_id: string } | null } | null
  return m && m.role === 'assistant' && m.thread?.user_id === userId ? m.id : null
}

/** Has this user nudged the subject within the cooldown? (read for the support engine's lookups) */
export async function nudgeCapped(admin: SupabaseClient, kind: 'order' | 'rfq', subjectId: string, fromUserId: string): Promise<boolean> {
  const s = await getSupportSettings(admin)
  return (await cooldownLeft(admin, kind, subjectId, fromUserId, s.nudgeCooldownHours)) > 0
}

const COPY = {
  order: { title: { en: 'A gentle reminder on your order', hi: 'आपके ऑर्डर पर एक याद', te: 'మీ ఆర్డర్‌పై ఒక గుర్తు' }, body: (n: string) => ({ en: `The other party on order ${n} is waiting for an update. Please open the order and respond.`, hi: `ऑर्डर ${n} पर दूसरा पक्ष अपडेट की प्रतीक्षा में है। कृपया ऑर्डर खोलकर जवाब दें।`, te: `ఆర్డర్ ${n} పై అవతలి పక్షం అప్‌డేట్ కోసం వేచి ఉంది. దయచేసి ఆర్డర్ తెరిచి స్పందించండి.` }) },
  rfq: { title: { en: 'A gentle reminder on a request', hi: 'एक माँग पर एक याद', te: 'ఒక అభ్యర్థనపై ఒక గుర్తు' }, body: (t: string) => ({ en: `"${t}" is waiting for your response. Please open the request and quote or decline.`, hi: `"${t}" आपके जवाब की प्रतीक्षा में है। कृपया माँग खोलकर कोटेशन दें या अस्वीकार करें।`, te: `"${t}" మీ స్పందన కోసం వేచి ఉంది. దయచేసి అభ్యర్థన తెరిచి కొటేషన్ ఇవ్వండి లేదా తిరస్కరించండి.` }) },
  rfq_buyer: { title: { en: 'A provider is waiting on your request', hi: 'एक प्रोवाइडर आपकी माँग पर प्रतीक्षा में है', te: 'ఒక ప్రొవైడర్ మీ అభ్యర్థనపై వేచి ఉన్నారు' }, body: (t: string) => ({ en: `A provider who quoted on "${t}" is waiting for your decision. Please compare the quotes and accept one.`, hi: `"${t}" पर कोटेशन देने वाला प्रोवाइडर आपके फैसले की प्रतीक्षा में है। कृपया कोटेशन की तुलना कर एक स्वीकार करें।`, te: `"${t}" పై కొటేషన్ ఇచ్చిన ప్రొవైడర్ మీ నిర్ణయం కోసం వేచి ఉన్నారు. దయచేసి కొటేషన్లు పోల్చి ఒకటి ఆమోదించండి.` }) },
}

export interface NudgeArgs {
  userId: string
  actor: { msmeId: string | null; providerId: string | null }
  /** The Support agent's confirm click carries the message id → ONE ai_decisions row (feature support_nudge). */
  supportMessageId?: string | null
  via: 'web' | 'mobile' | 'whatsapp' | 'agent'
}

export async function nudgeOrder(admin: SupabaseClient, orderId: string, args: NudgeArgs): Promise<NudgeResult> {
  const { data: o } = await admin.from('orders').select('id, order_number, status, msme_id, provider_id, msme:msme_profiles!inner(user_id), provider:provider_profiles!inner(user_id)').eq('id', orderId).maybeSingle()
  const order = o as any
  if (!order) return { ok: false, error: 'not_found' }
  const isBuyer = !!args.actor.msmeId && order.msme_id === args.actor.msmeId
  const isProvider = !!args.actor.providerId && order.provider_id === args.actor.providerId
  if (!isBuyer && !isProvider) return { ok: false, error: 'not_a_party' }
  if (!orderIsActive(String(order.status))) return { ok: false, error: 'subject_inactive' }
  const s = await getSupportSettings(admin)
  const left = await cooldownLeft(admin, 'order', orderId, args.userId, s.nudgeCooldownHours)
  if (left > 0) return { ok: false, error: 'nudge_cooldown', retryAfterSec: left, cooldownHours: s.nudgeCooldownHours }
  const toUserId: string = isBuyer ? order.provider.user_id : order.msme.user_id
  const supportMessageId = await ownSupportMessage(admin, args.supportMessageId, args.userId)
  const decisionId = supportMessageId ? await recordAiDecision(admin, args.userId, { feature: 'support_nudge', input_refs: { support_message_id: supportMessageId, order_id: orderId }, proposed: { subject_kind: 'order', subject_id: orderId }, final: { subject_kind: 'order', subject_id: orderId } }, { runId: null, tool: 'nudge_counterparty' }) : null
  const { data: ins, error } = await admin.from('nudges').insert({ subject_kind: 'order', subject_id: orderId, from_user_id: args.userId, to_user_id: toUserId, decision_id: decisionId }).select('id').single()
  if (error) throw new Error(`nudge insert: ${error.message}`)
  const body = COPY.order.body(String(order.order_number))
  await createNotification(admin, { userId: toUserId, kind: 'order_nudge', titleI18n: COPY.order.title, bodyI18n: body, link: isBuyer ? `/partner/orders/${orderId}` : `/app/orders/${orderId}`, channels: ['whatsapp'] })
  await addEvent(admin, orderId, 'nudged', args.userId, { by: isBuyer ? 'buyer' : 'provider', via: args.via })
  captureServerEvent(args.userId, 'nudge_sent', { subject_kind: 'order', via: args.via })
  return { ok: true, nudgeId: (ins as { id: string }).id, recipients: 1 }
}

export async function nudgeRfq(admin: SupabaseClient, rfqId: string, args: NudgeArgs): Promise<NudgeResult> {
  const { data: r } = await admin.from('rfqs').select('id, title, status, msme_id, msme:msme_profiles!inner(user_id)').eq('id', rfqId).maybeSingle()
  const rfq = r as any
  if (!rfq) return { ok: false, error: 'not_found' }
  const isBuyer = !!args.actor.msmeId && rfq.msme_id === args.actor.msmeId
  let isProvider = false
  if (!isBuyer && args.actor.providerId) {
    const { data: m } = await admin.from('rfq_matches').select('provider_id, declined_at').eq('rfq_id', rfqId).eq('provider_id', args.actor.providerId).maybeSingle()
    isProvider = !!m && !(m as any).declined_at
  }
  if (!isBuyer && !isProvider) return { ok: false, error: 'not_a_party' }
  if (!rfqIsActive(String(rfq.status))) return { ok: false, error: 'subject_inactive' }
  const s = await getSupportSettings(admin)
  const left = await cooldownLeft(admin, 'rfq', rfqId, args.userId, s.nudgeCooldownHours)
  if (left > 0) return { ok: false, error: 'nudge_cooldown', retryAfterSec: left, cooldownHours: s.nudgeCooldownHours }
  const supportMessageId = await ownSupportMessage(admin, args.supportMessageId, args.userId)
  const decisionId = supportMessageId ? await recordAiDecision(admin, args.userId, { feature: 'support_nudge', input_refs: { support_message_id: supportMessageId, rfq_id: rfqId }, proposed: { subject_kind: 'rfq', subject_id: rfqId }, final: { subject_kind: 'rfq', subject_id: rfqId } }, { runId: null, tool: 'nudge_counterparty' }) : null
  const title = String(rfq.title).slice(0, 80)
  if (isBuyer) {
    // every matched, non-declined provider (bulk); the ledger row records the fan-out, not each recipient
    const { data: matches } = await admin.from('rfq_matches').select('provider_id, declined_at, provider:provider_profiles!inner(user_id)').eq('rfq_id', rfqId).is('declined_at', null)
    const userIds = [...new Set(((matches as any[]) ?? []).map((m) => m.provider?.user_id).filter(Boolean))] as string[]
    if (!userIds.length) return { ok: false, error: 'no_recipient' }
    const { data: ins, error } = await admin.from('nudges').insert({ subject_kind: 'rfq', subject_id: rfqId, from_user_id: args.userId, to_user_id: null, decision_id: decisionId }).select('id').single()
    if (error) throw new Error(`nudge insert: ${error.message}`)
    await createNotificationsBulk(admin, userIds, { kind: 'rfq_nudge', titleI18n: COPY.rfq.title, bodyI18n: COPY.rfq.body(title), link: `/partner/rfqs/${rfqId}`, channels: ['whatsapp'] })
    captureServerEvent(args.userId, 'nudge_sent', { subject_kind: 'rfq', via: args.via, recipients: userIds.length })
    return { ok: true, nudgeId: (ins as { id: string }).id, recipients: userIds.length }
  }
  const toUserId: string = rfq.msme.user_id
  const { data: ins, error } = await admin.from('nudges').insert({ subject_kind: 'rfq', subject_id: rfqId, from_user_id: args.userId, to_user_id: toUserId, decision_id: decisionId }).select('id').single()
  if (error) throw new Error(`nudge insert: ${error.message}`)
  await createNotification(admin, { userId: toUserId, kind: 'rfq_nudge', titleI18n: COPY.rfq_buyer.title, bodyI18n: COPY.rfq_buyer.body(title), link: `/app/rfq/${rfqId}`, channels: ['whatsapp'] })
  captureServerEvent(args.userId, 'nudge_sent', { subject_kind: 'rfq', via: args.via, recipients: 1 })
  return { ok: true, nudgeId: (ins as { id: string }).id, recipients: 1 }
}
