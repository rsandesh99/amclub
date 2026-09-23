import 'server-only'
import { searchAttributionSchema, type SearchAttribution } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * E15 FR-15.3 (F5) — attribution rides the money path but is never part of it:
 * written after the checkout session exists, copied onto the order once (in
 * the placed side effects), and every failure — including the 0063 columns
 * not being there yet — is swallowed.
 */
export async function storeCheckoutAttribution(sessionId: string, attribution: SearchAttribution): Promise<void> {
  try {
    const a = searchAttributionSchema.parse(attribution)
    const admin = await createAdminClient()
    await admin.from('checkout_sessions').update({ attribution: a }).eq('id', sessionId).is('attribution', null)
  } catch {
    /* best-effort */
  }
}

export async function copyAttributionToOrder(admin: Admin, orderId: string): Promise<void> {
  try {
    const { data, error } = await admin.from('checkout_sessions').select('attribution').eq('order_id', orderId).not('attribution', 'is', null).limit(1).maybeSingle()
    if (error || !data?.attribution) return
    const a = searchAttributionSchema.safeParse(data.attribution)
    if (a.success) await admin.from('orders').update({ attribution: a.data }).eq('id', orderId).is('attribution', null)
  } catch {
    /* best-effort */
  }
}
