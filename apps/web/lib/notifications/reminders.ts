import 'server-only'
import { MART_ENABLED } from '@/lib/flags'
import { notifyText } from '@/lib/i18n/notify'
import { UNBOUNDED, type TimeBudget } from '@/lib/jobs/budget'
import { createNotification } from './create'
import { hoursUntil, istDateTime } from './format'
import { claimOnce, isMissingRelation, type Admin } from './store'

/**
 * ADR-030 §4 / DESIGN §5.9 — deadline reminders, from the hourly cron `notify-reminders`. Each stage is claimed in
 * notification_reminders (kind, entity, stage) BEFORE it is sent, so a reminder goes once however often the cron runs
 * or overlaps. Reads on the service role; bounded batches inside the time budget. Without migration 0087 nothing is
 * sent and the run reports `ready: false` (a degraded heartbeat).
 *
 *   accept-by    provider  order still `placed` 12 h and 22 h after it became actionable (the 24-h auto-cancel)
 *   review-by    buyer     order `delivered`, 24 h and 48 h after delivery (the 72-h auto-accept, from auto_accept_at)
 *   rfq-expiring buyer     open request with ≥ 1 submitted quote, 12 h before it expires
 *   pool pay-by  Mart member, 12 h before the pay deadline of a met pool (MART_ENABLED only)
 */

const H = 3_600_000
const BATCH = 500

export interface ReminderRunResult {
  ready: boolean
  acceptBy: number
  reviewBy: number
  rfqExpiring: number
  poolPayBy: number
  stepErrors: number
  deferred?: true
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function userIdsOf(admin: Admin, table: 'msme_profiles' | 'provider_profiles', ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { data } = await admin.from(table).select('id, user_id').in('id', [...new Set(ids)])
  return new Map(((data ?? []) as { id: string; user_id: string }[]).map((r) => [r.id, r.user_id]))
}

type Claim = 'claimed' | 'taken' | 'unavailable'

async function acceptBy(admin: Admin, now: Date, budget: TimeBudget, out: ReminderRunResult): Promise<Claim | null> {
  const since = new Date(now.getTime() - 30 * 24 * H).toISOString()
  // SELECT * — a bundle child's clock starts at available_at (0067), which a pre-0067 database does not have.
  const { data, error } = await admin.from('orders').select('*').eq('status', 'placed').gte('created_at', since).order('created_at', { ascending: true }).limit(BATCH)
  if (error) {
    out.stepErrors++
    console.error('[notify-reminders] accept-by', error.message)
    return null
  }
  const due = ((data ?? []) as any[])
    .map((o) => ({ o, age: (now.getTime() - new Date(o.available_at ?? o.created_at).getTime()) / H }))
    .filter(({ age }) => age >= 12 && age < 24)
  const providers = await userIdsOf(admin, 'provider_profiles', due.map(({ o }) => o.provider_id))
  for (const { o, age } of due) {
    if (budget.spent()) { out.deferred = true; break }
    const userId = providers.get(o.provider_id)
    if (!userId) continue
    const stage = age >= 22 ? '22h' : '12h'
    const claim = await claimOnce(admin, { kind: 'accept_by', entityId: o.id, stage, userId })
    if (claim === 'unavailable') return claim
    if (claim === 'taken') continue
    const ref = String(o.order_number ?? '')
    const hours = Math.max(1, Math.floor(24 - age))
    await createNotification(admin, {
      userId,
      kind: 'order_accept_reminder',
      titleI18n: notifyText('order_accept_reminder.title', { ref }),
      bodyI18n: notifyText('order_accept_reminder.body', { ref, hours }),
      link: `/partner/orders/${o.id}`,
      values: { ref, hours },
    })
    out.acceptBy++
  }
  return 'claimed'
}

async function reviewBy(admin: Admin, now: Date, budget: TimeBudget, out: ReminderRunResult): Promise<Claim | null> {
  // At least 24 h since delivery = the auto-accept is at most 48 h away.
  const { data, error } = await admin
    .from('orders')
    .select('*')
    .eq('status', 'delivered')
    .gt('auto_accept_at', now.toISOString())
    .lte('auto_accept_at', new Date(now.getTime() + 48 * H).toISOString())
    .order('auto_accept_at', { ascending: true })
    .limit(BATCH)
  if (error) {
    out.stepErrors++
    console.error('[notify-reminders] review-by', error.message)
    return null
  }
  const rows = (data ?? []) as any[]
  const buyers = await userIdsOf(admin, 'msme_profiles', rows.map((o) => o.msme_id))
  for (const o of rows) {
    if (budget.spent()) { out.deferred = true; break }
    const userId = buyers.get(o.msme_id)
    if (!userId) continue
    const left = (new Date(o.auto_accept_at).getTime() - now.getTime()) / H
    const stage = left <= 24 ? '48h' : '24h'
    const claim = await claimOnce(admin, { kind: 'review_by', entityId: o.id, stage, userId })
    if (claim === 'unavailable') return claim
    if (claim === 'taken') continue
    const ref = String(o.order_number ?? '')
    const deadline = istDateTime(o.auto_accept_at)
    const key = o.kind === 'goods' ? 'goods_review_reminder' : 'order_review_reminder'
    await createNotification(admin, {
      userId,
      kind: 'order_review_reminder',
      titleI18n: notifyText(`${key}.title`, { ref }),
      bodyI18n: notifyText(`${key}.body`, { ref, deadline }),
      link: `/app/orders/${o.id}`,
      values: { ref, deadline },
    })
    out.reviewBy++
  }
  return 'claimed'
}

async function rfqExpiring(admin: Admin, now: Date, budget: TimeBudget, out: ReminderRunResult): Promise<Claim | null> {
  const { data, error } = await admin
    .from('rfqs')
    .select('id, title, msme_id, expires_at, quote_count')
    .in('status', ['open', 'quoted'])
    .gte('quote_count', 1)
    .gt('expires_at', now.toISOString())
    .lte('expires_at', new Date(now.getTime() + 12 * H).toISOString())
    .order('expires_at', { ascending: true })
    .limit(BATCH)
  if (error) {
    out.stepErrors++
    console.error('[notify-reminders] rfq-expiring', error.message)
    return null
  }
  const rows = (data ?? []) as { id: string; title: string | null; msme_id: string; expires_at: string }[]
  if (rows.length === 0) return 'claimed'
  // Only quotes the buyer can still accept count ("quotes waiting").
  const { data: quotes } = await admin.from('quotes').select('rfq_id').in('rfq_id', rows.map((r) => r.id)).eq('status', 'submitted')
  const waiting = new Map<string, number>()
  for (const q of (quotes ?? []) as { rfq_id: string }[]) waiting.set(q.rfq_id, (waiting.get(q.rfq_id) ?? 0) + 1)
  const buyers = await userIdsOf(admin, 'msme_profiles', rows.map((r) => r.msme_id))
  for (const r of rows) {
    if (budget.spent()) { out.deferred = true; break }
    const count = waiting.get(r.id) ?? 0
    const userId = buyers.get(r.msme_id)
    if (!userId || count === 0) continue
    const claim = await claimOnce(admin, { kind: 'rfq_expiring', entityId: r.id, stage: '12h', userId })
    if (claim === 'unavailable') return claim
    if (claim === 'taken') continue
    const title = r.title ?? notifyText('your_request')
    const hours = hoursUntil(r.expires_at, now)
    await createNotification(admin, {
      userId,
      kind: 'rfq_expiring_reminder',
      titleI18n: notifyText('rfq_expiring_reminder.title'),
      bodyI18n: notifyText('rfq_expiring_reminder.body', { title, count, hours }),
      link: `/app/rfq/${r.id}`,
      values: { title, count, hours },
    })
    out.rfqExpiring++
  }
  return 'claimed'
}

async function poolPayBy(admin: Admin, now: Date, budget: TimeBudget, out: ReminderRunResult): Promise<Claim | null> {
  if (!MART_ENABLED) return 'claimed'
  const { data, error } = await admin
    .from('pool_members')
    .select('id, user_id, pool_id, pay_by, pool:pools!inner(id, title, status)')
    .eq('payment_state', 'blocked')
    .gt('pay_by', now.toISOString())
    .lte('pay_by', new Date(now.getTime() + 12 * H).toISOString())
    .eq('pool.status', 'closed_met')
    .limit(BATCH)
  if (error) {
    // A database without the staged Mart tables has no pools to remind about.
    if (!isMissingRelation(error)) {
      out.stepErrors++
      console.error('[notify-reminders] pool pay-by', error.message)
    }
    return null
  }
  for (const m of (data ?? []) as any[]) {
    if (budget.spent()) { out.deferred = true; break }
    const pool = Array.isArray(m.pool) ? m.pool[0] : m.pool
    if (!m.user_id || !pool) continue
    const claim = await claimOnce(admin, { kind: 'pool_pay_by', entityId: m.id, stage: '12h', userId: m.user_id })
    if (claim === 'unavailable') return claim
    if (claim === 'taken') continue
    const title = String(pool.title ?? '')
    const deadline = istDateTime(m.pay_by)
    await createNotification(admin, {
      userId: m.user_id,
      kind: 'pool_pay_reminder',
      titleI18n: notifyText('pool_pay_reminder.title'),
      bodyI18n: notifyText('pool_pay_reminder.body', { title, deadline }),
      link: `/app/mart/pools/${m.pool_id}/pay`,
      values: { title, deadline },
    })
    out.poolPayBy++
  }
  return 'claimed'
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function runReminders(admin: Admin, budget: TimeBudget = UNBOUNDED, now = new Date()): Promise<ReminderRunResult> {
  const out: ReminderRunResult = { ready: true, acceptBy: 0, reviewBy: 0, rfqExpiring: 0, poolPayBy: 0, stepErrors: 0 }
  // 0087 applied? One cheap probe before any reminder is considered.
  const probe = await admin.from('notification_reminders').select('kind').limit(1)
  if (probe.error) {
    if (isMissingRelation(probe.error)) return { ...out, ready: false }
    throw new Error(`notification_reminders: ${probe.error.message}`)
  }
  for (const step of [acceptBy, reviewBy, rfqExpiring, poolPayBy]) {
    if (budget.spent()) { out.deferred = true; break }
    try {
      if ((await step(admin, now, budget, out)) === 'unavailable') return { ...out, ready: false }
    } catch (e) {
      out.stepErrors++
      console.error('[notify-reminders]', step.name, (e as Error).message)
    }
  }
  return out
}
