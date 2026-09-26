import 'server-only'
import { WA_HOLD_ORDER_STATUSES } from '@amclub/shared'
import type { Admin } from './common'

/**
 * D-WA5 legal hold — whose WhatsApp messages the retention job must keep for now: a user with an open support ticket,
 * or with an order (as buyer or provider) whose work, refund or dispute is still open (shared WA_HOLD_ORDER_STATUSES).
 * An explicit `wa_messages.legal_hold` is checked on the row itself. Any read that fails holds everyone it covers:
 * retention never deletes on a guess.
 */
export async function heldUserIds(admin: Admin, userIds: readonly string[]): Promise<{ held: Set<string>; failed: boolean }> {
  const ids = [...new Set(userIds.filter(Boolean))]
  const held = new Set<string>()
  if (ids.length === 0) return { held, failed: false }
  let failed = false
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const [tickets, msmes, providers] = await Promise.all([
      admin.from('support_tickets').select('user_id').in('user_id', chunk).neq('status', 'resolved').is('deleted_at', null),
      admin.from('msme_profiles').select('id, user_id').in('user_id', chunk),
      admin.from('provider_profiles').select('id, user_id').in('user_id', chunk),
    ])
    if (tickets.error || msmes.error || providers.error) {
      // support_tickets may be missing on a database without 0041: that alone is not a reason to hold
      if (msmes.error || providers.error || !/support_tickets/.test(tickets.error?.message ?? '')) failed = true
    }
    for (const t of (tickets.data ?? []) as { user_id: string }[]) held.add(t.user_id)
    const msmeOwner = new Map(((msmes.data ?? []) as { id: string; user_id: string }[]).map((m) => [m.id, m.user_id]))
    const providerOwner = new Map(((providers.data ?? []) as { id: string; user_id: string }[]).map((p) => [p.id, p.user_id]))
    const statuses = [...WA_HOLD_ORDER_STATUSES]
    const [asBuyer, asProvider] = await Promise.all([
      msmeOwner.size ? admin.from('orders').select('msme_id').in('msme_id', [...msmeOwner.keys()]).in('status', statuses).limit(1000) : Promise.resolve({ data: [], error: null }),
      providerOwner.size ? admin.from('orders').select('provider_id').in('provider_id', [...providerOwner.keys()]).in('status', statuses).limit(1000) : Promise.resolve({ data: [], error: null }),
    ])
    if (asBuyer.error || asProvider.error) failed = true
    for (const o of (asBuyer.data ?? []) as { msme_id: string }[]) { const u = msmeOwner.get(o.msme_id); if (u) held.add(u) }
    for (const o of (asProvider.data ?? []) as { provider_id: string }[]) { const u = providerOwner.get(o.provider_id); if (u) held.add(u) }
  }
  if (failed) for (const id of ids) held.add(id)
  return { held, failed }
}
